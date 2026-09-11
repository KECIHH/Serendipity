import type { Prisma } from "@prisma/client";
import type { AuthPrincipal, CredentialsResult } from "@/server/auth/types";
import type { AdminPrincipal } from "@/server/auth/require-admin";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Value extends true> = Value;

export type AuthPrincipalIsMinimal = Assert<
  Equal<keyof AuthPrincipal, "id" | "email" | "role" | "audience" | "expiresAt">
>;
export type AdminRoleIsNarrow = Assert<Equal<AdminPrincipal["role"], "ADMIN">>;
export type FailedCredentialsContainNoSession = Assert<
  Equal<keyof Extract<CredentialsResult, { kind: "INVALID_CREDENTIALS" }>, "kind">
>;
export type SessionHasNoPlaintextToken = Assert<
  Equal<Extract<keyof Prisma.AuthSessionCreateInput, "opaqueToken" | "password" | "token">, never>
>;
export type AttemptHasNoRawIdentity = Assert<
  Equal<Extract<keyof Prisma.AuthLoginAttemptCreateInput, "email" | "ipAddress" | "userId">, never>
>;
