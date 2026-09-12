import { ok } from "@/lib/api-response";
import { adminSettingsFailure, adminSettingsService } from "@/server/admin/settings";
import { createAuditContext } from "@/server/audit-log";
import { withAdminRoute } from "@/server/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withAdminRoute(async (request) => {
  const context = createAuditContext();
  try {
    return Response.json(ok(await adminSettingsService().list(request), context.requestId), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return adminSettingsFailure(error, context.requestId);
  }
});
