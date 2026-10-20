import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { ApiError, ControlPlane } from "@/server/control-plane";
import { getPool } from "@/server/db";
import { databaseRequest } from "@/server/database-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const cookieName = "amz_session";
type Context = { params: Promise<{ path?: string[] }> };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function handle(request: NextRequest, context: Context) {
  try {
    const segments = (await context.params).path ?? [];
    const path = segments.join("/");
    const method = request.method;
    const origin = process.env.APP_ORIGIN ?? "http://localhost:3000";
    const configuredOrigin = new URL(origin);
    const allowedOrigins = new Set([configuredOrigin.origin]);
    const loopbackHosts = ["localhost", "127.0.0.1", "[::1]"];
    if (loopbackHosts.includes(configuredOrigin.hostname)) {
      for (const hostname of loopbackHosts) {
        const alias = new URL(configuredOrigin.origin);
        alias.hostname = hostname;
        allowedOrigins.add(alias.origin);
      }
    }
    if (
      method !== "GET" &&
      !allowedOrigins.has(request.headers.get("origin") ?? "")
    )
      throw new ApiError(403, "Request origin is not allowed.");
    const platform = new ControlPlane(getPool());
    const token = request.cookies.get(cookieName)?.value;
    if (method === "GET" && path === "health") {
      await getPool().query("SELECT 1");
      return json({ database: "connected" });
    }
    if (method === "GET" && path === "auth/session")
      return json({ account: await platform.accountForSession(token) });
    if (
      method === "POST" &&
      (path === "auth/signup" || path === "auth/login")
    ) {
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        throw new ApiError(415, "Expected JSON.");
      const text = await request.text();
      if (Buffer.byteLength(text) > 16_384)
        throw new ApiError(413, "Request is too large.");
      const body: unknown = JSON.parse(text);
      const session =
        path === "auth/signup"
          ? await platform.signUp(body)
          : await platform.signIn(body);
      const response = json(
        { account: session.account },
        path === "auth/signup" ? 201 : 200,
      );
      response.cookies.set(cookieName, session.token, {
        httpOnly: true,
        sameSite: "lax",
        secure: origin.startsWith("https://"),
        path: "/",
        maxAge: session.maxAge,
      });
      return response;
    }
    if (method === "POST" && path === "auth/logout") {
      await platform.signOut(token);
      const response = json({ success: true });
      response.cookies.set(cookieName, "", {
        httpOnly: true,
        sameSite: "lax",
        secure: origin.startsWith("https://"),
        path: "/",
        maxAge: 0,
      });
      return response;
    }
    const account = await platform.accountForSession(token);
    if (!account) throw new ApiError(401, "Please sign in to continue.");
    if (method === "GET" && path === "projects")
      return json({ projects: await platform.listProjects(account.id) });
    if (method === "POST" && path === "projects") {
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        throw new ApiError(415, "Expected JSON.");
      const text = await request.text();
      if (Buffer.byteLength(text) > 16_384)
        throw new ApiError(413, "Request is too large.");
      return json(
        await platform.createProject(account.id, JSON.parse(text)),
        201,
      );
    }
    if (method === "DELETE" && /^projects\/[^/]+$/.test(path)) {
      await platform.deleteProject(account.id, path.split("/")[1]);
      return json({ success: true });
    }
    if (segments[0] === "projects" && segments.length >= 3) {
      return json(
        await databaseRequest(request, segments, account.id),
        method === "POST" && segments[2] === "tables" ? 201 : 200,
      );
    }
    throw new ApiError(404, "Endpoint not found.");
  } catch (error) {
    if (error instanceof ApiError)
      return json({ error: error.message }, error.status);
    if (error instanceof ZodError)
      return json({ error: error.issues[0]?.message ?? "Invalid input." }, 400);
    if (error instanceof SyntaxError)
      return json({ error: "Invalid JSON." }, 400);
    console.error(
      "Control-plane request failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return json(
      {
        error:
          "Database unavailable. Check DATABASE_URL and run the database migration.",
      },
      503,
    );
  }
}

export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
