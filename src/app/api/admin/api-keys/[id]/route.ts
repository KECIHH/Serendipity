import { ok } from "@/lib/api-response";
import { adminApiKeysFailure, adminApiKeysService } from "@/server/admin/api-keys";
import { createAuditContext } from "@/server/audit-log";
import { withAdminRoute } from "@/server/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const PATCH = withAdminRoute<{ params: Promise<{ id: string }> }>(async (request, route) => {
  const context = createAuditContext();
  try {
    const { id } = await route.params;
    const result = await adminApiKeysService().update(request, id, context);
    return Response.json(ok(result.key, context.requestId), {
      headers: { "cache-control": "no-store", "Idempotency-Replayed": String(result.replayed) },
    });
  } catch (error) {
    return adminApiKeysFailure(error, context.requestId);
  }
});
