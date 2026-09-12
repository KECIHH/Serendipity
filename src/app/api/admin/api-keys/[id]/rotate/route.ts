import { ok } from "@/lib/api-response";
import { adminApiKeysFailure, adminApiKeysService } from "@/server/admin/api-keys";
import { createAuditContext } from "@/server/audit-log";
import { withAdminRoute } from "@/server/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = withAdminRoute<{ params: Promise<{ id: string }> }>(async (request, route) => {
  const context = createAuditContext();
  try {
    const { id } = await route.params;
    const result = await adminApiKeysService().rotate(request, id, context);
    return Response.json(ok(result, context.requestId), {
      status: 202,
      headers: { "cache-control": "no-store", "Idempotency-Replayed": String(result.replayed) },
    });
  } catch (error) {
    return adminApiKeysFailure(error, context.requestId);
  }
});
