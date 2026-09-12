import { ok } from "@/lib/api-response";
import { adminUsersFailure, adminUsersService } from "@/server/admin/users";
import { createAuditContext } from "@/server/audit-log";
import { withAdminRoute } from "@/server/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const guardedList = withAdminRoute(async (request) => {
  const context = createAuditContext();
  try {
    return Response.json(ok(await adminUsersService().list(request), context.requestId), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return adminUsersFailure(error, context.requestId);
  }
});

export async function GET(request: Request): Promise<Response> {
  return guardedList(request, undefined);
}
