import "server-only";

import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";
import { normalizeEmailV1 } from "@/server/auth";
import { AuditLogError, createAuditContext } from "@/server/audit-log";
import { readAuthClock } from "@/server/auth/clock";
import { AuthAuthorizationError, AuthUnavailableError } from "@/server/auth/errors";
import type { AuthAudience, AuthPrincipal } from "@/server/auth/types";
import { openAuditedAuthDatabase, writeAuditLog } from "@/server/services/audit-log-service";

/** Only a canonical 256-bit opaque value can be looked up; its original bytes never reach SQL. */
export function hashSessionToken(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) return null;
  return createHash("sha256").update(value).digest("hex");
}

interface SessionRow {
  sessionId: string;
  id: string;
  email: string;
  role: "ADMIN" | "USER";
  userStatus: "ACTIVE" | "DISABLED";
  userSessionVersion: number;
  audience: AuthAudience;
  sessionStatus: "ACTIVE" | "REVOKED" | "EXPIRED";
  issuedSessionVersion: number;
  expiresAt: Date;
  now: Date;
}

class RevocationAlreadyComplete extends AuditLogError {}

export interface SessionServiceOptions {
  readonly databaseUrl?: string;
}

export function createSessionService(options: SessionServiceOptions = {}) {
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
  const client = new PrismaClient({ datasourceUrl: databaseUrl, log: [] });
  const audited = openAuditedAuthDatabase(databaseUrl);

  return Object.freeze({
    async validateSession(opaqueToken: string, audience: AuthAudience): Promise<AuthPrincipal> {
      const tokenHash = hashSessionToken(opaqueToken);
      if (!tokenHash) throw new AuthAuthorizationError();
      try {
        // AUTH_SESSION_DB_CHECK: one database statement checks the session and current user snapshot.
        const rows = await client.$queryRaw<SessionRow[]>`
          SELECT s.id AS "sessionId", u.id, u.email, u.role, u.status AS "userStatus",
                 u."sessionVersion" AS "userSessionVersion", s.audience,
                 s.status AS "sessionStatus", s."sessionVersion" AS "issuedSessionVersion",
                 s."expiresAt", public.auth_now() AS now
          FROM "AuthSession" s JOIN "User" u ON u.id = s."userId"
          WHERE s."tokenHash" = ${tokenHash}
        `;
        const row = rows[0];
        if (
          !row ||
          row.sessionStatus !== "ACTIVE" ||
          row.userStatus !== "ACTIVE" ||
          // AUTH_SESSION_VERSION_CHECK: a signed cookie never replaces this live comparison.
          row.issuedSessionVersion !== row.userSessionVersion ||
          !["ADMIN", "USER"].includes(row.role) ||
          !["ADMIN", "USER"].includes(row.audience) ||
          (row.audience === "ADMIN" && row.role !== "ADMIN")
        )
          throw new AuthAuthorizationError();
        if (
          !(row.now instanceof Date) ||
          !Number.isFinite(row.now.getTime()) ||
          !(row.expiresAt instanceof Date) ||
          !Number.isFinite(row.expiresAt.getTime())
        )
          throw new AuthUnavailableError();
        if (row.expiresAt <= row.now) {
          await client.authSession.updateMany({
            where: { id: row.sessionId, status: "ACTIVE", expiresAt: { lte: row.now } },
            data: { status: "EXPIRED" },
          });
          throw new AuthAuthorizationError();
        }
        if (
          (audience !== "ADMIN" && audience !== "USER") ||
          (audience === "ADMIN" && (row.audience !== "ADMIN" || row.role !== "ADMIN"))
        )
          throw new AuthAuthorizationError(403, "FORBIDDEN");
        if (normalizeEmailV1(row.email) !== row.email) throw new AuthAuthorizationError();
        return Object.freeze({
          id: row.id,
          email: row.email,
          role: row.role,
          audience: row.audience,
          expiresAt: row.expiresAt,
        });
      } catch (error: unknown) {
        if (error instanceof AuthAuthorizationError) throw error;
        throw new AuthUnavailableError();
      }
    },

    async revokeSession(opaqueToken: string): Promise<void> {
      const tokenHash = hashSessionToken(opaqueToken);
      if (!tokenHash) return;
      const context = createAuditContext();
      try {
        await audited.transaction(async (tx) => {
          const rows = await tx.$queryRaw<
            Array<{ id: string; status: string; audience: AuthAudience }>
          >`
            SELECT id, status, audience FROM "AuthSession" WHERE "tokenHash" = ${tokenHash} FOR UPDATE
          `;
          const row = rows[0];
          // A no-op aborts the read-only transaction; it does not relax mandatory audit writes.
          if (!row || row.status !== "ACTIVE")
            throw new RevocationAlreadyComplete("VALIDATION_ERROR");
          const now = await readAuthClock(tx);
          const revoked = await tx.authSession.updateMany({
            where: { id: row.id, status: "ACTIVE" },
            data: { status: "REVOKED", revokedAt: now },
          });
          if (revoked.count !== 1) throw new AuthUnavailableError();
          await writeAuditLog(tx, {
            actor: { kind: "SYSTEM", systemActor: "MAINTENANCE" },
            action: "SESSION_LOGOUT",
            targetType: "AuthSession",
            targetId: row.id,
            context,
            detailJson: {
              result: "SUCCESS",
              reasonCode: "SESSION_REVOKED",
              audience: row.audience,
            },
          });
        });
      } catch (error: unknown) {
        if (error instanceof RevocationAlreadyComplete) return;
        throw new AuthUnavailableError();
      }
    },

    async disconnect(): Promise<void> {
      const results = await Promise.allSettled([client.$disconnect(), audited.disconnect()]);
      if (results.some((result) => result.status === "rejected")) throw new AuthUnavailableError();
    },
  });
}

let defaultService: ReturnType<typeof createSessionService> | undefined;
function sessionService() {
  return (defaultService ??= createSessionService());
}

export async function validateSession(
  opaqueToken: string,
  audience: AuthAudience,
): Promise<AuthPrincipal> {
  return sessionService().validateSession(opaqueToken, audience);
}

export async function revokeSession(opaqueToken: string): Promise<void> {
  return sessionService().revokeSession(opaqueToken);
}
