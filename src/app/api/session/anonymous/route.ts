import { NextResponse } from "next/server";
import { issueOrReuseAnonymousSession } from "@/server/chat/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/session/anonymous
 * Establishes or reuses a signed httpOnly anonymous session Cookie. This endpoint has no
 * business side effects and is the only way to bootstrap an anonymous owner before a write.
 */
export async function POST(): Promise<Response> {
  const { cookieHeader } = issueOrReuseAnonymousSession();
  return new NextResponse(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "set-cookie": cookieHeader,
    },
  });
}