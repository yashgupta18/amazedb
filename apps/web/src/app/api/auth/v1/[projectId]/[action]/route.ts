import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { ApplicationAuth } from "@/server/application-auth";
import { ApiError } from "@/server/control-plane";
import { getPool } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ projectId: string; action: string }> };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "apikey, content-type",
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { ...corsHeaders, "Cache-Control": "no-store" },
  });
}

async function readBody(request: NextRequest) {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new ApiError(415, "Expected a JSON request body.");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "A JSON request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16_384) {
        void reader.cancel();
        throw new ApiError(413, "Auth request exceeds 16 KB.");
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

async function handle(request: NextRequest, context: Context) {
  try {
    const { projectId, action } = await context.params;
    if (request.method !== "POST")
      throw new ApiError(405, "Method not supported.");
    const service = new ApplicationAuth(getPool());
    const key = request.headers.get("apikey") ?? undefined;
    const body = await readBody(request);
    if (action === "signup")
      return json(await service.signUp(projectId, key, body), 201);
    if (action === "login")
      return json(await service.signIn(projectId, key, body));
    if (action === "refresh")
      return json(await service.refresh(projectId, key, body));
    if (action === "logout")
      return json(await service.signOut(projectId, key, body));
    throw new ApiError(404, "Auth endpoint not found.");
  } catch (error) {
    if (error instanceof ApiError)
      return json({ error: error.message }, error.status);
    if (error instanceof ZodError)
      return json(
        { error: error.issues[0]?.message ?? "Invalid request." },
        400,
      );
    console.error(
      "Project auth request failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return json(
      { error: "Project authentication is temporarily unavailable." },
      503,
    );
  }
}

export const POST = handle;
export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}
