import { ok } from "@/lib/api-response";
import { createAuditContext } from "@/server/audit-log";
import { withAdminRoute } from "@/server/auth/guards";
import { aiDebugFailure, aiDebugService } from "@/server/ai/debug-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Safe aggregate recovery. This handler only reads persisted rows: a refresh, a reconnect
 * or a repeated call performs zero Provider invocations.
 */
export const GET = withAdminRoute<{ params: Promise<{ id: string }> }>(
  async (_request, route, principal) => {
    const context = createAuditContext();
    try {
      const { id } = await route.params;
      return Response.json(ok(await aiDebugService().status(principal, id), context.requestId), {
        headers: { "cache-control": "no-store" },
      });
    } catch (error) {
      return aiDebugFailure(error, context.requestId);
    }
  },
);
