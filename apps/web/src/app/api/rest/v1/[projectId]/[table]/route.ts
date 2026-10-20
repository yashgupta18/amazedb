import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { ApiError } from "@/server/control-plane";
import { restRequest, type ApiResult } from "@/server/rest-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ projectId: string; table: string }> };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, prefer",
  "Access-Control-Expose-Headers": "Content-Range, Preference-Applied",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return NextResponse.json(body, {
    status,
    headers: { ...corsHeaders, ...extra, "Cache-Control": "no-store" },
  });
}

function errorResponse(error: unknown) {
  if (error instanceof ApiError)
    return json({ error: error.message }, error.status);
  if (error instanceof ZodError)
    return json({ error: error.issues[0]?.message ?? "Invalid request." }, 400);
  const postgres = error as { code?: string; message?: string };
  if (postgres.code === "42501")
    return json(
      { error: "The API key does not have permission for that operation." },
      403,
    );
  if (postgres.code === "23505")
    return json({ error: "A row with that unique value already exists." }, 409);
  if (postgres.code && /^(22|23|42)/.test(postgres.code))
    return json(
      {
        error:
          postgres.message?.slice(0, 500) ?? "Database rejected the request.",
      },
      400,
    );
  if (["57014", "55P03"].includes(postgres.code ?? ""))
    return json({ error: "The database request timed out." }, 408);
  console.error(
    "REST request failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  return json({ error: "REST API is temporarily unavailable." }, 503);
}

async function handle(request: NextRequest, context: Context) {
  try {
    const { projectId, table } = await context.params;
    const result: ApiResult = await restRequest(request, projectId, table);
    const offset = result.offset ?? 0;
    const rangeEnd = result.rows.length
      ? offset + result.rows.length - 1
      : offset - 1;
    return json(result.rows, request.method === "POST" ? 201 : 200, {
      "Content-Range": `${offset}-${rangeEnd}/*`,
      "Preference-Applied": "return=representation",
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}
