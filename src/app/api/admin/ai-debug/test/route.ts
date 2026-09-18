import { ok } from "@/lib/api-response";
import { createAuditContext } from "@/server/audit-log";
import { withAdminRoute } from "@/server/auth/guards";
import { AI_DEBUG_TEST_OPERATION, aiDebugFailure, aiDebugService } from "@/server/ai/debug-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Accept one administrator debug call. The response is the persisted run receipt only:
 * the Mock worker executes afterwards and never writes a formal plan.
 */
export const POST = withAdminRoute(async (request, _route, principal) => {
  const context = createAuditContext();
  try {
    const accepted = await aiDebugService().accept(principal, AI_DEBUG_TEST_OPERATION, request);
    return Response.json(ok(accepted.receipt, context.requestId), {
      status: 202,
      headers: { "cache-control": "no-store", "Idempotency-Replayed": String(accepted.replayed) },
    });
  } catch (error) {
    return aiDebugFailure(error, context.requestId);
  }
});
