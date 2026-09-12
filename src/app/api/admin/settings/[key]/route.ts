import { ok } from "@/lib/api-response";
import { adminSettingsFailure, adminSettingsService } from "@/server/admin/settings";
import { createAuditContext } from "@/server/audit-log";
import { withAdminRoute } from "@/server/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const PATCH = withAdminRoute<{ params: Promise<{ key: string }> }>(
  async (request, route) => {
    const context = createAuditContext();
    try {
      const { key } = await route.params;
      const result = await adminSettingsService().update(request, key, context);
      return Response.json(ok(result.setting, context.requestId), {
        headers: { "cache-control": "no-store", "Idempotency-Replayed": String(result.replayed) },
      });
    } catch (error) {
      return adminSettingsFailure(error, context.requestId);
    }
  },
);
