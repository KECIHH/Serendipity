import "server-only";

import { randomUUID } from "node:crypto";
import { headers } from "next/headers";

import { env } from "@/lib/env";
import { fail } from "@/lib/api-response";
import { CookieRequestError, assertCookieMutation } from "@/server/auth/cookie";
import { AuthAuthorizationError } from "@/server/auth/errors";
import { requireAdmin, type AdminPrincipal } from "@/server/auth/require-admin";

type AdminRoute<Context> = (
  request: Request,
  context: Context,
  principal: AdminPrincipal,
) => Promise<Response>;

function guardFailure(error: unknown): Response {
  if (error instanceof AuthAuthorizationError || error instanceof CookieRequestError) {
    const status = error.status === 401 ? 401 : 403;
    const code = status === 401 ? "AUTH_REQUIRED" : "FORBIDDEN";
    return Response.json(fail(code, status === 401 ? "请先登录" : "无法执行此操作", randomUUID()), {
      status,
      headers: { "cache-control": "no-store" },
    });
  }
  return Response.json(fail("INTERNAL_ERROR", "服务暂时不可用", randomUUID()), {
    status: 503,
    headers: { "cache-control": "no-store" },
  });
}

/** Future registered management Route Handlers pass all resource work inside this function. */
export function withAdminRoute<Context = unknown>(operation: AdminRoute<Context>) {
  return async (request: Request, context: Context): Promise<Response> => {
    try {
      const principal = await requireAdmin(request);
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        assertCookieMutation(request, request.headers.get("x-csrf-token"));
      }
      return await operation(request, context, principal);
    } catch (error: unknown) {
      return guardFailure(error);
    }
  };
}

/** Call from an exported Server Action; caller data can never supply its principal. */
export function withAdminAction<Input, Output>(
  operation: (input: Input, principal: AdminPrincipal) => Promise<Output>,
) {
  return async (input: Input, csrfToken: string): Promise<Output> => {
    const principal = await requireAdmin();
    const request = new Request(env.AUTH_URL, { method: "POST", headers: await headers() });
    assertCookieMutation(request, csrfToken);
    return operation(input, principal);
  };
}
