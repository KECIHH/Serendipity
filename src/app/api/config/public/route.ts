import { randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api-response";
import { publicConfigService } from "@/server/config/config-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  try {
    const { data, etag } = await publicConfigService().read();
    const headers = { "cache-control": "public, max-age=60, must-revalidate", etag };
    const tags = request.headers
      .get("if-none-match")
      ?.split(",")
      .map((tag) => tag.trim().replace(/^W\//, ""));
    if (tags?.some((tag) => tag === "*" || tag === etag.replace(/^W\//, "")))
      return new Response(null, { status: 304, headers });
    return Response.json(ok(data, randomUUID()), { headers });
  } catch {
    return Response.json(fail("INTERNAL_ERROR", "公开配置暂时不可用", randomUUID()), {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
}
