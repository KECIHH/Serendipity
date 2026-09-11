import "server-only";

import { headers } from "next/headers";

import { env } from "@/lib/env";
import { readAuthCookie } from "@/server/auth/cookie";
import { AuthAuthorizationError } from "@/server/auth/errors";
import { validateSession } from "@/server/auth/session-service";

export type AdminPrincipal = Omit<
  Awaited<ReturnType<typeof validateSession>>,
  "role" | "audience"
> & {
  readonly role: "ADMIN";
  readonly audience: "ADMIN";
};

/** No cross-request cache: every call reaches AuthSession and the current User in PostgreSQL. */
export async function requireAdmin(request?: Request): Promise<AdminPrincipal> {
  // Server Actions expose mutable ResponseCookies; use the original request header without
  // Set-Cookie attributes or a parsed cookie map that could hide duplicate incoming names.
  const source = request ?? new Request(env.AUTH_URL, { headers: await headers() });
  const claims = await readAuthCookie(source);
  if (!claims) throw new AuthAuthorizationError(401, "AUTH_REQUIRED");
  const principal = await validateSession(claims.opaqueToken, "ADMIN");
  if (principal.role !== "ADMIN" || principal.audience !== "ADMIN") {
    throw new AuthAuthorizationError(403, "FORBIDDEN");
  }
  return Object.freeze({ ...principal, role: "ADMIN", audience: "ADMIN" });
}
