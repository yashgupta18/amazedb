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
    const { project } = await created.json();
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
    await page.getByRole("button", { name: "Edit row 1", exact: true }).click();
    await page.getByLabel("done mode", { exact: true }).selectOption("value");
    await page.locator('[id="value-done"]').selectOption("true");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(
      page.getByRole("cell", { name: "true", exact: true }),
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
