import { ok } from "@/lib/api-response";
import { adminUsersFailure, adminUsersService } from "@/server/admin/users";
import { createAuditContext } from "@/server/audit-log";
import { withAdminRoute } from "@/server/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = withAdminRoute<{ params: Promise<{ id: string }> }>(async (request, route) => {
  const context = createAuditContext();
  try {
    const { id } = await route.params;
    const result = await adminUsersService().update(request, id, context);
    return Response.json(ok(result.user, context.requestId), {
      headers: {
        "cache-control": "no-store",
        "Idempotency-Replayed": String(result.replayed),
      },
    });
  } catch (error) {
    return adminUsersFailure(error, context.requestId);
  }
});
