import { ok } from "@/lib/api-response";
import { adminApiKeysFailure, adminApiKeysService } from "@/server/admin/api-keys";
import { createAuditContext } from "@/server/audit-log";
import { withAdminRoute } from "@/server/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const list = withAdminRoute(async (request) => {
  const context = createAuditContext();
  try {
    return Response.json(ok(await adminApiKeysService().list(request), context.requestId), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return adminApiKeysFailure(error, context.requestId);
  }
});
const create = withAdminRoute(async (request) => {
  const context = createAuditContext();
  try {
    const result = await adminApiKeysService().create(request, context);
    return Response.json(ok(result.key, context.requestId), {
      status: 201,
      headers: { "cache-control": "no-store", "Idempotency-Replayed": String(result.replayed) },
    });
  } catch (error) {
    return adminApiKeysFailure(error, context.requestId);
  }
});
export async function GET(request: Request): Promise<Response> {
  return list(request, undefined);
}
export async function POST(request: Request): Promise<Response> {
  return create(request, undefined);
}
