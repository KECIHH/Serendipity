import { handleAnonymousSession } from "@/server/plan/anonymous-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleAnonymousSession(request);
}
