import { createHash, createHmac } from "node:crypto";
import { Client, type Pool, type PoolClient } from "pg";
import Cursor from "pg-cursor";
import { parse } from "pgsql-parser";
import { z } from "zod";
import { ApiError } from "./control-plane";
import {
  columnTypes,
  type Column,
  type TableInfo,
  type SqlResult,
} from "../lib/database-types";

type ProjectAccess = {
  schema_name: string;
  anon_key_hash: string;
  service_key_hash: string;
};

const newName = z
  .string()
  .regex(
    /^[a-z_][a-z0-9_]{0,62}$/,
    "Use lowercase letters, numbers, and underscores; start with a letter or underscore.",
  );
const columnInput = z.object({
  name: newName,
  type: z.enum(columnTypes),
  nullable: z.boolean().default(true),
});
const valuesInput = z.record(z.string(), z.unknown());
const rowInput = z.object({ values: valuesInput, key: valuesInput.optional() });

export function quoteName(value: string) {
  z.string().min(1).max(63).parse(value);
  return `"${value.replaceAll('"', '""')}"`;
}

export async function columnsFor(
  client: Client,
  schema: string,
  table: string,
) {
  const result = await client.query<Column>(
    `SELECT attribute.attname AS name, pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS type,
      NOT attribute.attnotnull AS nullable,
      EXISTS (SELECT 1 FROM pg_catalog.pg_index idx WHERE idx.indrelid = relation.oid AND idx.indisprimary AND attribute.attnum = ANY(idx.indkey)) AS primary_key,
      (attribute.attidentity <> '' OR attribute.attgenerated <> '') AS generated, attribute.atthasdef AS has_default
     FROM pg_catalog.pg_attribute attribute JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
     JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = $1 AND relation.relname = $2 AND relation.relkind IN ('r', 'p')
       AND attribute.attnum > 0 AND NOT attribute.attisdropped ORDER BY attribute.attnum`,
    [schema, table],
  );
  if (!result.rows.length)
    throw new ApiError(404, "Table not found or has no columns.");
  return result.rows;
}

function checkedValues(
  columns: Column[],
  values: Record<string, unknown>,
  updating: boolean,
) {
  return Object.entries(values).map(([name, value]) => {
    const column = columns.find((entry) => entry.name === name);
    if (!column || column.generated || (updating && column.primary_key))
      throw new ApiError(400, `Column ${name} is not writable.`);
    return {
      name: quoteName(name),
      value:
        value !== null && ["json", "jsonb"].includes(column.type)
          ? JSON.stringify(value)
          : value,
    };
  });
}

function keyPredicate(
  columns: Column[],
  key: Record<string, unknown> | undefined,
  offset = 0,
) {
  const primary = columns.filter((column) => column.primary_key);
  if (!primary.length)
    throw new ApiError(
      400,
      "A primary key is required to edit or delete rows.",
    );
  if (
    !key ||
    Object.keys(key).length !== primary.length ||
    primary.some(
      (column) => key[column.name] === undefined || key[column.name] === null,
    )
  ) {
    throw new ApiError(400, "Provide the complete primary key.");
  }
  return {
    sql: primary
      .map(
        (column, index) => `${quoteName(column.name)} = $${offset + index + 1}`,
      )
      .join(" AND "),
    values: primary.map((column) => key[column.name]),
  };
}

function rejectConfigurationCalls(node: unknown): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach(rejectConfigurationCalls);
    return;
  }
  const record = node as Record<string, unknown>;
  if (record.FuncCall) {
    const call = record.FuncCall as {
      funcname?: { String?: { sval?: string } }[];
    };
    if (call.funcname?.at(-1)?.String?.sval?.toLowerCase() === "set_config")
      throw new ApiError(
        400,
        "Configuration changes are not allowed in the SQL editor.",
      );
  }
  Object.values(record).forEach(rejectConfigurationCalls);
}

function roleIdentifier(value: string) {
  if (!/^[pdnas]_[a-f0-9]{32}$/.test(value))
    throw new Error("Invalid project role.");
  return `"${value}"`;
}

async function createRole(client: PoolClient, name: string, password?: string) {
  const login = password === undefined ? "NOLOGIN" : "LOGIN";
  const statement = await client.query<{ sql: string }>(
    "SELECT format('CREATE ROLE %I %s NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS%s', $1::text, $2::text, CASE WHEN $3::text IS NULL THEN '' ELSE format(' PASSWORD %L', $3::text) END) AS sql",
    [name, login, password ?? null],
  );
  await client.query(statement.rows[0].sql);
}

export class ProjectDatabase {
  constructor(private readonly pool: Pool) {}

  async withApiKey<Result>(
    projectId: string,
    apiKey: string | undefined,
    work: (
      client: Client,
      schema: string,
      serviceRole: boolean,
    ) => Promise<Result>,
  ) {
    if (
      !apiKey ||
      apiKey.length > 160 ||
      !/^amz_(anon|service)_[A-Za-z0-9_-]{40,60}$/.test(apiKey)
    )
      throw new ApiError(401, "A valid project API key is required.");
    z.uuid().parse(projectId);
    const keyHash = createHash("sha256").update(apiKey).digest("hex");
    const admin = await this.pool.connect();
    let access: {
      schema: string;
      login: string;
      password: string;
      role: string;
      serviceRole: boolean;
    };
    try {
      await admin.query("BEGIN");
      await admin.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [projectId],
      );
      const result = await admin.query<
        ProjectAccess & { role: "anon" | "service" }
      >(
        `SELECT schema_name, anon_key_hash, service_key_hash,
          CASE WHEN anon_key_hash = $2 THEN 'anon' ELSE 'service' END AS role
         FROM control_plane.projects
         WHERE id = $1 AND (anon_key_hash = $2 OR service_key_hash = $2)
         FOR SHARE`,
        [projectId, keyHash],
      );
      const project = result.rows[0];
      if (!project)
        throw new ApiError(401, "A valid project API key is required.");

      const suffix = project.schema_name.slice(2);
      const anonRole = `n_${suffix}`;
      const serviceRole = project.role === "service";
      const login = `${serviceRole ? "s" : "a"}_${suffix}`;
      const role = serviceRole ? project.schema_name : anonRole;
      const credentialHash = serviceRole
        ? project.service_key_hash
        : project.anon_key_hash;
      const password = createHmac("sha256", credentialHash)
        .update(`api-login:${project.role}:${projectId}`)
        .digest("hex");
      const roleExists = async (name: string) =>
        (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]))
          .rowCount !== 0;

      if (!serviceRole && !(await roleExists(anonRole))) {
        await createRole(admin, anonRole);
        await admin.query(
          `GRANT USAGE ON SCHEMA ${roleIdentifier(project.schema_name)} TO ${roleIdentifier(anonRole)}`,
        );
        await admin.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${roleIdentifier(project.schema_name)} TO ${roleIdentifier(anonRole)}`,
        );
        await admin.query(
          `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${roleIdentifier(project.schema_name)} TO ${roleIdentifier(anonRole)}`,
        );
        const defaults = await admin.query<{ sql: string }>(
          "SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', $1::text, $2::text, $3::text) AS sql",
          [project.schema_name, project.schema_name, anonRole],
        );
        await admin.query(defaults.rows[0].sql);
        const sequenceDefaults = await admin.query<{ sql: string }>(
          "SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I', $1::text, $2::text, $3::text) AS sql",
          [project.schema_name, project.schema_name, anonRole],
        );
        await admin.query(sequenceDefaults.rows[0].sql);
      }
      if (!(await roleExists(login))) {
        await createRole(admin, login, password);
        await admin.query(
          `GRANT ${roleIdentifier(role)} TO ${roleIdentifier(login)}`,
        );
      }
      await admin.query(
        `GRANT ${roleIdentifier(role)} TO ${roleIdentifier(login)}`,
      );
      await admin.query("COMMIT");
      access = {
        schema: project.schema_name,
        login,
        password,
        role,
        serviceRole,
      };
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    } finally {
      admin.release();
    }

    const connection = new URL(this.pool.options.connectionString ?? "");
    connection.username = access.login;
    connection.password = access.password;
    const client = new Client({
      connectionString: connection.toString(),
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      lock_timeout: 1_000,
      query_timeout: 6_000,
      application_name: access.serviceRole
        ? "amazedb-rest-service"
        : "amazedb-rest-anon",
    });
    try {
      await client.connect();
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${roleIdentifier(access.role)}`);
      await client.query(
        `SET LOCAL search_path TO ${roleIdentifier(access.schema)}, pg_catalog`,
      );
      const result = await work(client, access.schema, access.serviceRole);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  async listTables(ownerId: string, projectId: string) {
    return this.withProject(
      ownerId,
      projectId,
      async (client, schema) =>
        (
          await client.query<TableInfo>(
            `SELECT relation.relname AS name,
         (SELECT count(*)::int FROM pg_catalog.pg_attribute attribute WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped) AS column_count,
         EXISTS (SELECT 1 FROM pg_catalog.pg_index idx WHERE idx.indrelid = relation.oid AND idx.indisprimary) AS has_primary_key
       FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = $1 AND relation.relkind IN ('r', 'p') ORDER BY relation.relname`,
            [schema],
          )
        ).rows,
    );
  }

  async createTable(ownerId: string, projectId: string, input: unknown) {
    const { name, columns } = z
      .object({
        name: newName,
        columns: z.array(columnInput).max(30).default([]),
      })
      .parse(input);
    const names = ["id", ...columns.map((column) => column.name)];
    if (new Set(names).size !== names.length)
      throw new ApiError(
        400,
        "Column names must be unique; id is added automatically.",
      );
    return this.withProject(ownerId, projectId, async (client, schema) => {
      const definitions = columns.map(
        (column) =>
          `${quoteName(column.name)} ${column.type} ${column.nullable ? "" : "NOT NULL"}`,
      );
      await client.query(
        `CREATE TABLE ${quoteName(schema)}.${quoteName(name)} (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY${definitions.length ? ", " + definitions.join(", ") : ""})`,
      );
      return { name };
    });
  }

  async addColumn(
    ownerId: string,
    projectId: string,
    table: string,
    input: unknown,
  ) {
    const column = columnInput.parse(input);
    return this.withProject(ownerId, projectId, async (client, schema) => {
      await columnsFor(client, schema, table);
      await client.query(
        `ALTER TABLE ${quoteName(schema)}.${quoteName(table)} ADD COLUMN ${quoteName(column.name)} ${column.type} ${column.nullable ? "" : "NOT NULL"}`,
      );
      return { name: column.name };
    });
  }

  async readRows(
    ownerId: string,
    projectId: string,
    table: string,
    inputPage: unknown = 0,
  ) {
    const page = z.coerce.number().int().min(0).max(2000).parse(inputPage);
    return this.withProject(ownerId, projectId, async (client, schema) => {
      const columns = await columnsFor(client, schema, table);
      const primary = columns.filter((column) => column.primary_key);
      const order = primary.length
        ? primary.map((column) => quoteName(column.name)).join(", ")
        : "tableoid, ctid";
      const result = await client.query(
        `SELECT * FROM ${quoteName(schema)}.${quoteName(table)} ORDER BY ${order} LIMIT 51 OFFSET $1`,
        [page * 50],
      );
      return {
        columns,
        rows: result.rows.slice(0, 50) as Record<string, unknown>[],
        page,
        hasMore: result.rows.length > 50,
      };
    });
  }

  async insertRow(
    ownerId: string,
    projectId: string,
    table: string,
    input: unknown,
  ) {
    const { values } = rowInput.parse(input);
    return this.withProject(ownerId, projectId, async (client, schema) => {
      const entries = checkedValues(
        await columnsFor(client, schema, table),
        values,
        false,
      );
      const target = `${quoteName(schema)}.${quoteName(table)}`;
      const names = entries.map((entry) => entry.name).join(", ");
      const placeholders = entries
        .map((_, index) => `$${index + 1}`)
        .join(", ");
      const sql = entries.length
        ? `INSERT INTO ${target} (${names}) VALUES (${placeholders}) RETURNING *`
        : `INSERT INTO ${target} DEFAULT VALUES RETURNING *`;
      return (
        await client.query(
          sql,
          entries.map((entry) => entry.value),
        )
      ).rows[0] as Record<string, unknown>;
    });
  }

  async updateRow(
    ownerId: string,
    projectId: string,
    table: string,
    input: unknown,
  ) {
    const { values, key } = rowInput.parse(input);
    return this.withProject(ownerId, projectId, async (client, schema) => {
      const columns = await columnsFor(client, schema, table);
      const entries = checkedValues(columns, values, true);
      if (!entries.length)
        throw new ApiError(400, "Provide at least one changed column.");
      const where = keyPredicate(columns, key, entries.length);
      const assignments = entries
        .map((entry, index) => `${entry.name} = $${index + 1}`)
        .join(", ");
      const result = await client.query(
        `UPDATE ${quoteName(schema)}.${quoteName(table)} SET ${assignments} WHERE ${where.sql} RETURNING *`,
        [...entries.map((entry) => entry.value), ...where.values],
      );
      if (!result.rows[0])
        throw new ApiError(404, "Row no longer exists. Refresh the table.");
      return result.rows[0] as Record<string, unknown>;
    });
  }

  async deleteRow(
    ownerId: string,
    projectId: string,
    table: string,
    input: unknown,
  ) {
    const { key } = z.object({ key: valuesInput }).parse(input);
    return this.withProject(ownerId, projectId, async (client, schema) => {
      const where = keyPredicate(await columnsFor(client, schema, table), key);
      const result = await client.query(
        `DELETE FROM ${quoteName(schema)}.${quoteName(table)} WHERE ${where.sql} RETURNING 1`,
        where.values,
      );
      if (!result.rowCount)
        throw new ApiError(404, "Row no longer exists. Refresh the table.");
      return { deleted: true };
    });
  }

  async executeSql(
    ownerId: string,
    projectId: string,
    input: unknown,
  ): Promise<SqlResult> {
    const { sql } = z
      .object({ sql: z.string().trim().min(1).max(20_000) })
      .parse(input);
    let parsed: Awaited<ReturnType<typeof parse>>;
    try {
      parsed = await parse(sql);
    } catch {
      throw new ApiError(
        400,
        "SQL could not be parsed. Check the statement syntax.",
      );
    }
    const statement = parsed.stmts?.[0]?.stmt;
    if (!statement || parsed.stmts?.length !== 1)
      throw new ApiError(400, "Run exactly one SQL statement at a time.");
    const kind = Object.keys(statement)[0];
    if (
      ![
        "SelectStmt",
        "InsertStmt",
        "UpdateStmt",
        "DeleteStmt",
        "CreateStmt",
        "AlterTableStmt",
        "IndexStmt",
        "DropStmt",
      ].includes(kind)
    ) {
      throw new ApiError(
        400,
        "Only queries, row changes, and table/index changes are supported.",
      );
    }
    if (
      "DropStmt" in statement &&
      statement.DropStmt &&
      !["OBJECT_TABLE", "OBJECT_INDEX"].includes(
        String(statement.DropStmt.removeType),
      )
    )
      throw new ApiError(400, "Only tables and indexes can be dropped.");
    rejectConfigurationCalls(statement);
    return this.withProject(ownerId, projectId, async (client) => {
      const cursor = client.query(
        new Cursor<unknown[]>(sql, [], { rowMode: "array" }),
      );
      try {
        return await new Promise<SqlResult>((resolve, reject) => {
          cursor.read(201, (error, rows, result) => {
            if (error) {
              reject(error);
              return;
            }
            const response: SqlResult = {
              columns: result.fields.map((field) => field.name),
              rows: rows.slice(0, 200),
              command:
                result.command || kind.replace(/Stmt$/, "").toUpperCase(),
              rowCount: result.rowCount,
              truncated: rows.length > 200,
            };
            if (Buffer.byteLength(JSON.stringify(response)) > 2 * 1024 * 1024) {
              reject(
                new ApiError(
                  413,
                  "Query result exceeds 2 MB. Select fewer or smaller columns.",
                ),
              );
              return;
            }
            resolve(response);
          });
        });
      } finally {
        await cursor.close();
      }
    });
  }

  private async access(ownerId: string, projectId: string) {
    z.uuid().parse(projectId);
    const admin = await this.pool.connect();
    try {
      await admin.query("BEGIN");
      await admin.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [projectId],
      );
      const result = await admin.query<ProjectAccess>(
        "SELECT schema_name, service_key_hash FROM control_plane.projects WHERE id = $1 AND owner_id = $2 FOR SHARE",
        [projectId, ownerId],
      );
      const project = result.rows[0];
      if (!project) throw new ApiError(404, "Project not found.");
      const login = project.schema_name.replace(/^p_/, "d_");
      const password = createHmac("sha256", project.service_key_hash)
        .update(`database-login:${projectId}`)
        .digest("hex");
      if (
        !(
          await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
            login,
          ])
        ).rowCount
      ) {
        const statement = await admin.query<{ sql: string }>(
          "SELECT format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS sql",
          [login, password],
        );
        await admin.query(statement.rows[0].sql);
        await admin.query(
          `GRANT ${roleIdentifier(project.schema_name)} TO ${roleIdentifier(login)}`,
        );
      }
      await admin.query("COMMIT");
      return { schema: project.schema_name, login, password };
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    } finally {
      admin.release();
    }
  }

  async withProject<Result>(
    ownerId: string,
    projectId: string,
    work: (client: Client, schema: string) => Promise<Result>,
  ) {
    const access = await this.access(ownerId, projectId);
    const connection = new URL(this.pool.options.connectionString ?? "");
    connection.username = access.login;
    connection.password = access.password;
    const client = new Client({
      connectionString: connection.toString(),
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      lock_timeout: 1_000,
      query_timeout: 6_000,
      application_name: "amazedb-project-editor",
    });
    try {
      await client.connect();
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${roleIdentifier(access.schema)}`);
      await client.query(
        `SET LOCAL search_path TO ${roleIdentifier(access.schema)}, pg_catalog`,
      );
      const result = await work(client, access.schema);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
}
