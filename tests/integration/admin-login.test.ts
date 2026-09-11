// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { compare } from "bcryptjs";
import { describe, expect, it } from "vitest";
import { createCredentialsService } from "@/server/auth/credentials-service";
import { AuthAuthorizationError, AuthUnavailableError } from "@/server/auth/errors";
import {
  createLoginIdentity,
  createLoginThrottle,
  settleLoginReservation,
} from "@/server/auth/login-throttle";
import { createSessionService, hashSessionToken } from "@/server/auth/session-service";
import { resolveClientAddress } from "@/server/ingress";
import type { CredentialsResult, IssuedAuthSession, LoginReservation } from "@/server/auth/types";
import {
  registerCanary,
  runAuthCommand,
  withAuthDatabase,
  type AuthFixture,
} from "../phase011/auth-fixture";

const enabled = Boolean(process.env.PHASE011_FIXTURE_CONFIG);
const clientAddress = "192.0.2.20";
const invalidPassword = "synthetic-incorrect-password";

function success(result: CredentialsResult): IssuedAuthSession {
  expect(result.kind).toBe("SUCCESS");
  if (result.kind !== "SUCCESS") throw new Error("Expected issued session");
  registerCanary({ opaqueToken: result.session.opaqueToken });
  return result.session;
}

// Keep a deliberately broken implementation's principal/token out of assertion diagnostics.
function credentialObservation(result: CredentialsResult) {
  return result.kind === "SUCCESS" ? { kind: result.kind } : result;
}

async function authorizationObservation(operation: Promise<unknown>) {
  try {
    await operation;
    return { outcome: "ACCEPTED" };
  } catch (error: unknown) {
    return {
      outcome: "REJECTED",
      status:
        error instanceof AuthAuthorizationError || error instanceof AuthUnavailableError
          ? error.status
          : null,
    };
  }
}

function services(fixture: AuthFixture) {
  const credentials = createCredentialsService({
    databaseUrl: fixture.url,
    hmacSecret: fixture.config.authSecret,
  });
  const sessions = createSessionService({ databaseUrl: fixture.url });
  return {
    credentials,
    sessions,
    authenticate: (password = fixture.seed.password, audience: "ADMIN" | "USER" = "ADMIN") =>
      credentials.authenticate({ email: fixture.seed.email, password, audience, clientAddress }),
    disconnect: () => Promise.all([credentials.disconnect(), sessions.disconnect()]),
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}

/** Permutation test compares the four interleaved real-cost groups without a normality assumption. */
function timingStatistic(groups: number[][]): {
  permutationP: number;
  medianRatio: number;
  medians: number[];
} {
  const size = groups[0].length;
  const samples = groups.flat();
  const statistic = (values: number[]) => {
    const means = Array.from(
      { length: groups.length },
      (_, index) =>
        values.slice(index * size, (index + 1) * size).reduce((a, b) => a + b, 0) / size,
    );
    const overall = values.reduce((a, b) => a + b, 0) / values.length;
    return means.reduce((sum, value) => sum + (value - overall) ** 2, 0);
  };
  const observed = statistic(samples);
  let state = 0x11a017,
    greater = 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  for (let iteration = 0; iteration < 2_000; iteration++) {
    const shuffled = [...samples];
    for (let index = shuffled.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
    }
    if (statistic(shuffled) >= observed) greater += 1;
  }
  const medians = groups.map(median);
  return {
    permutationP: (greater + 1) / 2_001,
    medianRatio: Math.max(...medians) / Math.min(...medians),
    medians,
  };
}

describe.skipIf(!enabled)("admin-login real PostgreSQL security", () => {
  it("valid-login: real seeded administrator creates one fixed-lifetime session and transactional audit", async () => {
    await withAuthDatabase(async (fixture) => {
      const service = services(fixture);
      try {
        const session = success(
          await service.credentials.authenticate({
            email: ` ${fixture.seed.email.toUpperCase()} `,
            password: fixture.seed.password,
            audience: "ADMIN",
            clientAddress,
          }),
        );
        expect(session.userId === fixture.seed.userId).toBe(true);
        expect(session.expiresAt.getTime() - fixture.clock.getTime()).toBe(43_200_000);
        const user = await fixture.app.user.findUniqueOrThrow({
          where: { id: fixture.seed.userId },
        });
        expect(user.lastLoginAt?.getTime()).toBe(fixture.clock.getTime());
        const stored = await fixture.app.authSession.findFirstOrThrow();
        expect(stored.tokenHash === hashSessionToken(session.opaqueToken)).toBe(true);
        expect(stored.sessionVersion).toBe(user.sessionVersion);
        expect(stored.status).toBe("ACTIVE");
        expect(stored.audience).toBe("ADMIN");
        expect(stored.lastSeenAt).toBeNull();
        expect(stored.revokedAt).toBeNull();
        expect(JSON.stringify(stored).includes(session.opaqueToken)).toBe(false);
        const principal = await service.sessions.validateSession(session.opaqueToken, "ADMIN");
        expect(Object.keys(principal).sort()).toEqual([
          "audience",
          "email",
          "expiresAt",
          "id",
          "role",
        ]);
        expect(principal.role).toBe("ADMIN");
        expect((await fixture.app.authLoginAttempt.findFirstOrThrow()).status).toBe("SUCCEEDED");
        const audits = await fixture.app.auditLog.findMany({ where: { action: "LOGIN_SUCCESS" } });
        expect(audits).toHaveLength(1);
        expect(audits[0].actorEmailSnapshot).toBeNull();
        expect(JSON.stringify(audits).includes(fixture.seed.email)).toBe(false);
        expect(JSON.stringify(audits).includes(clientAddress)).toBe(false);
        expect(JSON.stringify(audits).includes(fixture.seed.password)).toBe(false);
        expect(JSON.stringify(audits).includes(session.opaqueToken)).toBe(false);
        expect(audits[0].detailJson).toMatchObject({
          result: "SUCCESS",
          reasonCode: "LOGIN_ACCEPTED",
          audience: "ADMIN",
          scope: "LOGIN",
        });
      } finally {
        await service.disconnect();
      }
    });
  }, 90_000);

  it("valid-login: schema and application privileges prohibit history edits, weak deadlines and raw identities", async () => {
    await withAuthDatabase(async (fixture) => {
      const service = services(fixture);
      try {
        const session = success(await service.authenticate());
        const row = await fixture.app.authSession.findFirstOrThrow();
        const [role] = await fixture.app.$queryRaw<
          Array<{
            superuser: boolean;
            owner: boolean;
            deleteSession: boolean;
            deleteAttempt: boolean;
          }>
        >`
          SELECT r.rolsuper AS superuser,(d.datdba=r.oid) AS owner,
          has_table_privilege(current_user,'"AuthSession"','DELETE') AS "deleteSession",
          has_table_privilege(current_user,'"AuthLoginAttempt"','DELETE') AS "deleteAttempt"
          FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user
        `;
        expect(role).toEqual({
          superuser: false,
          owner: false,
          deleteSession: false,
          deleteAttempt: false,
        });
        await expect(
          fixture.app.authSession.update({
            where: { id: row.id },
            data: { tokenHash: "f".repeat(64) },
          }),
        ).rejects.toBeDefined();
        await expect(
          fixture.app.authSession.update({
            where: { id: row.id },
            data: { expiresAt: new Date(row.expiresAt.getTime() + 1) },
          }),
        ).rejects.toBeDefined();
        await expect(
          fixture.app.authSession.update({ where: { id: row.id }, data: { status: "EXPIRED" } }),
        ).rejects.toBeDefined();
        await expect(fixture.app.$executeRawUnsafe('TRUNCATE "AuthSession"')).rejects.toBeDefined();
        await expect(
          fixture.app.$executeRawUnsafe('DELETE FROM "AuthLoginAttempt"'),
        ).rejects.toBeDefined();
        await expect(
          fixture.app.$executeRawUnsafe(
            "CREATE OR REPLACE FUNCTION public.auth_now() RETURNS TIMESTAMPTZ LANGUAGE sql AS $$ SELECT now(); $$",
          ),
        ).rejects.toBeDefined();
        await service.sessions.revokeSession(session.opaqueToken);
        await expect(
          fixture.app.authSession.update({
            where: { id: row.id },
            data: { status: "ACTIVE", revokedAt: null },
          }),
        ).rejects.toBeDefined();
        await expect(
          fixture.app.authSession.update({
            where: { id: row.id },
            data: { lastSeenAt: fixture.clock },
          }),
        ).rejects.toBeDefined();
        const base = {
          userId: fixture.seed.userId,
          tokenHash: randomBytes(32).toString("hex"),
          audience: "ADMIN",
          sessionVersion: 0,
          issuedAt: fixture.clock,
          createdAt: fixture.clock,
        };
        for (const expiresAt of [fixture.clock, new Date(fixture.clock.getTime() + 43_200_001)])
          await expect(
            fixture.app.authSession.create({ data: { ...base, expiresAt } }),
          ).rejects.toBeDefined();
        const attempts = await fixture.app.authLoginAttempt.findMany();
        await expect(
          fixture.app.authLoginAttempt.update({
            where: { id: attempts[0].id },
            data: { status: "FAILED", completedAt: fixture.clock },
          }),
        ).rejects.toBeDefined();
        await expect(
          fixture.app.authLoginAttempt.create({
            data: {
              scope: "LOGIN",
              ipHash: "raw-client-address",
              accountHash: "a".repeat(64),
              requestId: randomUUID(),
              createdAt: fixture.clock,
              reservedUntil: new Date(fixture.clock.getTime() + 60_001),
            },
          }),
        ).rejects.toBeDefined();
      } finally {
        await service.disconnect();
      }
    });
  }, 90_000);

  it("uniform-failure: four valid-format failures all perform one real cost12 comparison with indistinguishable result and timing", async () => {
    await withAuthDatabase(async (fixture) => {
      let comparisons = 0;
      const credentials = createCredentialsService({
        databaseUrl: fixture.url,
        hmacSecret: fixture.config.authSecret,
        comparePassword: async (raw, hash) => {
          comparisons += 1;
          return compare(raw, hash);
        },
      });
      const sourceUser = await fixture.app.user.findUniqueOrThrow({
        where: { id: fixture.seed.userId },
      });
      const groups: number[][] = [[], [], [], []];
      try {
        for (let sample = -1; sample < 16; sample++) {
          for (let step = 0; step < 4; step++) {
            const group = (step + sample + 5) % 4;
            const email = `failure-${randomBytes(8).toString("hex")}@example.invalid`;
            registerCanary({ email });
            if (group !== 0)
              await fixture.app.user.create({
                data: {
                  email,
                  passwordHash: sourceUser.passwordHash,
                  role: group === 2 ? "USER" : "ADMIN",
                  status: group === 3 ? "DISABLED" : "ACTIVE",
                },
              });
            const before = comparisons,
              started = performance.now();
            const result = await credentials.authenticate({
              email,
              password: group === 1 ? invalidPassword : fixture.seed.password,
              audience: "ADMIN",
              clientAddress: `192.0.2.${sample + 80}`,
            });
            const elapsed = performance.now() - started;
            expect(result).toEqual({ kind: "INVALID_CREDENTIALS" });
            expect(comparisons - before).toBe(1);
            if (sample >= 0) groups[group].push(elapsed);
          }
        }
        const statistic = timingStatistic(groups);
        console.log(
          JSON.stringify({
            authTiming: {
              samplesPerGroup: 16,
              warmupPerGroup: 1,
              alpha: 0.01,
              maxMedianRatio: 1.5,
              ...statistic,
              samplesMs: groups.map((group) => group.map((value) => Math.round(value))),
            },
          }),
        );
        expect(statistic.medianRatio).toBeLessThanOrEqual(1.5);
        expect(statistic.permutationP).toBeGreaterThanOrEqual(0.01);
        expect(await fixture.app.authSession.count()).toBe(0);
        const audits = await fixture.app.auditLog.findMany({ where: { action: "LOGIN_FAILURE" } });
        expect(audits).toHaveLength(68);
        expect(
          audits.every((audit) => audit.actorEmailSnapshot === null && audit.actorId === null),
        ).toBe(true);
        expect(
          new Set(audits.map((audit) => (audit.detailJson as { reasonCode: string }).reasonCode)),
        ).toEqual(
          new Set(["UNKNOWN_ACCOUNT", "PASSWORD_MISMATCH", "ROLE_NOT_ALLOWED", "ACCOUNT_DISABLED"]),
        );
      } finally {
        await credentials.disconnect();
      }
    });
  }, 180_000);

  it("uniform-failure: bounds prevent bcrypt truncation and client role or session claims cannot authorize a USER", async () => {
    await withAuthDatabase(async (fixture) => {
      let comparisons = 0;
      const credentials = createCredentialsService({
        databaseUrl: fixture.url,
        hmacSecret: fixture.config.authSecret,
        comparePassword: async (raw, hash) => {
          comparisons += 1;
          return compare(raw, hash);
        },
      });
      try {
        for (const password of ["a".repeat(73), "界".repeat(25), "short", "a".repeat(11)])
          expect(
            await credentials.authenticate({
              email: fixture.seed.email,
              password,
              audience: "ADMIN",
              clientAddress,
            }),
          ).toEqual({ kind: "INVALID_CREDENTIALS" });
        expect(comparisons).toBe(0);
        expect(await fixture.app.authLoginAttempt.count()).toBe(0);
        await fixture.app.user.update({
          where: { id: fixture.seed.userId },
          data: { role: "USER" },
        });
        const injected = {
          email: fixture.seed.email,
          password: fixture.seed.password,
          audience: "ADMIN" as const,
          clientAddress,
          role: "ADMIN",
          userId: fixture.seed.userId,
          sessionVersion: 999,
        };
        expect(await credentials.authenticate(injected)).toEqual({ kind: "INVALID_CREDENTIALS" });
        expect(comparisons).toBe(1);
        expect(await fixture.app.authSession.count()).toBe(0);
        expect((await credentials.authenticate({ ...injected, audience: "USER" })).kind).toBe(
          "SUCCESS",
        );
      } finally {
        await credentials.disconnect();
      }
    });
  }, 90_000);

  it("dual-throttle: sixth account and twenty-first IP attempts deny independently; success preserves attack history", async () => {
    await withAuthDatabase(async (fixture) => {
      const service = services(fixture);
      try {
        for (let index = 0; index < 5; index++)
          expect(await service.authenticate(invalidPassword)).toEqual({
            kind: "INVALID_CREDENTIALS",
          });
        expect(await service.authenticate(invalidPassword)).toEqual({
          kind: "RATE_LIMITED",
          retryAfter: 900,
        });
        expect(
          credentialObservation(
            await service.credentials.authenticate({
              email: fixture.seed.email,
              password: fixture.seed.password,
              audience: "ADMIN",
              clientAddress: "203.0.113.10",
            }),
          ),
        ).toEqual({ kind: "RATE_LIMITED", retryAfter: 900 });
        await fixture.setClock(new Date(fixture.clock.getTime() + 900_001));
        success(await service.authenticate());
        for (let index = 0; index < 19; index++) {
          expect(
            await service.credentials.authenticate({
              email: `missing-${index}@example.invalid`,
              password: invalidPassword,
              audience: "ADMIN",
              clientAddress: "203.0.113.20",
            }),
          ).toEqual({ kind: "INVALID_CREDENTIALS" });
        }
        success(
          await service.credentials.authenticate({
            email: fixture.seed.email,
            password: fixture.seed.password,
            audience: "ADMIN",
            clientAddress: "203.0.113.20",
          }),
        );
        expect(
          await service.credentials.authenticate({
            email: "twentieth@example.invalid",
            password: invalidPassword,
            audience: "ADMIN",
            clientAddress: "203.0.113.20",
          }),
        ).toEqual({ kind: "INVALID_CREDENTIALS" });
        expect(
          await service.credentials.authenticate({
            email: "fresh@example.invalid",
            password: invalidPassword,
            audience: "ADMIN",
            clientAddress: "203.0.113.20",
          }),
        ).toEqual({ kind: "RATE_LIMITED", retryAfter: 900 });
        expect(await fixture.app.authLoginAttempt.count({ where: { status: "FAILED" } })).toBe(25);
        const deniedAudits = await fixture.app.auditLog.findMany({
          where: { action: "LOGIN_THROTTLED" },
        });
        expect(deniedAudits).toHaveLength(3);
        expect(
          deniedAudits.every(
            (audit) => (audit.detailJson as { reasonCode: string }).reasonCode === "RATE_LIMITED",
          ),
        ).toBe(true);
      } finally {
        await service.disconnect();
      }
    });
  }, 180_000);

  it("dual-throttle: advisory locks enforce both budgets under parallel independent real connections", async () => {
    await withAuthDatabase(async (fixture) => {
      const throttles = Array.from({ length: 4 }, () =>
        createLoginThrottle({ databaseUrl: fixture.url, hmacSecret: fixture.config.authSecret }),
      );
      try {
        // The first transaction holds an actual bucket lock. Without the production lock the peer bypasses it.
        const identity = createLoginIdentity(
          { account: fixture.seed.email, clientAddress },
          fixture.config.authSecret,
        );
        const lockKey = `serendipity:auth:LOGIN:account:${identity.accountHash}`;
        let release!: () => void, locked!: () => void;
        const ready = new Promise<void>((resolve) => (locked = resolve));
        const wait = new Promise<void>((resolve) => (release = resolve));
        const holding = fixture.admin.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey},0::bigint))`;
          locked();
          await wait;
        });
        await ready;
        let completed = false;
        const admission = throttles[0]
          .admit({ account: fixture.seed.email, clientAddress, requestId: randomUUID() })
          .then((result) => {
            completed = true;
            return result;
          });
        let waitingOnLock = false;
        for (let poll = 0; poll < 30 && !completed; poll++) {
          const [waiter] = await fixture.admin.$queryRaw<Array<{ waiting: boolean }>>`
            SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
              AND usename='phase011_app' AND wait_event_type='Lock' AND wait_event='advisory') AS waiting
          `;
          if (waiter.waiting) {
            waitingOnLock = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const respectedLock = !completed && waitingOnLock;
        release();
        await holding;
        await admission;
        expect(respectedLock).toBe(true);
        const accounts = await Promise.all(
          Array.from({ length: 23 }, (_, index) =>
            throttles[index % 4].admit({
              account: fixture.seed.email,
              clientAddress: `198.51.100.${index + 1}`,
              requestId: randomUUID(),
            }),
          ),
        );
        expect(accounts.filter((result) => result.kind === "RESERVED")).toHaveLength(4);
        expect(accounts.filter((result) => result.kind === "RATE_LIMITED")).toHaveLength(19);
        const ips = await Promise.all(
          Array.from({ length: 28 }, (_, index) =>
            throttles[index % 4].admit({
              account: `budget-${index}@example.invalid`,
              clientAddress: "203.0.113.100",
              requestId: randomUUID(),
            }),
          ),
        );
        expect(ips.filter((result) => result.kind === "RESERVED")).toHaveLength(20);
        expect(ips.filter((result) => result.kind === "RATE_LIMITED")).toHaveLength(8);
        expect(await fixture.app.authLoginAttempt.count()).toBe(25);
      } finally {
        await Promise.all(throttles.map((throttle) => throttle.disconnect()));
      }
    });
  }, 90_000);

  it("dual-throttle: reservation convergence is idempotent and a crashed reservation releases only after its database TTL", async () => {
    await withAuthDatabase(async (fixture) => {
      const throttle = createLoginThrottle({
        databaseUrl: fixture.url,
        hmacSecret: fixture.config.authSecret,
      });
      try {
        const reservations: LoginReservation[] = [];
        for (let index = 0; index < 5; index++) {
          const result = await throttle.admit({
            account: fixture.seed.email,
            clientAddress,
            requestId: randomUUID(),
          });
          if (result.kind !== "RESERVED") throw new Error("Expected live reservation");
          reservations.push(result.reservation);
        }
        expect(
          await throttle.admit({
            account: fixture.seed.email,
            clientAddress,
            requestId: randomUUID(),
          }),
        ).toMatchObject({ kind: "RATE_LIMITED", retryAfter: 60 });
        await expect(
          fixture.app.authLoginAttempt.update({
            where: { id: reservations[0].id },
            data: { status: "EXPIRED", completedAt: new Date(fixture.clock.getTime() + 60_000) },
          }),
        ).rejects.toBeDefined();
        await fixture.setClock(new Date(fixture.clock.getTime() + 59_999));
        expect(
          await throttle.admit({
            account: fixture.seed.email,
            clientAddress,
            requestId: randomUUID(),
          }),
        ).toMatchObject({ kind: "RATE_LIMITED", retryAfter: 1 });
        await fixture.setClock(new Date(fixture.clock.getTime() + 60_000));
        const fresh = await throttle.admit({
          account: fixture.seed.email,
          clientAddress,
          requestId: randomUUID(),
        });
        expect(fresh.kind).toBe("RESERVED");
        expect(await fixture.app.authLoginAttempt.count({ where: { status: "EXPIRED" } })).toBe(5);
        if (fresh.kind !== "RESERVED") throw new Error("Expected renewed reservation");
        const replay = await throttle.admit({
          account: fixture.seed.email,
          clientAddress,
          requestId: fresh.reservation.requestId,
        });
        expect(replay.kind).toBe("RESERVED");
        expect(await fixture.app.authLoginAttempt.count()).toBe(6);
        const first = await fixture.app.$transaction((tx) =>
          settleLoginReservation(tx, fresh.reservation, "FAILED"),
        );
        const second = await fixture.app.$transaction((tx) =>
          settleLoginReservation(tx, fresh.reservation, "FAILED"),
        );
        expect(first.changed).toBe(true);
        expect(second.changed).toBe(false);
        await expect(
          fixture.app.$transaction((tx) =>
            settleLoginReservation(tx, fresh.reservation, "SUCCEEDED"),
          ),
        ).rejects.toBeDefined();
        expect(
          (
            await fixture.app.authLoginAttempt.findUniqueOrThrow({
              where: { id: fresh.reservation.id },
            })
          ).status,
        ).toBe("FAILED");
      } finally {
        await throttle.disconnect();
      }
    });
  }, 90_000);

  it("persistence-proxy: reconnect and independent process retain buckets; forged forwarding cannot select another identity", async () => {
    await withAuthDatabase(async (fixture) => {
      const service = services(fixture);
      for (let index = 0; index < 5; index++)
        expect(await service.authenticate(invalidPassword)).toEqual({
          kind: "INVALID_CREDENTIALS",
        });
      await service.disconnect();
      const rebuilt = services(fixture);
      try {
        expect(await rebuilt.authenticate()).toEqual({ kind: "RATE_LIMITED", retryAfter: 900 });
        const actual = resolveClientAddress({
          directAddress: clientAddress,
          headers: new Headers({
            forwarded: "for=203.0.113.222",
            "x-forwarded-for": "203.0.113.111",
          }),
        });
        expect(actual).toBe(clientAddress);
        const child = await runAuthCommand(
          [
            "--conditions=react-server",
            "--import",
            "tsx",
            path.resolve("tests/phase011/auth-worker.ts"),
          ],
          {
            env: { DATABASE_URL: fixture.url, AUTH_SECRET: fixture.config.authSecret },
            stdin: JSON.stringify({
              mode: "throttle",
              account: fixture.seed.email,
              clientAddress: actual,
            }),
          },
        );
        expect(child.exitCode, child.stderr).toBe(0);
        expect(JSON.parse(child.stdout)).toEqual({ kind: "RATE_LIMITED", retryAfter: 900 });
        expect(
          resolveClientAddress({
            directAddress: "10.0.0.2",
            headers: new Headers({ "x-forwarded-for": "198.51.100.3, 203.0.113.4, 10.0.0.1" }),
            trustedProxyCidrs: ["10.0.0.0/8"],
          }),
        ).toBe("203.0.113.4");
      } finally {
        await rebuilt.disconnect();
      }
    });
  }, 90_000);

  it.each(["version", "role", "status", "expiry", "logout"] as const)(
    "session-revocation: %s change invalidates the old token on the next database check",
    async (change) => {
      await withAuthDatabase(async (fixture) => {
        const service = services(fixture);
        try {
          const first = success(await service.authenticate());
          const second = success(await service.authenticate());
          await expect(
            service.sessions.validateSession(first.opaqueToken, "ADMIN"),
          ).resolves.toMatchObject({ role: "ADMIN" });
          if (change === "version")
            await fixture.app.user.update({
              where: { id: fixture.seed.userId },
              data: { sessionVersion: { increment: 1 } },
            });
          if (change === "role")
            await fixture.app.user.update({
              where: { id: fixture.seed.userId },
              data: { role: "USER" },
            });
          if (change === "status")
            await fixture.app.user.update({
              where: { id: fixture.seed.userId },
              data: { status: "DISABLED" },
            });
          if (change === "expiry") await fixture.setClock(first.expiresAt);
          if (change === "logout") {
            await service.sessions.revokeSession(first.opaqueToken);
            await service.sessions.revokeSession(first.opaqueToken);
            expect(await fixture.app.auditLog.count({ where: { action: "SESSION_LOGOUT" } })).toBe(
              1,
            );
            await expect(
              service.sessions.validateSession(second.opaqueToken, "ADMIN"),
            ).resolves.toMatchObject({ role: "ADMIN" });
          }
          expect(
            await authorizationObservation(
              service.sessions.validateSession(first.opaqueToken, "ADMIN"),
            ),
          ).toEqual({ outcome: "REJECTED", status: 401 });
          if (change === "expiry")
            expect(await fixture.app.authSession.count({ where: { status: "EXPIRED" } })).toBe(1);
          expect(
            JSON.stringify(await fixture.app.authSession.findMany()).includes(first.opaqueToken),
          ).toBe(false);
        } finally {
          await service.disconnect();
        }
      });
    },
    90_000,
  );

  it.each(["passwordHash", "sessionVersion", "role", "status"] as const)(
    "session-revocation: a concurrent %s change between comparison and issuance cannot inherit the prior credential check",
    async (change) => {
      await withAuthDatabase(async (fixture) => {
        const credentials = createCredentialsService({
          databaseUrl: fixture.url,
          hmacSecret: fixture.config.authSecret,
          comparePassword: async (raw, hash) => {
            const matched = await compare(raw, hash);
            const data =
              change === "passwordHash"
                ? { passwordHash: hash.replace(/.$/, hash.endsWith("a") ? "b" : "a") }
                : change === "sessionVersion"
                  ? { sessionVersion: { increment: 1 } }
                  : change === "role"
                    ? { role: "USER" as const }
                    : { status: "DISABLED" as const };
            await fixture.app.user.update({ where: { id: fixture.seed.userId }, data });
            return matched;
          },
        });
        try {
          expect(
            await credentials.authenticate({
              email: fixture.seed.email,
              password: fixture.seed.password,
              audience: "ADMIN",
              clientAddress,
            }),
          ).toEqual({ kind: "INVALID_CREDENTIALS" });
          expect(await fixture.app.authSession.count()).toBe(0);
          expect(
            (await fixture.app.user.findUniqueOrThrow({ where: { id: fixture.seed.userId } }))
              .lastLoginAt,
          ).toBeNull();
        } finally {
          await credentials.disconnect();
        }
      });
    },
    90_000,
  );

  it("guards: real Next request stores and database-backed Route/Action guards precede all resource queries and writes", async () => {
    await withAuthDatabase(async (fixture) => {
      const service = services(fixture);
      try {
        const admin = success(await service.authenticate());
        const user = success(await service.authenticate(fixture.seed.password, "USER"));
        const child = await runAuthCommand(
          [
            "--conditions=react-server",
            "--import",
            "tsx",
            path.resolve("tests/phase011/auth-worker.ts"),
          ],
          {
            env: {
              NODE_ENV: "production",
              DATABASE_URL: fixture.url,
              AUTH_SECRET: fixture.config.authSecret,
            },
            stdin: JSON.stringify({
              mode: "guards",
              adminToken: admin.opaqueToken,
              userToken: user.opaqueToken,
              expiresAt: admin.expiresAt.toISOString(),
            }),
          },
        );
        expect(child.exitCode, child.stderr).toBe(0);
        const result = JSON.parse(child.stdout);
        expect(result).toMatchObject({
          status: "PASS",
          unauthorizedQueries: 0,
          unauthorizedWrites: 0,
          authorizedQueries: 2,
          authorizedWrites: 2,
          revokedRoute: 401,
          revokedAction: 401,
        });
        console.log(JSON.stringify({ guardObservation: result }));
      } finally {
        await service.disconnect();
      }
    });
  }, 90_000);

  it("guards: database, throttle and audit failures fail closed and rollback every session/user success effect", async () => {
    await withAuthDatabase(async (fixture) => {
      const service = services(fixture);
      try {
        await fixture.admin.$executeRawUnsafe('REVOKE INSERT ON "AuditLog" FROM phase011_app');
        expect(await service.authenticate()).toEqual({ kind: "UNAVAILABLE" });
        expect(await fixture.app.authSession.count()).toBe(0);
        expect(
          (await fixture.app.user.findUniqueOrThrow({ where: { id: fixture.seed.userId } }))
            .lastLoginAt,
        ).toBeNull();
        expect((await fixture.app.authLoginAttempt.findFirstOrThrow()).status).toBe("RESERVED");
        await fixture.admin.$executeRawUnsafe('GRANT INSERT ON "AuditLog" TO phase011_app');
        const issued = success(await service.authenticate());
        await fixture.admin.$executeRawUnsafe('REVOKE SELECT ON "AuthSession" FROM phase011_app');
        expect(
          await authorizationObservation(
            service.sessions.validateSession(issued.opaqueToken, "ADMIN"),
          ),
        ).toEqual({ outcome: "REJECTED", status: 503 });
        await fixture.admin.$executeRawUnsafe('GRANT SELECT ON "AuthSession" TO phase011_app');
        await fixture.admin.$executeRawUnsafe(
          'REVOKE SELECT ON "AuthLoginAttempt" FROM phase011_app',
        );
        expect(await service.authenticate()).toEqual({ kind: "UNAVAILABLE" });
        expect(await fixture.app.authSession.count()).toBe(1);
        await fixture.admin.$executeRawUnsafe('GRANT SELECT ON "AuthLoginAttempt" TO phase011_app');
        await fixture.admin.$executeRawUnsafe('REVOKE INSERT ON "AuditLog" FROM phase011_app');
        await expect(service.sessions.revokeSession(issued.opaqueToken)).rejects.toMatchObject({
          status: 503,
        });
        expect((await fixture.app.authSession.findFirstOrThrow()).status).toBe("ACTIVE");
      } finally {
        await service.disconnect();
      }
    });
  }, 90_000);

  it("routing-logout: USER and ADMIN share one service while logout revokes only its current row", async () => {
    await withAuthDatabase(async (fixture) => {
      const service = services(fixture);
      try {
        const administrator = success(await service.authenticate());
        const userAudience = success(await service.authenticate(fixture.seed.password, "USER"));
        expect(
          await authorizationObservation(
            service.sessions.validateSession(userAudience.opaqueToken, "ADMIN"),
          ),
        ).toEqual({ outcome: "REJECTED", status: 403 });
        await expect(
          service.sessions.validateSession(userAudience.opaqueToken, "USER"),
        ).resolves.toMatchObject({ role: "ADMIN", audience: "USER" });
        await service.sessions.revokeSession(administrator.opaqueToken);
        expect(await fixture.app.authSession.count({ where: { status: "REVOKED" } })).toBe(1);
        expect(await fixture.app.authSession.count({ where: { status: "ACTIVE" } })).toBe(1);
      } finally {
        await service.disconnect();
      }
    });
  }, 90_000);
});
