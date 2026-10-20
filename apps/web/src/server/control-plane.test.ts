import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { ProjectDatabase } from "./project-database";
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
