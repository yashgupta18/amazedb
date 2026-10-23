import assert from "node:assert/strict";
import { test } from "node:test";
import { AmazeDBError, createClient } from "../src/lib/client";

const projectId = "c59e99db-d3e3-4f59-860d-b55dbe492b38";
const firstSession = {
  user: {
    id: "ee64dca3-8ea4-465c-b4c4-5921ef38ddbb",
    email: "alice@example.com",
  },
  access_token: "first.jwt.token",
  token_type: "bearer" as const,
  expires_in: 900,
  refresh_token: "first-refresh-token-value-0123456789abcdef",
};
const nextSession = {
  ...firstSession,
  access_token: "next.jwt.token",
  refresh_token: "next-refresh-token-value-0123456789abcdef",
};

test("client builds filtered REST requests and keeps project auth tokens in memory", async () => {
  const calls: { url: URL; method: string; headers: Headers; body: unknown }[] =
    [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method ?? "GET", headers, body });
    if (url.pathname.endsWith("/signup"))
      return Response.json(firstSession, { status: 201 });
    if (url.pathname.endsWith("/refresh")) return Response.json(nextSession);
    if (url.pathname.endsWith("/logout"))
      return Response.json({ success: true });
    if (init?.method === "POST")
      return Response.json([{ id: "1", title: "Created" }], { status: 201 });
    return Response.json([{ id: "1", title: "Alice's row" }]);
  };
  const client = createClient(
    `https://db.example/api/rest/v1/${projectId}`,
    "amz_anon_example",
    { fetch: fetcher },
  );
  assert.equal(client.projectId, projectId);
  assert.equal(client.auth.getSession(), null);

  await client.auth.signUp({
    email: "alice@example.com",
    password: "application-password",
  });
  assert.equal(
    client.auth.getSession()?.access_token,
    firstSession.access_token,
  );
  assert.equal(calls[0].url.pathname, `/api/auth/v1/${projectId}/signup`);
  assert.equal(calls[0].headers.get("apikey"), "amz_anon_example");
  assert.equal(calls[0].headers.has("authorization"), false);

  const rows = await client
    .from("todos")
    .select("id,title")
    .eq("done", true)
    .order("id", { ascending: false })
    .range(5, 9)
    .execute();
  assert.equal(rows[0].title, "Alice's row");
  assert.equal(calls[1].url.pathname, `/api/rest/v1/${projectId}/todos`);
  assert.equal(calls[1].url.searchParams.get("select"), "id,title");
  assert.equal(calls[1].url.searchParams.get("done"), "eq.true");
  assert.equal(calls[1].url.searchParams.get("order"), "id.desc");
  assert.equal(calls[1].url.searchParams.get("offset"), "5");
  assert.equal(calls[1].url.searchParams.get("limit"), "5");
  assert.equal(
    calls[1].headers.get("authorization"),
    `Bearer ${firstSession.access_token}`,
  );

  await client.from("todos").insert({ title: "Created" }).execute();
  assert.equal(calls[2].method, "POST");
  assert.deepEqual(calls[2].body, { title: "Created" });
  await client.from("todos").update({ title: "Changed" }).eq("id", 1).execute();
  assert.equal(calls[3].method, "PATCH");
  assert.equal(calls[3].url.searchParams.get("id"), "eq.1");
  await client.from("todos").delete().eq("id", 1).execute();
  assert.equal(calls[4].method, "DELETE");

  await client.auth.refreshSession();
  assert.equal(calls[5].url.pathname, `/api/auth/v1/${projectId}/refresh`);
  assert.deepEqual(calls[5].body, {
    refresh_token: firstSession.refresh_token,
  });
  assert.equal(
    client.auth.getSession()?.access_token,
    nextSession.access_token,
  );
  await client.auth.signOut();
  assert.equal(calls[6].url.pathname, `/api/auth/v1/${projectId}/logout`);
  assert.deepEqual(calls[6].body, { refresh_token: nextSession.refresh_token });
  assert.equal(client.auth.getSession(), null);
});

test("client reports server errors and rejects project URLs without an ID", async () => {
  assert.throws(
    () => createClient("https://db.example/rest/v1", "anon"),
    /projectId/,
  );
  const client = createClient(
    "https://db.example/api/rest/v1/project-id",
    "anon",
    {
      fetch: async () =>
        Response.json({ error: "permission denied" }, { status: 403 }),
    },
  );
  await assert.rejects(
    client.from("todos").select().execute(),
    (error: unknown) =>
      error instanceof AmazeDBError &&
      error.status === 403 &&
      error.message === "permission denied",
  );
});
