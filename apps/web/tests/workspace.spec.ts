import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { ControlPlane } from "../src/server/control-plane";

test("database tools support table and row editing and isolated SQL", async ({
  page,
}, testInfo) => {
  const email = `e2e-tools-${randomUUID()}@example.com`;
  const password = "database-browser-password";
  const name = `Database ${randomUUID().slice(0, 8)}`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const platform = new ControlPlane(pool);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.goto("/");
    const origin = new URL(page.url()).origin;
    const signup = await page.request.post("/api/control/auth/signup", {
      headers: { Origin: origin },
      data: { email, password },
    });
    expect(signup.status()).toBe(201);
    const created = await page.request.post("/api/control/projects", {
      headers: { Origin: origin },
      data: { name },
    });
    expect(created.status()).toBe(201);
    const { project, keys } = await created.json();
    const restUrl = `/api/rest/v1/${project.id}`;
    const preflight = await page.request.fetch(`${restUrl}/todos`, {
      method: "OPTIONS",
      headers: { Origin: "https://demo.example" },
    });
    expect(preflight.status()).toBe(204);
    expect(preflight.headers()["access-control-allow-origin"]).toBe("*");
    expect((await page.request.get(`${restUrl}/todos`)).status()).toBe(401);
    expect(
      (
        await page.request.get(`${restUrl}/todos`, {
          headers: { apikey: "invalid" },
        })
      ).status(),
    ).toBe(401);
    const oversized = await page.request.post(
      `/api/control/projects/${project.id}/sql`,
      { headers: { Origin: origin }, data: { sql: "x".repeat(70_000) } },
    );
    expect(oversized.status()).toBe(413);
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("link", { name: "Table editor", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "No tables yet" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Create your first table" }).click();
    await page.getByLabel("Table name", { exact: true }).fill("todos");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create table", exact: true })
      .click();
    const insert = page.getByRole("button", {
      name: "Insert row",
      exact: true,
    });
    await expect(insert).toBeEnabled();
    await insert.click();
    await page.locator('[id="value-title"]').fill("First row");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Insert row", exact: true })
      .click();
    await expect(
      page.getByRole("cell", { name: "First row", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Edit row 1", exact: true }).click();
    await page.locator('[id="value-title"]').fill("Updated row");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(
      page.getByRole("cell", { name: "Updated row", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Column", exact: true }).click();
    await page.getByLabel("New column name").fill("done");
    await page.getByLabel("New column type").selectOption("boolean");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Add column", exact: true })
      .click();
    await expect(
      page.getByRole("columnheader").filter({ hasText: "done" }),
    ).toBeVisible();
    const apiInsert = await page.request.post(`${restUrl}/todos`, {
      headers: { apikey: keys.anon },
      data: { title: "REST row", done: true },
    });
    const apiInsertBody = await apiInsert.text();
    expect(apiInsert.status(), apiInsertBody).toBe(201);
    expect(apiInsert.headers()["access-control-allow-origin"]).toBe("*");
    const apiRead = await page.request.get(
      `${restUrl}/todos?select=title,done&title=eq.REST%20row&done=is.true&order=title.desc&limit=1&offset=0`,
      { headers: { Authorization: `Bearer ${keys.anon}` } },
    );
    expect(apiRead.status()).toBe(200);
    expect(await apiRead.json()).toEqual([{ title: "REST row", done: true }]);
    expect(apiRead.headers()["content-range"]).toBe("0-0/*");
    expect(
      (
        await page.request.get(`${restUrl}/todos?select=id`, {
          headers: { apikey: keys.service },
        })
      ).status(),
    ).toBe(200);
    const noFilter = await page.request.patch(`${restUrl}/todos`, {
      headers: { apikey: keys.anon },
      data: { title: "Unsafe update" },
    });
    expect(noFilter.status()).toBe(400);
    const apiUpdate = await page.request.patch(
      `${restUrl}/todos?title=eq.REST%20row`,
      { headers: { apikey: keys.anon }, data: { title: "REST updated" } },
    );
    expect(await apiUpdate.json()).toEqual([
      { id: "2", title: "REST updated", done: true },
    ]);
    const apiDelete = await page.request.delete(
      `${restUrl}/todos?title=eq.REST%20updated`,
      { headers: { apikey: keys.anon } },
    );
    expect((await apiDelete.json()).length).toBe(1);
    await page.getByRole("button", { name: "Column", exact: true }).click();
    await page.getByLabel("New column name").fill("owner_id");
    await page.getByLabel("New column type").selectOption("uuid");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Add column", exact: true })
      .click();
    const appAuthUrl = `/api/auth/v1/${project.id}`;
    const authSignupA = await page.request.post(`${appAuthUrl}/signup`, {
      headers: { apikey: keys.anon },
      data: {
        email: `alice-${randomUUID()}@example.com`,
        password: "application-password-a",
      },
    });
    expect(authSignupA.status()).toBe(201);
    const userA = await authSignupA.json();
    const authSignupB = await page.request.post(`${appAuthUrl}/signup`, {
      headers: { apikey: keys.anon },
      data: {
        email: `bob-${randomUUID()}@example.com`,
        password: "application-password-b",
      },
    });
    expect(authSignupB.status()).toBe(201);
    const userB = await authSignupB.json();
    await page.getByRole("tab", { name: "SQL editor" }).click();
    await page
      .getByLabel("SQL query", { exact: true })
      .fill(`UPDATE todos SET owner_id = '${userA.user.id}'`);
    await page.getByRole("button", { name: "Run query", exact: true }).click();
    await expect(
      page.getByText("Statement completed", { exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "RLS policies" }).click();
    await page.getByLabel("Policy name").fill("owner_rows_only");
    await page
      .getByRole("button", { name: "Enable RLS and create policy" })
      .click();
    await expect(
      page.getByText("owner_rows_only", { exact: true }),
    ).toBeVisible();
    const anonymousRows = await page.request.get(
      `${restUrl}/todos?select=id,title`,
      { headers: { apikey: keys.anon } },
    );
    expect(await anonymousRows.json()).toEqual([]);
    const aliceRows = await page.request.get(
      `${restUrl}/todos?select=id,title`,
      {
        headers: {
          apikey: keys.anon,
          Authorization: `Bearer ${userA.access_token}`,
        },
      },
    );
    expect((await aliceRows.json()).length).toBeGreaterThan(0);
    const bobRows = await page.request.get(`${restUrl}/todos?select=id,title`, {
      headers: {
        apikey: keys.anon,
        Authorization: `Bearer ${userB.access_token}`,
      },
    });
    expect(await bobRows.json()).toEqual([]);
    const wrongOwnerInsert = await page.request.post(`${restUrl}/todos`, {
      headers: {
        apikey: keys.anon,
        Authorization: `Bearer ${userA.access_token}`,
      },
      data: { title: "Not Alice's row", done: true, owner_id: userB.user.id },
    });
    expect(wrongOwnerInsert.status()).toBe(403);
    const aliceInsert = await page.request.post(`${restUrl}/todos`, {
      headers: {
        apikey: keys.anon,
        Authorization: `Bearer ${userA.access_token}`,
      },
      data: { title: "Alice's row", done: true, owner_id: userA.user.id },
    });
    expect(aliceInsert.status()).toBe(201);
    const refresh = await page.request.post(`${appAuthUrl}/refresh`, {
      headers: { apikey: keys.anon },
      data: { refresh_token: userA.refresh_token },
    });
    expect(refresh.status()).toBe(200);
    const refreshed = await refresh.json();
    const replay = await page.request.post(`${appAuthUrl}/refresh`, {
      headers: { apikey: keys.anon },
      data: { refresh_token: userA.refresh_token },
    });
    expect(replay.status()).toBe(401);
    const logout = await page.request.post(`${appAuthUrl}/logout`, {
      headers: { apikey: keys.anon },
      data: { refresh_token: refreshed.refresh_token },
    });
    expect(logout.status()).toBe(200);
    const afterLogout = await page.request.post(`${appAuthUrl}/refresh`, {
      headers: { apikey: keys.anon },
      data: { refresh_token: refreshed.refresh_token },
    });
    expect(afterLogout.status()).toBe(401);
    const serviceCleanup = await page.request.delete(
      `${restUrl}/todos?title=eq.Alice%27s%20row`,
      { headers: { apikey: keys.service } },
    );
    expect((await serviceCleanup.json()).length).toBe(1);
    await page.getByRole("tab", { name: "Table editor" }).click();
    await page.getByRole("button", { name: "Edit row 1", exact: true }).click();
    await page.getByLabel("done mode", { exact: true }).selectOption("value");
    await page.locator('[id="value-done"]').selectOption("true");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(
      page.getByRole("cell", { name: "true", exact: true }).first(),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("table-editor.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.reload();
    await expect(
      page.getByRole("cell", { name: "Updated row", exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "SQL editor" }).click();
    const run = async (sql: string) => {
      await page.getByLabel("SQL query", { exact: true }).fill(sql);
      await page
        .getByRole("button", { name: "Run query", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Run query", exact: true }),
      ).toBeEnabled();
    };
    await run("SELECT id, title, done FROM todos ORDER BY id");
    await expect(
      page.getByRole("cell", { name: "Updated row", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("sql-editor.png"),
      fullPage: true,
      animations: "disabled",
    });
    await run("SELECT * FROM control_plane.accounts");
    await expect(page.getByRole("tabpanel").getByRole("alert")).toContainText(
      "does not have permission",
    );
    await run("SELECT 1; SELECT 2");
    await expect(page.getByRole("tabpanel").getByRole("alert")).toContainText(
      "one SQL statement",
    );
    await run("SELECT title FROM todos WHERE false");
    await expect(
      page.getByRole("columnheader", { name: "title", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("No rows returned", { exact: true }),
    ).toBeVisible();
    await run("CREATE TABLE notes (message text)");
    await expect(
      page.getByText("Statement completed", { exact: true }),
    ).toBeVisible();
    await run("INSERT INTO notes VALUES ('No primary key')");
    await expect(
      page.getByText("Statement completed", { exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Table editor" }).click();
    await page
      .getByRole("navigation", { name: "Tables" })
      .getByRole("button", { name: /^notes/ })
      .click();
    await expect(
      page.getByRole("cell", { name: "No primary key", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Edit row 1", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Delete row 1", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("navigation", { name: "Tables" })
      .getByRole("button", { name: /^todos/ })
      .click();
    await page
      .getByRole("button", { name: "Delete row 1", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete row", exact: true })
      .click();
    await expect(page.getByText("No rows", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "SQL editor" }).click();
    await run(
      "INSERT INTO todos (title) SELECT 'bulk-' || generate_series(1, 55)",
    );
    await expect(
      page.getByText("Statement completed", { exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Table editor" }).click();
    await expect(
      page.getByText("50 rows on this page", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(
      page.getByText("5 rows on this page", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    const account = (
      await pool.query<{ id: string }>(
        "SELECT id FROM control_plane.accounts WHERE email = $1",
        [email],
      )
    ).rows[0];
    if (account) {
      for (const project of await platform.listProjects(account.id))
        await platform.deleteProject(account.id, project.id);
      await pool.query("DELETE FROM control_plane.accounts WHERE id = $1", [
        account.id,
      ]);
    }
    await pool.end();
  }
});

test("account and project lifecycle", async ({ page, context }, testInfo) => {
  const email = `e2e-${randomUUID()}@example.com`;
  const password = "browser-test-password";
  const name = `Project ${randomUUID().slice(0, 8)}`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const platform = new ControlPlane(pool);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    const denied = await page.request.post("/api/control/auth/signup", {
      headers: { Origin: "https://untrusted.example" },
      data: { email, password },
    });
    expect(denied.status()).toBe(403);
    for (const origin of [
      "http://localhost:3001",
      "https://127.0.0.1:3000",
      "http://localhost.untrusted.example:3000",
      "null",
    ]) {
      const response = await page.request.post("/api/control/auth/signup", {
        headers: { Origin: origin },
        data: { email, password },
      });
      expect(response.status()).toBe(403);
    }
    const noOrigin = await page.request.post("/api/control/auth/signup", {
      data: { email, password },
    });
    expect(noOrigin.status()).toBe(403);
    for (const origin of [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
    ]) {
      const response = await page.request.post("/api/control/auth/signup", {
        headers: { Origin: origin, "Content-Type": "application/json" },
        data: "{",
      });
      expect(response.status()).toBe(400);
    }
    expect((await page.request.get("/api/control/projects")).status()).toBe(
      401,
    );
    const malformed = await page.request.post("/api/control/auth/signup", {
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      data: "{",
    });
    expect(malformed.status()).toBe(400);

    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Create your account" }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("account.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password").fill(password);
    await page
      .locator("form")
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "No projects yet" }),
    ).toBeVisible();
    const cookie = (await context.cookies()).find(
      (item) => item.name === "amz_session",
    );
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");

    await page.getByRole("button", { name: "New project" }).click();
    await page.getByLabel("Project name", { exact: true }).fill(name);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Project created", exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/^amz_anon_/)).toBeVisible();
    await expect(page.getByText(/^amz_service_/)).toHaveCount(0);
    await page.getByRole("button", { name: "Reveal", exact: true }).click();
    await expect(page.getByText(/^amz_service_/)).toBeVisible();
    await page.getByRole("button", { name: "Hide", exact: true }).click();
    await page
      .getByRole("button", { name: "Open project", exact: true })
      .click();
    await expect(
      page.getByText("Database provisioned", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("projects.png"),
      fullPage: true,
      animations: "disabled",
    });

    await page.getByRole("button", { name, exact: true }).click();
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page
      .getByRole("button", { name: "Copy Project ID", exact: true })
      .click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
      /^[a-f0-9-]{36}$/,
    );
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Search projects" })
      .fill("no-match");
    await expect(
      page.getByRole("heading", { name: "No matching projects" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();

    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Create your account" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password").fill("incorrect-password");
    await page
      .locator("form")
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await expect(page.locator("form").getByRole("alert")).toContainText(
      "Incorrect email or password",
    );
    await page.getByLabel("Password").fill(password);
    await page
      .locator("form")
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await page
      .getByRole("button", { name: `Delete ${name}`, exact: true })
      .click();
    const deleteButton = page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete project", exact: true });
    await expect(deleteButton).toBeDisabled();
    await page.getByLabel("Confirm project name").fill(name);
    await expect(deleteButton).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath("delete-confirmation.png"),
      fullPage: true,
      animations: "disabled",
    });
    await deleteButton.click();
    await expect(
      page.getByRole("heading", { name: "No projects yet" }),
    ).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    const result = await pool.query<{ id: string }>(
      "SELECT id FROM control_plane.accounts WHERE email = $1",
      [email],
    );
    if (result.rows[0]) {
      const accountId = result.rows[0].id;
      for (const project of await platform.listProjects(accountId))
        await platform.deleteProject(accountId, project.id);
      await pool.query("DELETE FROM control_plane.accounts WHERE id = $1", [
        accountId,
      ]);
    }
    await pool.end();
  }
});
