import "server-only";

import type { NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { env } from "@/lib/env";
import { authenticateCredentials } from "@/server/auth/credentials-service";
import { AuthUnavailableError } from "@/server/auth/errors";
import { validateSession } from "@/server/auth/session-service";
import {
  AUTH_SESSION_MAX_AGE,
  authCookieSettings,
  encodeAuthCookie,
  readSessionClaims,
} from "@/server/auth/cookie";

type CredentialResult = Awaited<ReturnType<typeof authenticateCredentials>>;
type Principal = Awaited<ReturnType<typeof validateSession>>;

/** This state belongs to one handler invocation, never to a module singleton. */
export interface AuthRequestState {
  audience: "ADMIN" | "USER";
  redirectPath: "/admin" | "/" | "/admin/login" | "/login";
  clientAddress?: string;
  credentialResult?: CredentialResult;
  expiresAt?: Date;
  principal?: Principal;
  issuedToken?: string;
  unavailable: boolean;
  frameworkFailed: boolean;
}

export function createAuthConfig(state: AuthRequestState): NextAuthConfig {
  const origin = new URL(env.AUTH_URL).origin;
  return {
    secret: env.AUTH_SECRET,
    basePath: "/api/auth",
    trustHost: true,
    useSecureCookies: authCookieSettings().sessionToken.options.secure,
    session: { strategy: "jwt", maxAge: AUTH_SESSION_MAX_AGE },
    jwt: { maxAge: AUTH_SESSION_MAX_AGE, encode: encodeAuthCookie },
    cookies: authCookieSettings(),
    pages: { signIn: "/admin/login", error: "/admin/login" },
    providers: [
      Credentials({
        id: "credentials",
        credentials: { email: {}, password: {}, audience: {} },
        async authorize(credentials) {
          if (!state.clientAddress) {
            state.unavailable = true;
            return null;
          }
          const result = await authenticateCredentials({
            email: credentials.email,
            password: credentials.password,
            audience: state.audience,
            clientAddress: state.clientAddress,
          });
          state.credentialResult = result;
          if (result.kind !== "SUCCESS") {
            if (result.kind === "UNAVAILABLE") state.unavailable = true;
            return null;
          }
          state.issuedToken = result.session.opaqueToken;
          state.expiresAt = result.session.expiresAt;
          return {
            id: result.session.userId,
            opaqueToken: result.session.opaqueToken,
            absoluteExpiresAt: result.session.expiresAt.getTime(),
          };
        },
      }),
    ],
    callbacks: {
      redirect() {
        return `${origin}${state.redirectPath}`;
      },
      async jwt({ token, user }) {
        const claims = readSessionClaims(user ?? token);
        if (!claims) return null;
        try {
          // Recheck even during issuance and ignore every client session-update field.
          const principal = await validateSession(claims.opaqueToken, "USER");
          if (principal.expiresAt.getTime() !== claims.absoluteExpiresAt) return null;
          state.principal = principal;
          state.expiresAt = principal.expiresAt;
          return { ...claims };
        } catch (error: unknown) {
          if (error instanceof AuthUnavailableError) state.unavailable = true;
          if (user) state.credentialResult = { kind: "INVALID_CREDENTIALS" };
          return null;
        }
      },
      session() {
        const principal = state.principal;
        if (!principal) throw new Error("Authentication session is invalid.");
        // The opaque token and all authorization/version fields stay server-side.
        return {
          user: { email: principal.email },
          expires: principal.expiresAt.toISOString(),
        };
      },
    },
    logger: {
      error() {
        state.frameworkFailed = true;
      },
      warn() {},
      debug() {},
    },
  };
}
