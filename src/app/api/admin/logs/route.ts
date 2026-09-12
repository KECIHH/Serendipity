import { ok } from "@/lib/api-response";
import { adminLogsFailure, adminLogsService } from "@/server/admin/logs";
import { createAuditContext } from "@/server/audit-log";
import { withAdminRoute } from "@/server/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const guardedList = withAdminRoute(async (request) => {
  const context = createAuditContext();
  try {
    return Response.json(ok(await adminLogsService().list(request), context.requestId), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return adminLogsFailure(error, context.requestId);
  }
});
export async function GET(request: Request): Promise<Response> {
  return guardedList(request, undefined);
}
