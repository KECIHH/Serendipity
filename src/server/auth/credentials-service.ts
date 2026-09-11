import "server-only";

import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { compare, hashSync } from "bcryptjs";
import { env } from "@/lib/env";
import { normalizeEmailV1 } from "@/server/auth";
import { AuditLogError, createAuditContext, type AuditRequestContext } from "@/server/audit-log";
import { AUTH_SESSION_MAX_AGE_SECONDS } from "@/server/auth/clock";
import { AuthUnavailableError } from "@/server/auth/errors";
import { createLoginThrottle, settleLoginReservation } from "@/server/auth/login-throttle";
import { hashSessionToken } from "@/server/auth/session-service";
import type {
  AuthAudience,
  CredentialsInput,
  CredentialsResult,
  LoginFailureReason,
  LoginIdentity,
  LoginReservation,
} from "@/server/auth/types";
import {
  openAuditedAuthDatabase,
  writeAuditLog,
  type AuditTransactionClient,
} from "@/server/services/audit-log-service";

// Prepared once per process, with the same real cost as an account. The random dummy input is discarded.
const DUMMY_BCRYPT_HASH = hashSync(randomBytes(32).toString("base64url"), 12);
const supportedPasswordHash = /^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/;

interface CredentialUser {
  id: string;
  email: string;
  passwordHash: string;
  role: "ADMIN" | "USER";
  status: "ACTIVE" | "DISABLED";
  sessionVersion: number;
}

export interface CredentialsServiceOptions {
  readonly databaseUrl?: string;
  readonly hmacSecret?: string;
  /** Instrumentation may wrap real bcrypt in isolated tests; production always uses bcrypt.compare. */
  readonly comparePassword?: (password: string, passwordHash: string) => Promise<boolean>;
}

/** Reject unbounded inputs before IDNA or bcrypt; accepted passwords keep their exact UTF-8 bytes. */
export function readLoginCredentials(
  email: unknown,
  password: unknown,
): { email: string; password: string } | null {
  if (
    typeof email !== "string" ||
    email.length > 1_024 ||
    !email.isWellFormed() ||
    typeof password !== "string" ||
    password.length > 72 ||
    !password.isWellFormed()
  )
    return null;
  const passwordBytes = Buffer.byteLength(password, "utf8");
  if (passwordBytes < 12 || passwordBytes > 72) return null;
  try {
    return { email: normalizeEmailV1(email), password };
  } catch {
    return null;
  }
}

function failureReason(
  user: CredentialUser | null,
  passwordAccepted: boolean,
  audience: AuthAudience,
): LoginFailureReason | null {
  if (!user) return "UNKNOWN_ACCOUNT";
  if (!passwordAccepted) return "PASSWORD_MISMATCH";
  if (user.status !== "ACTIVE") return "ACCOUNT_DISABLED";
  if (audience === "ADMIN" && user.role !== "ADMIN") return "ROLE_NOT_ALLOWED";
  return null;
}

async function appendLoginAudit(
  tx: AuditTransactionClient,
  context: AuditRequestContext,
  identity: LoginIdentity,
  audience: AuthAudience,
  action: "LOGIN_SUCCESS" | "LOGIN_FAILURE" | "LOGIN_THROTTLED",
  reasonCode: LoginFailureReason | "LOGIN_ACCEPTED" | "RATE_LIMITED",
  targetId: string | null = null,
): Promise<void> {
  await writeAuditLog(tx, {
    actor: { kind: "SYSTEM", systemActor: "MAINTENANCE" },
    action,
    targetType: "User",
    targetId,
    context,
    detailJson: {
      result:
        action === "LOGIN_SUCCESS"
          ? "SUCCESS"
          : action === "LOGIN_THROTTLED"
            ? "DENIED"
            : "FAILURE",
      reasonCode,
      ipHash: identity.ipHash,
      accountHash: identity.accountHash,
      audience,
      scope: identity.scope,
    },
  });
}

class LoginAlreadyCompleted extends AuditLogError {
  constructor(readonly result: CredentialsResult) {
    super("VALIDATION_ERROR");
  }
}

async function settleFailure(
  tx: AuditTransactionClient,
  reservation: LoginReservation,
  context: AuditRequestContext,
  audience: AuthAudience,
  reasonCode: LoginFailureReason,
): Promise<CredentialsResult> {
  const settled = await settleLoginReservation(tx, reservation, "FAILED");
  if (!settled.changed) throw new LoginAlreadyCompleted({ kind: "INVALID_CREDENTIALS" });
  await appendLoginAudit(
    tx,
    context,
    reservation,
    audience,
    "LOGIN_FAILURE",
    settled.status === "EXPIRED" ? "STATE_CHANGED" : reasonCode,
  );
  return { kind: "INVALID_CREDENTIALS" };
}

function buildCredentialsService(options: CredentialsServiceOptions) {
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
  const client = new PrismaClient({ datasourceUrl: databaseUrl, log: [] });
  const audited = openAuditedAuthDatabase(databaseUrl);
  const throttle = createLoginThrottle({
    databaseUrl,
    hmacSecret: options.hmacSecret ?? env.AUTH_SECRET,
  });
  const comparePassword = options.comparePassword ?? compare;

  return Object.freeze({
    async authenticate(input: CredentialsInput): Promise<CredentialsResult> {
      try {
        const credentials = readLoginCredentials(input.email, input.password);
        if (!credentials || (input.audience !== "ADMIN" && input.audience !== "USER"))
          return { kind: "INVALID_CREDENTIALS" };
        const context = createAuditContext();
        const admission = await throttle.admit({
          account: credentials.email,
          clientAddress: input.clientAddress,
          requestId: context.requestId,
          scope: "LOGIN",
        });
        if (admission.kind === "RATE_LIMITED") {
          await audited.transaction((tx) =>
            appendLoginAudit(
              tx,
              context,
              admission.identity,
              input.audience,
              "LOGIN_THROTTLED",
              "RATE_LIMITED",
            ),
          );
          return { kind: "RATE_LIMITED", retryAfter: admission.retryAfter };
        }

        const user = await client.user.findUnique({
          where: { email: credentials.email },
          select: {
            id: true,
            email: true,
            passwordHash: true,
            role: true,
            status: true,
            sessionVersion: true,
          },
        });
        const usableHash = user !== null && supportedPasswordHash.test(user.passwordHash);
        // AUTH_DUMMY_COMPARE: every admitted, well-formed credential attempt performs exactly one real compare.
        const passwordMatched = await comparePassword(
          credentials.password,
          usableHash ? user.passwordHash : DUMMY_BCRYPT_HASH,
        );
        const rejected = failureReason(user, usableHash && passwordMatched, input.audience);
        const reservation = admission.reservation;
        if (rejected || !user) {
          return await audited.transaction((tx) =>
            settleFailure(tx, reservation, context, input.audience, rejected ?? "UNKNOWN_ACCOUNT"),
          );
        }

        return await audited.transaction(async (tx) => {
          // Lock and re-read after bcrypt. A password/state/version change cannot inherit an old comparison.
          const rows = await tx.$queryRaw<CredentialUser[]>`
            SELECT id, email, "passwordHash", role, status, "sessionVersion"
            FROM "User" WHERE id = ${user.id} FOR UPDATE
          `;
          const current = rows[0];
          if (
            !current ||
            current.email !== credentials.email ||
            current.passwordHash !== user.passwordHash ||
            current.sessionVersion !== user.sessionVersion ||
            failureReason(current, true, input.audience) !== null
          )
            return settleFailure(tx, reservation, context, input.audience, "STATE_CHANGED");
          const settled = await settleLoginReservation(tx, reservation, "SUCCEEDED");
          if (!settled.changed) throw new LoginAlreadyCompleted({ kind: "UNAVAILABLE" });
          if (settled.status === "EXPIRED") {
            await appendLoginAudit(
              tx,
              context,
              reservation,
              input.audience,
              "LOGIN_FAILURE",
              "STATE_CHANGED",
            );
            return { kind: "INVALID_CREDENTIALS" };
          }
          const opaqueToken = randomBytes(32).toString("base64url");
          const tokenHash = hashSessionToken(opaqueToken);
          if (!tokenHash) throw new AuthUnavailableError();
          const expiresAt = new Date(settled.now.getTime() + AUTH_SESSION_MAX_AGE_SECONDS * 1_000);
          await tx.user.update({ where: { id: current.id }, data: { lastLoginAt: settled.now } });
          await tx.authSession.create({
            data: {
              userId: current.id,
              tokenHash,
              audience: input.audience,
              sessionVersion: current.sessionVersion,
              status: "ACTIVE",
              issuedAt: settled.now,
              expiresAt,
              createdAt: settled.now,
            },
          });
          await appendLoginAudit(
            tx,
            context,
            reservation,
            input.audience,
            "LOGIN_SUCCESS",
            "LOGIN_ACCEPTED",
            current.id,
          );
          return {
            kind: "SUCCESS",
            session: { opaqueToken, userId: current.id, audience: input.audience, expiresAt },
          };
        });
      } catch (error: unknown) {
        if (error instanceof LoginAlreadyCompleted) return error.result;
        // A failed lookup, reservation, audit or commit never issues a cookie or falls back to memory.
        return { kind: "UNAVAILABLE" };
      }
    },

    async disconnect(): Promise<void> {
      const results = await Promise.allSettled([
        client.$disconnect(),
        audited.disconnect(),
        throttle.disconnect(),
      ]);
      if (results.some((result) => result.status === "rejected")) throw new AuthUnavailableError();
    },
  });
}

let defaultService: ReturnType<typeof buildCredentialsService> | undefined;

export function createCredentialsService(options: CredentialsServiceOptions = {}) {
  if (Object.keys(options).length === 0)
    return (defaultService ??= buildCredentialsService(options));
  return buildCredentialsService(options);
}

export async function authenticateCredentials(input: CredentialsInput): Promise<CredentialsResult> {
  return createCredentialsService().authenticate(input);
}
