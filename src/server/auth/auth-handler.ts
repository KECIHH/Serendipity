import "server-only";

import NextAuth from "next-auth";
import { NextRequest } from "next/server";

import { env } from "@/lib/env";
import { createAuthConfig, type AuthRequestState } from "@/server/auth/auth-config";
import {
  CookieRequestError,
  assertCookieMutation,
  assertSameOrigin,
  authFrameworkCookieHeader,
  clampSessionCookies,
  clearSessionCookies,
  hasAuthCookieInput,
  readAuthCookie,
} from "@/server/auth/cookie";
import { revokeSession } from "@/server/auth/session-service";
import { trustedClientAddress } from "@/server/auth/trusted-client";

const MAX_POST_BYTES = 8_192;
const AUTH_PATH = "/api/auth";

class AuthRequestValidationError extends Error {}

function failure(status: 400 | 401 | 403 | 429 | 503, retryAfter?: number): Response {
  const errors = {
    400: { code: "VALIDATION_ERROR", message: "请求无效，请重试" },
    401: { code: "AUTH_REQUIRED", message: "邮箱或密码错误" },
    403: { code: "FORBIDDEN", message: "请求验证失败" },
    429: { code: "RATE_LIMITED", message: "登录尝试过于频繁，请稍后重试" },
    503: { code: "INTERNAL_ERROR", message: "登录服务暂时不可用，请稍后重试" },
  } as const;
  const headers = new Headers({ "cache-control": "no-store" });
  if (status === 429) headers.set("retry-after", String(Math.max(1, Math.ceil(retryAfter ?? 900))));
  // Framework auth responses have no account-dependent data or per-account error codes.
  return Response.json({ error: errors[status] }, { status, headers });
}

async function readPost(request: Request): Promise<string> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
    "application/x-www-form-urlencoded"
  ) {
    throw new AuthRequestValidationError();
  }
  const length = request.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_POST_BYTES)) {
    throw new AuthRequestValidationError();
  }
  if (!request.body) throw new AuthRequestValidationError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_POST_BYTES) {
        await reader.cancel();
        throw new AuthRequestValidationError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new AuthRequestValidationError();
  }
}

function frameworkRequest(request: Request, body?: string): NextRequest {
  const configured = new URL(env.AUTH_URL);
  const incoming = new URL(request.url);
  const url = new URL(`${incoming.pathname}${incoming.search}`, configured.origin);
  const headers = new Headers(request.headers);
  headers.set("host", configured.host);
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-proto");
  headers.set("cookie", authFrameworkCookieHeader(request));
  return new NextRequest(url, {
    method: request.method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

async function revokeUndeliveredSession(state: AuthRequestState): Promise<void> {
  if (!state.issuedToken) return;
  try {
    await revokeSession(state.issuedToken);
  } catch {
    // No cookie is delivered; failure must remain closed even if compensation is unavailable.
    state.unavailable = true;
  }
}

/** The only credentials/exit HTTP entry remains the real Auth.js framework handler. */
export async function handleAuthRequest(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname !== AUTH_PATH && !pathname.startsWith(`${AUTH_PATH}/`)) {
    return new Response(null, { status: 404 });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
  }
  const login = request.method === "POST" && pathname === `${AUTH_PATH}/callback/credentials`;
  const logout = request.method === "POST" && pathname === `${AUTH_PATH}/signout`;
  const state: AuthRequestState = {
    audience: "ADMIN",
    redirectPath: "/admin/login",
    unavailable: false,
    frameworkFailed: false,
  };
  let verifiedLogout = false;
  try {
    let body: string | undefined;
    if (request.method === "POST") {
      assertSameOrigin(request);
      body = await readPost(request);
      const form = new URLSearchParams(body);
      for (const field of ["email", "password", "audience", "csrfToken", "callbackUrl"]) {
        if (form.getAll(field).length > 1) throw new AuthRequestValidationError();
      }
      assertCookieMutation(request, form.get("csrfToken"));
      verifiedLogout = logout;
      if (login) {
        const audience = form.get("audience");
        if (audience !== "ADMIN" && audience !== "USER") throw new AuthRequestValidationError();
        state.audience = audience;
        state.redirectPath = audience === "ADMIN" ? "/admin" : "/";
        // Only the attested socket/proxy boundary may determine this throttle key.
        state.clientAddress = trustedClientAddress(request);
      } else if (logout) {
        state.redirectPath = form.get("callbackUrl") === "/login" ? "/login" : "/admin/login";
        // Revocation precedes Auth.js cleanup and cannot be swallowed by its event handling.
        const claims = await readAuthCookie(request);
        if (!claims && hasAuthCookieInput(request)) {
          return clearSessionCookies(failure(401), request);
        }
        if (claims) await revokeSession(claims.opaqueToken);
      }
    }
    const configuredRequest = frameworkRequest(request, body);
    const { handlers } = NextAuth(createAuthConfig(state));
    const raw = await handlers[request.method as "GET" | "POST"](configuredRequest);

    if (logout) {
      const result = state.frameworkFailed || state.unavailable ? failure(503) : raw;
      return clearSessionCookies(result, request);
    }
    if (login) {
      const result = state.credentialResult;
      if (state.unavailable || result?.kind === "UNAVAILABLE") {
        await revokeUndeliveredSession(state);
        return failure(503);
      }
      if (result?.kind === "RATE_LIMITED") return failure(429, result.retryAfter);
      if (result?.kind === "INVALID_CREDENTIALS") {
        await revokeUndeliveredSession(state);
        return failure(401);
      }
      if (result?.kind !== "SUCCESS") return failure(400);
      if (state.frameworkFailed || !state.principal || !state.expiresAt) {
        await revokeUndeliveredSession(state);
        return failure(503);
      }
    }
    if (state.unavailable) return clearSessionCookies(failure(503), request);
    return clampSessionCookies(raw, state.expiresAt);
  } catch (error: unknown) {
    await revokeUndeliveredSession(state);
    const response =
      error instanceof CookieRequestError
        ? failure(403)
        : error instanceof AuthRequestValidationError
          ? failure(400)
          : failure(503);
    return verifiedLogout ? clearSessionCookies(response, request) : response;
  }
}
