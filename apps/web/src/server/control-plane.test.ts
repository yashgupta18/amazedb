import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { ProjectDatabase } from "./project-database";
import { restRequest } from "./rest-api";
import { ApplicationAuth } from "./application-auth";
import { SignJWT } from "jose";
import { projectSigningKey } from "./project-tokens";
import {
  ApiError,
  ControlPlane,
  hashToken,
  verifyPassword,
} from "./control-plane";

if (!process.env.DATABASE_URL)
  throw new Error("Set DATABASE_URL and run npm run db:migrate before tests.");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const platform = new ControlPlane(pool);
const accounts: string[] = [];

test("project auth rotates refresh tokens and PostgreSQL RLS isolates JWT users", async () => {
  const session = await platform.signUp({
    email: `rls-${randomUUID()}@example.com`,
    password: "dashboard-test-password",
  });
  accounts.push(session.account.id);
  const first = await platform.createProject(session.account.id, {
    name: "RLS project",
  });
  const second = await platform.createProject(session.account.id, {
    name: "Different audience",
  });
  const auth = new ApplicationAuth(pool);
  const database = new ProjectDatabase(pool);
  const userA = await auth.signUp(first.project.id, first.keys.anon, {
    email: "alice@example.com",
    password: "application-password-a",
  });
  const userB = await auth.signUp(first.project.id, first.keys.anon, {
    email: "bob@example.com",
    password: "application-password-b",
  });
  const otherProjectUser = await auth.signUp(
    second.project.id,
    second.keys.anon,
    {
      email: "alice@example.com",
      password: "application-password-c",
    },
  );
  await assert.rejects(
    auth.signUp(first.project.id, first.keys.anon, {
      email: "alice@example.com",
      password: "application-password-a",
    }),
    (error: unknown) => error instanceof ApiError && error.status === 409,
  );
  await assert.rejects(
    auth.signIn(first.project.id, second.keys.anon, {
      email: "alice@example.com",
      password: "application-password-a",
    }),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  const signedIn = await auth.signIn(first.project.id, first.keys.anon, {
    email: "alice@example.com",
    password: "application-password-a",
  });
  assert.notEqual(signedIn.access_token, "");
  await assert.rejects(
    auth.signIn(first.project.id, first.keys.anon, {
      email: "alice@example.com",
      password: "wrong-password",
    }),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );

  const refreshed = await auth.refresh(first.project.id, first.keys.anon, {
    refresh_token: userA.refresh_token,
  });
  assert.notEqual(refreshed.refresh_token, userA.refresh_token);
  await assert.rejects(
    auth.refresh(first.project.id, first.keys.anon, {
      refresh_token: userA.refresh_token,
    }),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  await assert.rejects(
    auth.refresh(first.project.id, second.keys.anon, {
      refresh_token: refreshed.refresh_token,
    }),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  await database.createTable(session.account.id, first.project.id, {
    name: "documents",
    columns: [
      { name: "owner_id", type: "uuid", nullable: false },
      { name: "body", type: "text", nullable: false },
    ],
  });
  await database.createOwnerPolicy(
    session.account.id,
    first.project.id,
    "documents",
    {
      name: "owner_reads_and_writes",
      ownerColumn: "owner_id",
      command: "all",
    },
  );
  assert.equal(
    (
      await database.listPolicies(
        session.account.id,
        first.project.id,
        "documents",
      )
    ).length,
    1,
  );

  const url = `http://localhost/api/rest/v1/${first.project.id}/documents`;
  async function rest(
    key: string,
    method = "GET",
    token?: string,
    query = "",
    body?: unknown,
  ) {
    const response = await restRequest(
      new Request(`${url}${query}`, {
        method,
        headers: {
          apikey: key,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      first.project.id,
      "documents",
    );
    return response as { rows: Record<string, unknown>[] };
  }

  await rest(first.keys.anon, "POST", userA.access_token, "", {
    owner_id: userA.user.id,
    body: "Alice document",
  });
  await rest(first.keys.anon, "POST", userB.access_token, "", {
    owner_id: userB.user.id,
    body: "Bob document",
  });
  assert.equal((await rest(first.keys.anon)).rows.length, 0);
  assert.deepEqual(
    (await rest(first.keys.anon, "GET", userA.access_token)).rows.map(
      (row) => row.body,
    ),
    ["Alice document"],
  );
  assert.deepEqual(
    (await rest(first.keys.anon, "GET", userB.access_token)).rows.map(
      (row) => row.body,
    ),
    ["Bob document"],
  );
  assert.equal((await rest(first.keys.service)).rows.length, 2);
  await assert.rejects(
    rest(first.keys.anon, "GET", otherProjectUser.access_token),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  const expiredToken = await new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("amazedb")
    .setAudience(first.project.id)
    .setSubject(userA.user.id)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
    .sign(
      projectSigningKey(
        first.project.id,
        await (async () =>
          (
            await pool.query<{ service_key_hash: string }>(
              "SELECT service_key_hash FROM control_plane.projects WHERE id = $1",
              [first.project.id],
            )
          ).rows[0].service_key_hash)(),
      ),
    );
  await assert.rejects(
    rest(first.keys.anon, "GET", expiredToken),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  await auth.signOut(first.project.id, first.keys.anon, {
    refresh_token: refreshed.refresh_token,
  });
  await assert.rejects(
    auth.refresh(first.project.id, first.keys.anon, {
      refresh_token: refreshed.refresh_token,
    }),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  await platform.deleteProject(session.account.id, first.project.id);
  await platform.deleteProject(session.account.id, second.project.id);
});

test("project API keys expose filtered REST CRUD with separate anon and service roles", async () => {
  const session = await platform.signUp({
    email: `rest-${randomUUID()}@example.com`,
    password: "rest-api-test-password",
  });
  accounts.push(session.account.id);
  const first = await platform.createProject(session.account.id, {
    name: "REST API",
  });
  const second = await platform.createProject(session.account.id, {
    name: "Other REST API",
  });
  const database = new ProjectDatabase(pool);
  await database.createTable(session.account.id, first.project.id, {
    name: "items",
    columns: [
      { name: "title", type: "text", nullable: false },
      { name: "score", type: "integer", nullable: false },
      { name: "active", type: "boolean" },
    ],
  });
  await assert.rejects(
    database.withApiKey(first.project.id, second.keys.anon, async () => true),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  await assert.rejects(
    database.withApiKey(first.project.id, "invalid", async () => true),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );

  const anon = first.keys.anon;
  const service = first.keys.service;
  async function rest(method: string, query = "", body?: unknown, key = anon) {
    const request = new Request(
      `http://localhost/api/rest/v1/${first.project.id}/items${query}`,
      {
        method,
        headers: {
          apikey: key,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    return restRequest(request, first.project.id, "items");
  }
  await database.withApiKey(
    first.project.id,
    anon,
    async (client, schema, serviceRole) => {
      assert.equal(serviceRole, false);
      assert.notEqual(
        (await client.query("SELECT current_user")).rows[0].current_user,
        schema,
      );
    },
  );
  await assert.rejects(
    database.withApiKey(first.project.id, anon, (client) =>
      client.query("SELECT * FROM control_plane.accounts"),
    ),
    (error: unknown) => (error as { code?: string }).code === "42501",
  );
  await assert.rejects(
    database.withApiKey(first.project.id, anon, (client, schema) =>
      client.query(`CREATE TABLE "${schema}".anon_ddl (id integer)`),
    ),
    (error: unknown) => (error as { code?: string }).code === "42501",
  );
  const inserted = await rest("POST", "", [
    { title: "low", score: 12, active: false },
    { title: "medium", score: 18, active: true },
    { title: "high", score: 31, active: true },
  ]);
  assert.equal((inserted as { rows: unknown[] }).rows.length, 3);
  assert.deepEqual(
    (
      (await rest(
        "GET",
        "?select=title,score&score=gt.15&order=score.desc&limit=1&offset=0",
      )) as { rows: unknown[] }
    ).rows,
    [{ title: "high", score: 31 }],
  );
  assert.deepEqual(
    (
      (await rest("GET", "?score=in.(12,31)&order=score.asc")) as {
        rows: unknown[];
      }
    ).rows,
    [
      { id: "1", title: "low", score: 12, active: false },
      { id: "3", title: "high", score: 31, active: true },
    ],
  );
  assert.equal(
    ((await rest("GET", "?active=is.true&score=gte.18")) as { rows: unknown[] })
      .rows.length,
    2,
  );
  await rest("PATCH", "?title=eq.low", { score: 14 });
  assert.equal(
    ((await rest("GET", "?id=eq.1")) as { rows: Record<string, unknown>[] })
      .rows[0].score,
    14,
  );
  await assert.rejects(
    rest("PATCH", "", { score: 0 }),
    (error: unknown) => error instanceof ApiError && error.status === 400,
  );
  await assert.rejects(
    rest("DELETE"),
    (error: unknown) => error instanceof ApiError && error.status === 400,
  );
  await assert.rejects(
    rest("GET", "?unknown=eq.value"),
    (error: unknown) => error instanceof ApiError && error.status === 400,
  );
  await assert.rejects(
    rest("GET", "?select=id,missing"),
    (error: unknown) => error instanceof ApiError && error.status === 400,
  );
  await assert.rejects(
    rest("GET", "?order=score.sideways"),
    (error: unknown) => error instanceof ApiError && error.status === 400,
  );
  const removed = await rest("DELETE", "?active=is.false");
  assert.equal((removed as { rows: unknown[] }).rows.length, 1);
  await database.executeSql(session.account.id, first.project.id, {
    sql: "INSERT INTO items (title, score) SELECT 'bulk-' || generate_series(1, 101), 1",
  });
  await assert.rejects(
    rest("PATCH", "?score=eq.1", { score: 2 }),
    (error: unknown) => error instanceof ApiError && error.status === 413,
  );
  assert.equal(
    ((await rest("GET", "?score=eq.1&select=id&limit=200")).rows as unknown[])
      .length,
    101,
  );
  await assert.rejects(
    rest("DELETE", "?score=eq.1"),
    (error: unknown) => error instanceof ApiError && error.status === 413,
  );
  assert.equal(
    ((await rest("GET", "?score=eq.1&select=id&limit=200")).rows as unknown[])
      .length,
    101,
  );
  await database.executeSql(session.account.id, first.project.id, {
    sql: "INSERT INTO items (title, score) VALUES (repeat('x', 2100000), 3)",
  });
  await assert.rejects(
    rest("GET", "?score=eq.3&select=title"),
    (error: unknown) => error instanceof ApiError && error.status === 413,
  );

  await database.withApiKey(
    first.project.id,
    service,
    async (client, schema, serviceRole) => {
      assert.equal(serviceRole, true);
      assert.equal(
        (await client.query("SELECT current_user")).rows[0].current_user,
        schema,
      );
      await client.query(`CREATE TABLE "${schema}".service_only (id integer)`);
    },
  );
  await database.withApiKey(first.project.id, anon, async (client, schema) => {
    assert.equal(
      (await client.query(`SELECT * FROM "${schema}".service_only`)).rowCount,
      0,
    );
  });
  assert.equal(
    (
      await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
        `a_${first.project.schema_name.slice(2)}`,
      ])
    ).rowCount,
    1,
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
        `s_${first.project.schema_name.slice(2)}`,
      ])
    ).rowCount,
    1,
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
        `n_${first.project.schema_name.slice(2)}`,
      ])
    ).rowCount,
    1,
  );
  await platform.deleteProject(session.account.id, first.project.id);
  for (const prefix of ["a", "s", "n", "d", "p"]) {
    assert.equal(
      (
        await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
          `${prefix}_${first.project.schema_name.slice(2)}`,
        ])
      ).rowCount,
      0,
    );
  }
});

test("database tools create tables and columns, mutate keyed rows, and bound SQL results", async () => {
  const session = await platform.signUp({
    email: `test-${randomUUID()}@example.com`,
    password: "editor-test-password",
  });
  accounts.push(session.account.id);
  const { project } = await platform.createProject(session.account.id, {
    name: "Database tools",
  });
  const database = new ProjectDatabase(pool);
  await database.createTable(session.account.id, project.id, {
    name: "todos",
    columns: [
      { name: "title", type: "text", nullable: false },
      { name: "metadata", type: "jsonb" },
    ],
  });
  assert.equal(
    (await database.listTables(session.account.id, project.id))[0].name,
    "todos",
  );
  await database.addColumn(session.account.id, project.id, "todos", {
    name: "done",
    type: "boolean",
  });
  const row = await database.insertRow(
    session.account.id,
    project.id,
    "todos",
    {
      values: {
        title: "O'Reilly; DROP TABLE todos; --",
        metadata: { nested: [1, "two"] },
        done: false,
      },
    },
  );
  assert.equal(row.id, "1");
  assert.deepEqual(row.metadata, { nested: [1, "two"] });
  await database.updateRow(session.account.id, project.id, "todos", {
    key: { id: row.id },
    values: { title: "Updated", done: true },
  });
  const page = await database.readRows(session.account.id, project.id, "todos");
  assert.equal(page.rows[0].title, "Updated");
  assert.equal(
    page.columns.find((column) => column.name === "done")?.generated,
    false,
  );
  assert.equal(
    page.columns.find((column) => column.name === "id")?.generated,
    true,
  );
  await assert.rejects(
    database.updateRow(session.account.id, project.id, "todos", {
      values: { title: "Unscoped" },
    }),
  );
  await assert.rejects(
    database.insertRow(session.account.id, project.id, "todos", {
      values: { "title) VALUES ('bad'); --": "no" },
    }),
  );
  await assert.rejects(
    database.createTable(session.account.id, project.id, {
      name: "bad; DROP SCHEMA public",
      columns: [],
    }),
  );
  await assert.rejects(
    database.createTable(session.account.id, project.id, {
      name: "duplicate_id",
      columns: [{ name: "id", type: "text" }],
    }),
  );
  const empty = await database.executeSql(session.account.id, project.id, {
    sql: "SELECT title FROM todos WHERE false",
  });
  assert.deepEqual(empty.columns, ["title"]);
  assert.equal(empty.rows.length, 0);
  const selected = await database.executeSql(session.account.id, project.id, {
    sql: "SELECT id, title FROM todos",
  });
  assert.deepEqual(selected.rows, [["1", "Updated"]]);
  assert.equal(
    (
      await database.executeSql(session.account.id, project.id, {
        sql: "SELECT generate_series(1, 1000)",
      })
    ).rows.length,
    200,
  );
  assert.equal(
    (
      await database.executeSql(session.account.id, project.id, {
        sql: "SELECT generate_series(1, 1000)",
      })
    ).truncated,
    true,
  );
  await database.executeSql(session.account.id, project.id, {
    sql: "CREATE TABLE sql_created (name text)",
  });
  await database.executeSql(session.account.id, project.id, {
    sql: "INSERT INTO sql_created VALUES ('from SQL')",
  });
  assert.equal(
    (await database.listTables(session.account.id, project.id)).length,
    2,
  );
  await assert.rejects(
    database.deleteRow(session.account.id, project.id, "sql_created", {
      key: {},
    }),
  );
  for (const sql of [
    "RESET ROLE",
    "BEGIN",
    "CREATE FUNCTION unsafe() RETURNS void AS $$ SELECT 1 $$ LANGUAGE sql",
    "SELECT 1; SELECT 2",
    "SELECT set_config('statement_timeout', '0', false)",
    "DROP SCHEMA public CASCADE",
  ]) {
    await assert.rejects(
      database.executeSql(session.account.id, project.id, { sql }),
      (error: unknown) => error instanceof ApiError && error.status === 400,
    );
  }
  await assert.rejects(
    database.executeSql(session.account.id, project.id, {
      sql: "SELECT * FROM control_plane.accounts",
    }),
    (error: unknown) => (error as { code?: string }).code === "42501",
  );
  await assert.rejects(
    database.executeSql(session.account.id, project.id, {
      sql: "SELECT pg_sleep(6)",
    }),
    (error: unknown) => (error as { code?: string }).code === "57014",
  );
  await database.deleteRow(session.account.id, project.id, "todos", {
    key: { id: row.id },
  });
  assert.equal(
    (await database.readRows(session.account.id, project.id, "todos")).rows
      .length,
    0,
  );
  await database.executeSql(session.account.id, project.id, {
    sql: "INSERT INTO todos (title) SELECT 'row ' || generate_series(1, 55)",
  });
  assert.equal(
    (await database.readRows(session.account.id, project.id, "todos")).hasMore,
    true,
  );
  assert.equal(
    (await database.readRows(session.account.id, project.id, "todos", 1)).rows
      .length,
    5,
  );
  await assert.rejects(
    database.executeSql(session.account.id, project.id, {
      sql: "SELECT repeat('x', 2100000)",
    }),
    (error: unknown) => error instanceof ApiError && error.status === 413,
  );
  const inserted = await database.executeSql(session.account.id, project.id, {
    sql: "INSERT INTO todos (title) SELECT 'returning-' || generate_series(1, 250) RETURNING id",
  });
  assert.equal(inserted.rows.length, 200);
  assert.equal(inserted.truncated, true);
  const count = await database.executeSql(session.account.id, project.id, {
    sql: "SELECT count(*) FROM todos",
  });
  assert.deepEqual(count.rows, [["305"]]);
});

test("project editor connections cannot regain administrative or other-project privileges", async () => {
  const session = await platform.signUp({
    email: `test-${randomUUID()}@example.com`,
    password: "database-test-password",
  });
  accounts.push(session.account.id);
  const first = await platform.createProject(session.account.id, {
    name: "Editor isolation",
  });
  const second = await platform.createProject(session.account.id, {
    name: "Other editor",
  });
  const database = new ProjectDatabase(pool);
  await database.withProject(
    session.account.id,
    second.project.id,
    async (client) => {
      await client.query("CREATE TABLE private_rows (id integer)");
    },
  );
  await database.withProject(
    session.account.id,
    first.project.id,
    async (client, schema) => {
      assert.equal(
        (await client.query("SELECT current_user")).rows[0].current_user,
        schema,
      );
      await client.query("CREATE TABLE own_rows (id integer)");
      await client.query("RESET ROLE");
      assert.equal(
        (await client.query("SELECT current_user")).rows[0].current_user,
        schema.replace(/^p_/, "d_"),
      );
    },
  );
  for (const sql of [
    "SELECT * FROM control_plane.accounts",
    `SELECT * FROM "${second.project.schema_name}".private_rows`,
    `SET ROLE "${second.project.schema_name}"`,
    "SET SESSION AUTHORIZATION DEFAULT; SELECT * FROM control_plane.accounts",
    "RESET ROLE; SELECT * FROM control_plane.projects",
  ]) {
    await assert.rejects(
      database.withProject(session.account.id, first.project.id, (client) =>
        client.query(sql),
      ),
      (error: unknown) => (error as { code?: string }).code === "42501",
    );
  }
  await assert.rejects(
    database.withProject(randomUUID(), first.project.id, (client) =>
      client.query("SELECT 1"),
    ),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  );
  await platform.deleteProject(session.account.id, first.project.id);
  assert.equal(
    (
      await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
        first.project.schema_name.replace(/^p_/, "d_"),
      ])
    ).rowCount,
    0,
  );
});

after(async () => {
  for (const accountId of accounts) {
    for (const project of await platform.listProjects(accountId))
      await platform.deleteProject(accountId, project.id);
    await pool.query("DELETE FROM control_plane.accounts WHERE id = $1", [
      accountId,
    ]);
  }
  await pool.end();
});

test("dashboard accounts, sessions, project ownership and PostgreSQL isolation", async () => {
  const email = `test-${randomUUID()}@example.com`;
  const password = "a-test-password-123";
  const session = await platform.signUp({ email, password });
  accounts.push(session.account.id);
  const other = await platform.signUp({
    email: `test-${randomUUID()}@example.com`,
    password,
  });
  accounts.push(other.account.id);

  assert.equal((await platform.accountForSession(session.token))?.email, email);
  assert.equal(await platform.accountForSession("invalid-token"), null);
  const stored = (
    await pool.query(
      "SELECT password_hash FROM control_plane.accounts WHERE id = $1",
      [session.account.id],
    )
  ).rows[0];
  assert.notEqual(stored.password_hash, password);
  assert.equal(await verifyPassword(password, stored.password_hash), true);
  assert.equal(
    await verifyPassword("wrong-password", stored.password_hash),
    false,
  );
  await assert.rejects(
    platform.signUp({ email, password }),
    (error: unknown) => error instanceof ApiError && error.status === 409,
  );
  await assert.rejects(
    platform.signIn({ email, password: "wrong-password" }),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  await assert.rejects(
    platform.createProject(session.account.id, { name: " " }),
  );

  const first = await platform.createProject(session.account.id, {
    name: "First project",
  });
  const second = await platform.createProject(other.account.id, {
    name: "Other project",
  });
  assert.notEqual(first.project.schema_name, second.project.schema_name);
  assert.notEqual(first.keys.anon, first.keys.service);
  const keyRow = (
    await pool.query(
      "SELECT anon_key_hash, service_key_hash FROM control_plane.projects WHERE id = $1",
      [first.project.id],
    )
  ).rows[0];
  assert.equal(keyRow.anon_key_hash, hashToken(first.keys.anon));
  assert.equal(keyRow.service_key_hash, hashToken(first.keys.service));
  assert.equal((await platform.listProjects(session.account.id)).length, 1);
  assert.equal(
    "anon_key_hash" in (await platform.listProjects(session.account.id))[0],
    false,
  );
  await assert.rejects(
    platform.deleteProject(other.account.id, first.project.id),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE "${second.project.schema_name}"`);
    await client.query(
      `CREATE TABLE "${second.project.schema_name}".private_data (id integer)`,
    );
    await client.query("COMMIT");
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE "${first.project.schema_name}"`);
    await assert.rejects(
      client.query(
        `SELECT * FROM "${second.project.schema_name}".private_data`,
      ),
      (error: unknown) => (error as { code?: string }).code === "42501",
    );
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE "${first.project.schema_name}"`);
    await assert.rejects(
      client.query("SELECT * FROM control_plane.accounts"),
      (error: unknown) => (error as { code?: string }).code === "42501",
    );
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE "${first.project.schema_name}"`);
    await assert.rejects(
      client.query("CREATE TABLE public.should_not_exist (id integer)"),
      (error: unknown) => (error as { code?: string }).code === "42501",
    );
    await client.query("ROLLBACK");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }

  assert.equal(
    (await platform.listProjects(other.account.id))[0].table_count,
    1,
  );
  const login = await platform.signIn({ email, password });
  await pool.query(
    "UPDATE control_plane.sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1",
    [hashToken(login.token)],
  );
  assert.equal(await platform.accountForSession(login.token), null);
  await platform.signOut(session.token);
  assert.equal(await platform.accountForSession(session.token), null);
  await platform.deleteProject(session.account.id, first.project.id);
  assert.equal(
    (
      await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [
        first.project.schema_name,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
        first.project.schema_name,
      ])
    ).rowCount,
    0,
  );
});
