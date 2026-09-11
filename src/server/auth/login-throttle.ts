import "server-only";

import { createHmac } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";
import { normalizeEmailV1 } from "@/server/auth";
import { canonicalIp } from "@/server/ingress";
import {
  LOGIN_ACCOUNT_LIMIT,
  LOGIN_IP_LIMIT,
  LOGIN_RESERVATION_SECONDS,
  LOGIN_WINDOW_SECONDS,
  readAuthClock,
} from "@/server/auth/clock";
import { AuthUnavailableError } from "@/server/auth/errors";
import type {
  AuthScope,
  LoginAdmission,
  LoginIdentity,
  LoginReservation,
} from "@/server/auth/types";

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface LoginThrottleOptions {
  readonly databaseUrl?: string;
  readonly hmacSecret?: string;
}

export interface LoginAdmissionInput {
  readonly account: string;
  readonly clientAddress: string;
  readonly requestId: string;
  readonly scope?: AuthScope;
}

interface CountedAttempt {
  readonly ipHash: string;
  readonly accountHash: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly reservedUntil: Date;
}

/** HMAC identities are domain separated; the network address has already crossed trusted ingress. */
export function createLoginIdentity(
  input: Pick<LoginAdmissionInput, "account" | "clientAddress" | "scope">,
  hmacSecret: string,
): LoginIdentity {
  try {
    const scope = input.scope ?? "LOGIN";
    if (
      !["LOGIN", "REGISTER"].includes(scope) ||
      typeof hmacSecret !== "string" ||
      hmacSecret.length < 32 ||
      normalizeEmailV1(input.account) !== input.account
    )
      throw new AuthUnavailableError();
    const key = createHmac("sha256", hmacSecret).update("serendipity:auth:hmac-key:v1\0").digest();
    const digest = (kind: "account" | "ip", value: string) =>
      createHmac("sha256", key)
        .update(`serendipity:auth:${scope}:${kind}:v1\0`)
        .update(value)
        .digest("hex");
    return Object.freeze({
      scope,
      accountHash: digest("account", input.account),
      ipHash: digest("ip", canonicalIp(input.clientAddress)),
    });
  } catch {
    throw new AuthUnavailableError();
  }
}

/** Sort text before hashing lock keys so every process acquires the same global order. */
export function loginBucketKeys(identity: LoginIdentity): readonly string[] {
  return [
    `serendipity:auth:${identity.scope}:account:${identity.accountHash}`,
    `serendipity:auth:${identity.scope}:ip:${identity.ipHash}`,
  ].sort();
}

function bucketRetryAfter(rows: readonly CountedAttempt[], limit: number, now: Date): number {
  if (rows.length < limit) return 0;
  const releases = rows
    .map((row) =>
      Math.min(
        row.createdAt.getTime() + LOGIN_WINDOW_SECONDS * 1_000,
        row.status === "RESERVED" ? row.reservedUntil.getTime() : Number.POSITIVE_INFINITY,
      ),
    )
    .sort((left, right) => left - right);
  return Math.max(1, Math.ceil((releases[rows.length - limit] - now.getTime()) / 1_000));
}

/** Rolling FAILED history lasts 15 minutes; a crashed RESERVED entry releases at its 60s TTL. */
export function loginRetryAfter(
  rows: readonly CountedAttempt[],
  identity: LoginIdentity,
  now: Date,
): number {
  return Math.max(
    bucketRetryAfter(
      rows.filter((row) => row.accountHash === identity.accountHash),
      LOGIN_ACCOUNT_LIMIT,
      now,
    ),
    bucketRetryAfter(
      rows.filter((row) => row.ipHash === identity.ipHash),
      LOGIN_IP_LIMIT,
      now,
    ),
  );
}

export function createLoginThrottle(options: LoginThrottleOptions = {}) {
  const client = new PrismaClient({
    datasourceUrl: options.databaseUrl ?? env.DATABASE_URL,
    log: [],
  });
  const hmacSecret = options.hmacSecret ?? env.AUTH_SECRET;

  return Object.freeze({
    async admit(input: LoginAdmissionInput): Promise<LoginAdmission> {
      try {
        if (!uuidV4.test(input.requestId)) throw new AuthUnavailableError();
        const identity = createLoginIdentity(input, hmacSecret);
        return await client.$transaction(
          async (tx) => {
            for (const key of loginBucketKeys(identity)) {
              // AUTH_ADVISORY_LOCK: both buckets must be locked before any count or reservation.
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0::bigint))`;
            }
            const now = await readAuthClock(tx);
            // Expired rows no longer count. SKIP LOCKED avoids deadlocks between intersecting sweeps.
            await tx.$executeRaw`
              WITH expired AS (
                SELECT id FROM "AuthLoginAttempt"
                WHERE scope = ${identity.scope} AND status = 'RESERVED' AND "reservedUntil" <= ${now}
                  AND ("ipHash" = ${identity.ipHash} OR "accountHash" = ${identity.accountHash})
                ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED
              )
              UPDATE "AuthLoginAttempt" SET status = 'EXPIRED', "completedAt" = ${now}
              WHERE id IN (SELECT id FROM expired)
            `;
            const existing = await tx.authLoginAttempt.findUnique({
              where: { requestId: input.requestId },
            });
            if (existing) {
              if (
                existing.scope !== identity.scope ||
                existing.ipHash !== identity.ipHash ||
                existing.accountHash !== identity.accountHash ||
                existing.status !== "RESERVED" ||
                existing.reservedUntil <= now
              )
                throw new AuthUnavailableError();
              return {
                kind: "RESERVED",
                reservation: Object.freeze({
                  ...identity,
                  id: existing.id,
                  requestId: existing.requestId,
                  reservedUntil: existing.reservedUntil,
                }),
              };
            }
            const rows = await tx.authLoginAttempt.findMany({
              where: {
                scope: identity.scope,
                createdAt: { gt: new Date(now.getTime() - LOGIN_WINDOW_SECONDS * 1_000) },
                AND: [
                  { OR: [{ ipHash: identity.ipHash }, { accountHash: identity.accountHash }] },
                  {
                    OR: [{ status: "FAILED" }, { status: "RESERVED", reservedUntil: { gt: now } }],
                  },
                ],
              },
              select: {
                ipHash: true,
                accountHash: true,
                status: true,
                createdAt: true,
                reservedUntil: true,
              },
            });
            const retryAfter = loginRetryAfter(rows, identity, now);
            if (retryAfter > 0) return { kind: "RATE_LIMITED", retryAfter, identity };
            const reservation = await tx.authLoginAttempt.create({
              data: {
                ...identity,
                requestId: input.requestId,
                status: "RESERVED",
                createdAt: now,
                reservedUntil: new Date(now.getTime() + LOGIN_RESERVATION_SECONDS * 1_000),
              },
              select: { id: true, requestId: true, reservedUntil: true },
            });
            return {
              kind: "RESERVED",
              reservation: Object.freeze({ ...identity, ...reservation }),
            };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            maxWait: 5_000,
            timeout: 15_000,
          },
        );
      } catch {
        throw new AuthUnavailableError();
      }
    },
    async disconnect(): Promise<void> {
      try {
        await client.$disconnect();
      } catch {
        throw new AuthUnavailableError();
      }
    },
  });
}

export interface LoginSettlement {
  readonly status: "FAILED" | "SUCCEEDED" | "EXPIRED";
  readonly changed: boolean;
  readonly now: Date;
}

/** Call in the same audited transaction as login effects; repeat settlement never rewrites history. */
export async function settleLoginReservation(
  tx: Prisma.TransactionClient,
  reservation: LoginReservation,
  outcome: "FAILED" | "SUCCEEDED",
): Promise<LoginSettlement> {
  if (outcome !== "FAILED" && outcome !== "SUCCEEDED") throw new AuthUnavailableError();
  const rows = await tx.$queryRaw<
    Array<LoginReservation & { status: "RESERVED" | "FAILED" | "SUCCEEDED" | "EXPIRED" }>
  >`
    SELECT id, scope, "ipHash", "accountHash", "requestId", "reservedUntil", status
    FROM "AuthLoginAttempt" WHERE id = ${reservation.id} FOR UPDATE
  `;
  const row = rows[0];
  if (
    !row ||
    row.scope !== reservation.scope ||
    row.ipHash !== reservation.ipHash ||
    row.accountHash !== reservation.accountHash ||
    row.requestId !== reservation.requestId ||
    row.reservedUntil.getTime() !== reservation.reservedUntil.getTime()
  )
    throw new AuthUnavailableError();
  const now = await readAuthClock(tx);
  if (row.status !== "RESERVED") {
    if (row.status !== outcome && row.status !== "EXPIRED") throw new AuthUnavailableError();
    return { status: row.status, changed: false, now };
  }
  const status = row.reservedUntil <= now ? "EXPIRED" : outcome;
  const updated = await tx.authLoginAttempt.updateMany({
    where: { id: row.id, status: "RESERVED" },
    data: { status, completedAt: now },
  });
  if (updated.count !== 1) throw new AuthUnavailableError();
  return { status, changed: true, now };
}
