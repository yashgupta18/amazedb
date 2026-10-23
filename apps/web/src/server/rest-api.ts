import type { Client } from "pg";
import { z } from "zod";
import { ApiError } from "./control-plane";
import { getPool } from "./db";
import { ProjectDatabase, columnsFor, quoteName } from "./project-database";
import type { Column } from "../lib/database-types";

const tableName = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const reserved = new Set(["select", "order", "limit", "offset"]);

export type ApiResult = {
  rows: Record<string, unknown>[];
  offset?: number;
  limit?: number;
  truncated?: boolean;
};

function isFilter(target: string, value: string, column: Column, name: string) {
  const normalized = value.toLowerCase();
  if (!new Set(["null", "true", "false"]).has(normalized))
    throw new ApiError(400, "Use is.null, is.true, or is.false.");
  if (normalized !== "null" && column.type !== "boolean")
    throw new ApiError(400, `Filter ${name} only supports is.null.`);
  const literal = normalized === "null" ? "NULL" : normalized.toUpperCase();
  return `${target} IS ${literal}`;
}

function inFilter(target: string, value: string, values: unknown[]) {
  if (!value.startsWith("(") || !value.endsWith(")"))
    throw new ApiError(400, "Use in.(value1,value2) for membership filters.");
  const content = value.slice(1, -1);
  const items = content ? content.split(",") : [];
  if (!items.length || items.length > 100)
    throw new ApiError(400, "in. filters require 1 to 100 values.");
  const placeholders = items.map((item) => {
    values.push(item);
    return `$${values.length}`;
  });
  return `${target} IN (${placeholders.join(", ")})`;
}

function comparisonFilter(
  name: string,
  target: string,
  operator: string,
  value: string,
  column: Column,
  values: unknown[],
) {
  const operators: Record<string, string> = {
    eq: "=",
    neq: "<>",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
    like: "LIKE",
    ilike: "ILIKE",
  };
  const sqlOperator = operators[operator];
  if (!sqlOperator)
    throw new ApiError(400, `Unsupported filter operator: ${operator}.`);
  if (
    (operator === "like" || operator === "ilike") &&
    !["text", "character varying", "character"].some((type) =>
      column.type.startsWith(type),
    )
  )
    throw new ApiError(
      400,
      `Filter ${name} does not support pattern matching.`,
    );
  values.push(value);
  return `${target} ${sqlOperator} $${values.length}`;
}

function readFilter(
  name: string,
  raw: string,
  columns: Column[],
  values: unknown[],
  qualifier = "",
) {
  const column = columns.find((item) => item.name === name);
  if (!column) throw new ApiError(400, `Unknown filter column: ${name}.`);
  const separator = raw.indexOf(".");
  if (separator < 1)
    throw new ApiError(400, `Filter ${name} must use operator.value syntax.`);
  const operator = raw.slice(0, separator).toLowerCase();
  const value = raw.slice(separator + 1);
  const target = `${qualifier}${quoteName(name)}`;
  if (operator === "is") return isFilter(target, value, column, name);
  if (
    (operator === "eq" || operator === "neq") &&
    value.toLowerCase() === "null"
  )
    return `${target} IS ${operator === "neq" ? "NOT " : ""}NULL`;
  if (operator === "in") return inFilter(target, value, values);
  return comparisonFilter(name, target, operator, value, column, values);
}

function filtersFor(query: URLSearchParams, columns: Column[], qualifier = "") {
  const values: unknown[] = [];
  const conditions: string[] = [];
  for (const [name, raw] of query.entries()) {
    if (reserved.has(name)) continue;
    conditions.push(readFilter(name, raw, columns, values, qualifier));
  }
  return {
    values,
    sql: conditions.length ? conditions.join(" AND ") : "TRUE",
    count: conditions.length,
  };
}

function selection(query: URLSearchParams, columns: Column[]) {
  const requested = query.get("select") ?? "*";
  if (requested === "*")
    return columns.map((column) => quoteName(column.name)).join(", ");
  const names = requested.split(",");
  if (
    !names.length ||
    names.length > columns.length ||
    new Set(names).size !== names.length
  )
    throw new ApiError(400, "Invalid select column list.");
  return names
    .map((name) => {
      if (!columns.some((column) => column.name === name))
        throw new ApiError(400, `Unknown select column: ${name}.`);
      return quoteName(name);
    })
    .join(", ");
}

function ordering(query: URLSearchParams, columns: Column[]) {
  const order = query.get("order");
  if (!order) return "";
  const parts = order.split(",");
  if (parts.length > 8)
    throw new ApiError(400, "Order by at most eight columns.");
  return parts
    .map((part) => {
      const [name, direction = "asc", nulls] = part.split(".");
      if (!columns.some((column) => column.name === name))
        throw new ApiError(400, `Unknown order column: ${name}.`);
      if (
        !/^(asc|desc)$/i.test(direction) ||
        (nulls && !/^(nullsfirst|nullslast)$/i.test(nulls))
      )
        throw new ApiError(400, "Use column.asc or column.desc for ordering.");
      const nullOrder = nulls ? ` NULLS ${nulls.slice(5).toUpperCase()}` : "";
      return [quoteName(name), direction.toUpperCase(), nullOrder]
        .join(" ")
        .trim();
    })
    .join(", ");
}

function pageValues(query: URLSearchParams) {
  const limitText = query.get("limit") ?? "100";
  const offsetText = query.get("offset") ?? "0";
  if (!/^\d+$/.test(limitText) || !/^\d+$/.test(offsetText))
    throw new ApiError(400, "limit and offset must be non-negative integers.");
  const limit = Number(limitText);
  const offset = Number(offsetText);
  if (limit < 1 || limit > 1000 || offset > 1_000_000)
    throw new ApiError(400, "limit must be 1-1000 and offset at most 1000000.");
  return { limit, offset };
}

async function bodyJson(request: Request) {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new ApiError(415, "Send a JSON request body.");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "A JSON request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65_536) {
        void reader.cancel();
        throw new ApiError(413, "Request body exceeds 64 KB.");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ApiError(400, "Invalid JSON request body.");
  }
}

function apiKey(request: Request) {
  const explicit = request.headers.get("apikey");
  const authorization = request.headers.get("authorization");
  const bearer = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(authorization ?? "")?.[1];
  if (explicit) return explicit;
  return bearer;
}

function projectAccessToken(request: Request) {
  if (!request.headers.get("apikey")) return undefined;
  const authorization = request.headers.get("authorization");
  if (!authorization) return undefined;
  const bearer = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(authorization)?.[1];
  if (!bearer) throw new ApiError(401, "Use a Bearer access token.");
  return bearer === request.headers.get("apikey") ? undefined : bearer;
}

function writeEntries(columns: Column[], body: unknown) {
  const rows = z
    .union([
      z.record(z.string(), z.unknown()),
      z.array(z.record(z.string(), z.unknown())).min(1).max(100),
    ])
    .parse(body);
  const records = Array.isArray(rows) ? rows : [rows];
  const names = Object.keys(records[0]);
  if (!names.length || names.length > columns.length)
    throw new ApiError(400, "Provide at least one writable column.");
  if (
    records.some(
      (row) =>
        Object.keys(row).length !== names.length ||
        names.some((name) => !Object.hasOwn(row, name)),
    )
  )
    throw new ApiError(400, "All inserted rows must use the same columns.");
  const entries = names.map((name) => {
    const column = columns.find((item) => item.name === name);
    if (!column || column.generated)
      throw new ApiError(400, `Column ${name} cannot be written.`);
    return {
      name: quoteName(name),
      column,
      values: records.map((row) =>
        row[name] !== null && ["json", "jsonb"].includes(column.type)
          ? JSON.stringify(row[name])
          : row[name],
      ),
    };
  });
  return { records, entries };
}

function mappedRows(rows: Record<string, unknown>[]) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value instanceof Date ? value.toISOString() : value,
      ]),
    ),
  );
}

function boundedResult(result: ApiResult): ApiResult {
  if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024)
    throw new ApiError(
      413,
      "REST response exceeds 2 MB. Select fewer or smaller columns.",
    );
  return result;
}

async function withAuthorizedTable<Result>(
  database: ProjectDatabase,
  request: Request,
  projectId: string,
  table: string,
  work: (
    client: Client,
    schema: string,
    serviceRole: boolean,
    columns: Column[],
  ) => Promise<Result>,
) {
  tableName.parse(table);
  return database.withApiKey(
    projectId,
    apiKey(request),
    async (client, schema, serviceRole) => {
      const columns = await columnsFor(client, schema, table);
      return work(client, schema, serviceRole, columns);
    },
    projectAccessToken(request),
  );
}

async function matchedRowIds(
  client: Client,
  target: string,
  filter: { sql: string; values: unknown[] },
) {
  const result = await client.query<{ tid: string; bytes: number }>(
    `SELECT target.ctid::text AS tid, pg_column_size(target)::int AS bytes
     FROM ${target} AS target WHERE ${filter.sql}
     ORDER BY target.ctid LIMIT 101 FOR UPDATE`,
    filter.values,
  );
  if (result.rows.length > 100)
    throw new ApiError(
      413,
      "The filter matched more than 100 rows. Add a more specific filter.",
    );
  if (result.rows.reduce((total, row) => total + row.bytes, 0) > 1024 * 1024)
    throw new ApiError(413, "Matched rows exceed the 1 MB mutation limit.");
  return result.rows.map((row) => row.tid);
}

export async function restRequest(
  request: Request,
  projectId: string,
  table: string,
) {
  const database = new ProjectDatabase(getPool());
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  const query = url.searchParams;
  if (method === "GET") {
    return withAuthorizedTable(
      database,
      request,
      projectId,
      table,
      async (client, schema, _service, columns) => {
        const selected = selection(query, columns);
        const filter = filtersFor(query, columns);
        const order = ordering(query, columns);
        const { limit, offset } = pageValues(query);
        const primary = columns
          .filter((column) => column.primary_key)
          .map((column) => quoteName(column.name));
        const orderSql = order || primary.join(", ") || "tableoid, ctid";
        const target = `${quoteName(schema)}.${quoteName(table)}`;
        const values = [...filter.values, limit + 1, offset];
        const pageSql = `SELECT ${selected} FROM ${target} WHERE ${filter.sql} ORDER BY ${orderSql} LIMIT $${filter.values.length + 1} OFFSET $${filter.values.length + 2}`;
        const size = await client.query<{ bytes: string }>(
          `SELECT COALESCE(sum(pg_column_size(page)), 0)::bigint AS bytes FROM (${pageSql}) AS page`,
          values,
        );
        if (Number(size.rows[0].bytes) > 2 * 1024 * 1024)
          throw new ApiError(
            413,
            "REST page exceeds 2 MB. Select fewer rows or smaller columns.",
          );
        const result = await client.query(pageSql, values);
        const rows = mappedRows(result.rows.slice(0, limit));
        return boundedResult({
          rows,
          offset,
          limit,
          truncated: result.rows.length > limit,
        });
      },
    );
  }
  if (method === "POST") {
    const body = await bodyJson(request);
    return withAuthorizedTable(
      database,
      request,
      projectId,
      table,
      async (client, schema, serviceRole, columns) => {
        const { records, entries } = writeEntries(columns, body);
        const values: unknown[] = [];
        const tuples = records.map((_, rowIndex) => {
          const placeholders = entries.map((entry) => {
            values.push(entry.values[rowIndex]);
            return `$${values.length}`;
          });
          return `(${placeholders.join(", ")})`;
        });
        const result = await client.query(
          `INSERT INTO ${quoteName(schema)}.${quoteName(table)} (${entries.map((entry) => entry.name).join(", ")}) VALUES ${tuples.join(", ")} RETURNING *`,
          values,
        );
        return boundedResult({ rows: mappedRows(result.rows) });
      },
    );
  }
  if (method === "PATCH" || method === "DELETE") {
    const body = method === "PATCH" ? await bodyJson(request) : null;
    return withAuthorizedTable(
      database,
      request,
      projectId,
      table,
      async (client, schema, serviceRole, columns) => {
        const filter = filtersFor(query, columns, "target.");
        if (!filter.count)
          throw new ApiError(400, `${method} requires at least one filter.`);
        if (query.has("offset") || query.has("order"))
          throw new ApiError(
            400,
            `${method} does not support offset or order.`,
          );
        const target = `${quoteName(schema)}.${quoteName(table)}`;
        const rowIds = await matchedRowIds(client, target, filter);
        if (!rowIds.length) return { rows: [] } satisfies ApiResult;
        if (method === "DELETE") {
          const values = [rowIds];
          const result = await client.query(
            `DELETE FROM ${target} AS target WHERE target.ctid = ANY($${values.length}::tid[]) RETURNING target.*`,
            values,
          );
          return boundedResult({ rows: mappedRows(result.rows) });
        }
        const parsed = z.record(z.string(), z.unknown()).parse(body);
        const entries = writeEntries(columns, parsed).entries;
        if (entries.some((entry) => entry.values.length !== 1))
          throw new ApiError(400, "PATCH accepts one object, not an array.");
        const values: unknown[] = [];
        const assignments = entries.map((entry) => {
          values.push(entry.values[0]);
          return `${entry.name} = $${values.length}`;
        });
        if (!assignments.length)
          throw new ApiError(400, "Provide at least one column to update.");
        values.push(rowIds);
        const result = await client.query(
          `UPDATE ${target} AS target SET ${assignments.join(", ")} WHERE target.ctid = ANY($${values.length}::tid[]) RETURNING target.*`,
          values,
        );
        return boundedResult({ rows: mappedRows(result.rows) });
      },
    );
  }
  throw new ApiError(405, "Method not supported.");
}
