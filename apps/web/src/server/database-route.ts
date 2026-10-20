import type { NextRequest } from "next/server";
import { ApiError } from "./control-plane";
import { getPool } from "./db";
import { ProjectDatabase } from "./project-database";

async function readJson(request: NextRequest) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new ApiError(415, "Expected JSON.");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "Request body is required.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 65_536) {
        await reader.cancel();
        throw new ApiError(413, "Request is too large.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export async function databaseRequest(
  request: NextRequest,
  segments: string[],
  ownerId: string,
) {
  const [, projectId, resource, table, action] = segments;
  const database = new ProjectDatabase(getPool());
  const method = request.method;
  try {
    if (resource === "sql" && segments.length === 3 && method === "POST")
      return await database.executeSql(
        ownerId,
        projectId,
        await readJson(request),
      );
    if (resource !== "tables") throw new ApiError(404, "Endpoint not found.");
    if (segments.length === 3) {
      if (method === "GET")
        return { tables: await database.listTables(ownerId, projectId) };
      if (method === "POST")
        return await database.createTable(
          ownerId,
          projectId,
          await readJson(request),
        );
    }
    if (segments.length !== 5) throw new ApiError(404, "Endpoint not found.");
    if (action === "columns" && method === "POST")
      return await database.addColumn(
        ownerId,
        projectId,
        table,
        await readJson(request),
      );
    if (action !== "rows") throw new ApiError(404, "Endpoint not found.");
    if (method === "GET")
      return await database.readRows(
        ownerId,
        projectId,
        table,
        request.nextUrl.searchParams.get("page") ?? 0,
      );
    const body = await readJson(request);
    if (method === "POST")
      return await database.insertRow(ownerId, projectId, table, body);
    if (method === "PATCH")
      return await database.updateRow(ownerId, projectId, table, body);
    if (method === "DELETE")
      return await database.deleteRow(ownerId, projectId, table, body);
    throw new ApiError(405, "Method not supported.");
  } catch (error) {
    const postgres = error as { code?: string; message?: string };
    if (postgres.code === "42501")
      throw new ApiError(
        403,
        "The project role does not have permission for that operation.",
      );
    if (["57014", "55P03"].includes(postgres.code ?? ""))
      throw new ApiError(
        408,
        "Query timed out or a database lock could not be acquired.",
      );
    if (/^(22|23|42)/.test(postgres.code ?? ""))
      throw new ApiError(
        postgres.code === "23505" ? 409 : 400,
        postgres.message?.slice(0, 500) ?? "Database rejected the operation.",
      );
    throw error;
  }
}
