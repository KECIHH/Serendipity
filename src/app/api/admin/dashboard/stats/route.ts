import { ok } from "@/lib/api-response";
import { dashboardFailure, dashboardService } from "@/server/admin/dashboard";
import { createAuditContext } from "@/server/audit-log";
import { withAdminRoute } from "@/server/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withAdminRoute(async (request) => {
  const { requestId } = createAuditContext();
  try {
    return Response.json(ok(await dashboardService().stats(request, requestId), requestId), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return dashboardFailure(error, requestId);
  }
});
