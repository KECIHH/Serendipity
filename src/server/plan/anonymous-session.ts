import "server-only";

import { randomUUID } from "node:crypto";
import { ok } from "@/lib/api-response";
import { assertSameOrigin } from "@/server/auth/cookie";
import { issueOrReuseAnonymousSession } from "@/server/chat/owner";
import { PlanDraftError, planErrorResponse } from "./http";

/** Issue or reuse the signed anonymous cookie. This route writes no business row. */
export async function handleAnonymousSession(request: Request): Promise<Response> {
  const requestId = randomUUID();
  try {
    assertSameOrigin(request);
    if (new URL(request.url).search.length > 0) throw new PlanDraftError("VALIDATION_ERROR");
    const text = await request.text();
    if (text.length > 4096) throw new PlanDraftError("VALIDATION_ERROR");
    if (text.trim().length > 0) {
      const parsed: unknown = JSON.parse(text);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.keys(parsed).length > 0
      )
        throw new PlanDraftError("VALIDATION_ERROR");
    }
    const issued = issueOrReuseAnonymousSession(request);
    return Response.json(ok({ anonymousSessionReady: true as const }, requestId), {
      headers: { "cache-control": "no-store", "set-cookie": issued.cookieHeader },
    });
  } catch (error) {
    return planErrorResponse(error, requestId);
  }
}
