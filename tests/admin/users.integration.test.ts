// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { AdminUserDto, AdminUserPage } from "@/lib/admin-users";
import { ADMIN_USER_FIELDS } from "@/server/projections/admin-user";
import { assertActiveAdminRemains } from "@/server/admin/users";
import {
  ADMIN_USER_OPERATION,
  claimAdminCommand,
  makeAdminCommandIdentity,
  prepareKeyRotationRun,
  reserveAdminCommand,
  saveKeyRotationCheckpoint,
  type AdminCommandClaim,
} from "@/server/admin/command-receipt";
import { createSessionService } from "@/server/auth/session-service";
import { apiKeyFixture } from "../phase010/api-key-fixture";
import {
  createSubject,
  issueSession,
  registerCanary,
  startAdminWorker,
  withAdminDatabase,
  type AdminFixture,
  type AdminWorker,
  type FixtureSession,
  type WorkerResponse,
} from "../phase012/admin-fixture";

const enabled = Boolean(process.env.PHASE012_FIXTURE_CONFIG);
const expectedFields = [
  "id",
  "email",
  "name",
  "avatarUrl",
  "role",
  "status",
  "lastLoginAt",
  "createdAt",
  "revision",
];
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type AdminDtoHasOnlyManagementFields = Assert<
  Equal<keyof AdminUserDto, (typeof ADMIN_USER_FIELDS)[number]>
>;

function key(): string {
  const value = randomUUID();
  registerCanary({ idempotencyKey: value });
  return value;
}

function observe(group: string, observation: Record<string, unknown>): void {
  console.warn(JSON.stringify({ phase: 12, group, database: "REAL_POSTGRESQL17", ...observation }));
}

function claimed(value: AdminCommandClaim | null): AdminCommandClaim {
  expect(value === null).toBe(false);
  if (!value) throw new Error("Expected a new database claim");
  return value;
}

async function rejected(operation: Promise<unknown>): Promise<boolean> {
  try {
    await operation;
    return false;
  } catch {
    return true;
  }
}

function data<T>(response: WorkerResponse): T {
  expect(response.status).toBe(200);
  const body = response.body as { success: boolean; data: T; requestId: string };
  expect(body.success).toBe(true);
  expect(typeof body.requestId).toBe("string");
  return body.data;
}

function failure(response: WorkerResponse, status: number, code?: string) {
  expect(response.status).toBe(status);
  const body = response.body as {
    success: boolean;
    error: {
      code: string;
      details?: { current?: AdminUserDto; currentVersion?: number; action?: string };
    };
  };
  expect(body.success).toBe(false);
  if (code) expect(body.error.code).toBe(code);
  return body.error;
}

function safeUser(user: AdminUserDto): void {
  expect(Object.keys(user).sort()).toEqual([...expectedFields].sort());
  expect(["USER", "ADMIN"]).toContain(user.role);
  expect(["ACTIVE", "DISABLED"]).toContain(user.status);
  expect(Number.isSafeInteger(user.revision) && user.revision >= 0).toBe(true);
  expect(typeof user.createdAt).toBe("string");
  expect(user.lastLoginAt === null || typeof user.lastLoginAt === "string").toBe(true);
}

function sameDto(left: AdminUserDto, right: AdminUserDto): void {
  safeUser(left);
  safeUser(right);
  // Assertion failure must never print a private email from a DTO.
  expect(ADMIN_USER_FIELDS.every((field) => left[field] === right[field])).toBe(true);
}

/** Digest all table rows in PostgreSQL, without bringing credential material into diagnostics. */
async function snapshot(fixture: AdminFixture): Promise<string> {
  const rows = await fixture.admin.$queryRaw<Array<{ relation: string; digest: string }>>`
    SELECT 'User' AS relation,encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') AS digest FROM "User" t
    UNION ALL SELECT 'AuthSession',encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') FROM "AuthSession" t
    UNION ALL SELECT 'AuthLoginAttempt',encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') FROM "AuthLoginAttempt" t
    UNION ALL SELECT 'AuditLog',encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') FROM "AuditLog" t
    UNION ALL SELECT 'AdminCommandReceipt',encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') FROM "AdminCommandReceipt" t
    UNION ALL SELECT 'KeyRotationRun',encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') FROM "KeyRotationRun" t
    UNION ALL SELECT 'ApiKeyConfig',encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') FROM "ApiKeyConfig" t ORDER BY 1,2
  `;
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

interface Harness {
  fixture: AdminFixture;
  worker: AdminWorker;
  actor: FixtureSession;
}
async function withTransport(operation: (harness: Harness) => Promise<void>) {
  return withAdminDatabase(async (fixture) => {
    const actor = await issueSession(fixture, fixture.seed.userId);
    const worker = await startAdminWorker(fixture);
    try {
      await operation({ fixture, worker, actor });
    } finally {
      await worker.close();
    }
  });
}

async function getTarget(
  worker: AdminWorker,
  actor: FixtureSession,
  id: string,
): Promise<AdminUserDto> {
  const page = data<AdminUserPage>(
    await worker.request({ method: "GET", path: "/api/admin/users?limit=100", session: actor }),
  );
  const target = page.items.find((item) => item.id === id);
  expect(Boolean(target)).toBe(true);
  if (!target) throw new Error("Synthetic target is absent");
  safeUser(target);
  return target;
}

function patch(
  worker: AdminWorker,
  actor: FixtureSession,
  user: AdminUserDto,
  changes: Partial<Pick<AdminUserDto, "role" | "status">> = {},
  idempotencyKey = key(),
  reason = "合成管理变更",
) {
  return worker.request({
    method: "PATCH",
    path: `/api/admin/users/${user.id}`,
    session: actor,
    idempotencyKey,
    body: {
      role: user.role,
      status: user.status,
      expectedVersion: user.revision,
      reason,
      ...changes,
    },
  });
}

describe.skipIf(!enabled)("admin/users real PostgreSQL", () => {
  describe("list", () => {
    it("uses the exact projection and stable filtered keyset pages, and rejects invalid cursors and bounds", async () => {
      await withTransport(async ({ fixture, worker, actor }) => {
        const createdAt = new Date("2025-01-01T12:00:00.000Z");
        const seeded = await Promise.all(
          Array.from({ length: 27 }, (_, index) =>
            createSubject(fixture, {
              id: `fixture-user-${String(index).padStart(3, "0")}`,
              createdAt,
              role: index % 5 === 0 ? "ADMIN" : "USER",
              status: index % 4 === 0 ? "DISABLED" : "ACTIVE",
            }),
          ),
        );
        const first = await worker.request({ method: "GET", session: actor });
        const defaultPage = data<AdminUserPage>(first);
        expect(first.headers["cache-control"]).toContain("no-store");
        expect(defaultPage.items).toHaveLength(20);
        for (const item of defaultPage.items) safeUser(item);
        const expected = seeded
          .filter((row) => row.role === "USER" && row.status === "ACTIVE")
          .map((row) => row.id)
          .sort()
          .reverse();
        const seen: string[] = [];
        let cursor: string | null = null,
          firstCursor: string | null = null;
        do {
          const query = new URLSearchParams({ role: "USER", status: "ACTIVE", limit: "4" });
          if (cursor) query.set("cursor", cursor);
          const page = data<AdminUserPage>(
            await worker.request({
              method: "GET",
              path: `/api/admin/users?${query}`,
              session: actor,
            }),
          );
          expect(page.items.length).toBeLessThanOrEqual(4);
          for (const item of page.items) {
            safeUser(item);
            expect(item.role).toBe("USER");
            expect(item.status).toBe("ACTIVE");
            seen.push(item.id);
          }
          cursor = page.nextCursor;
          firstCursor ??= cursor;
        } while (cursor);
        expect(seen).toEqual(expected);
        expect(new Set(seen).size).toBe(expected.length);
        expect(firstCursor).not.toBeNull();
        const observed = await worker.request({
          method: "GET",
          mode: "observed-list",
          session: actor,
        });
        data<AdminUserPage>(observed);
        const statements =
          observed.queries?.filter(
            (query) => /\bSELECT\b/.test(query) && query.includes('"User"'),
          ) ?? [];
        expect(statements.length).toBeGreaterThan(0);
        expect(
          statements.every(
            (query) => !/passwordHash|sessionVersion|phone|SELECT\s+\*/i.test(query),
          ),
        ).toBe(true);
        expect(
          statements.some((query) =>
            expectedFields.every((field) => query.split(/\bFROM\b/i)[0].includes(`"${field}"`)),
          ),
        ).toBe(true);
        for (const query of [
          "role=OWNER",
          "status=DELETED",
          "limit=0",
          "limit=101",
          "limit=1.5",
          "role=USER&role=ADMIN",
          "unknown=1",
          "cursor=invalid",
        ]) {
          failure(
            await worker.request({
              method: "GET",
              path: `/api/admin/users?${query}`,
              session: actor,
            }),
            400,
            "VALIDATION_ERROR",
          );
        }
        const otherFilter = new URLSearchParams({
          role: "ADMIN",
          status: "ACTIVE",
          cursor: firstCursor!,
        });
        failure(
          await worker.request({
            method: "GET",
            path: `/api/admin/users?${otherFilter}`,
            session: actor,
          }),
          400,
          "VALIDATION_ERROR",
        );
        const middle = Math.floor(firstCursor!.length / 2);
        const tampered =
          firstCursor!.slice(0, middle) +
          (firstCursor![middle] === "a" ? "b" : "a") +
          firstCursor!.slice(middle + 1);
        const tamperedQuery = new URLSearchParams({
          role: "USER",
          status: "ACTIVE",
          cursor: tampered,
        });
        failure(
          await worker.request({
            method: "GET",
            path: `/api/admin/users?${tamperedQuery}`,
            session: actor,
          }),
          400,
          "VALIDATION_ERROR",
        );
        const all = data<AdminUserPage>(
          await worker.request({
            method: "GET",
            path: "/api/admin/users?limit=100",
            session: actor,
          }),
        );
        expect(all.items).toHaveLength(28);
        expect(all.nextCursor).toBeNull();
        const peerAdmin = await createSubject(fixture, { role: "ADMIN" });
        const peerSession = await issueSession(fixture, peerAdmin.id);
        const sameFilterOtherOwner = new URLSearchParams({
          role: "USER",
          status: "ACTIVE",
          cursor: firstCursor!,
        });
        failure(
          await worker.request({
            method: "GET",
            path: `/api/admin/users?${sameFilterOtherOwner}`,
            session: peerSession,
          }),
          400,
          "VALIDATION_ERROR",
        );
        observe("list", {
          total: all.items.length,
          filtered: seen.length,
          duplicateIds: seen.length - new Set(seen).size,
          sensitiveColumns: 0,
          invalidInputsRejected: 11,
          crossOwnerCursorRejected: true,
        });
      });
    }, 120_000);
  });

  describe("role-status", () => {
    it("edits the revision from real GET, serializes competing updates, checks CAS before no-op and ignores login timestamps", async () => {
      await withTransport(async ({ fixture, worker, actor }) => {
        const row = await createSubject(fixture);
        const dto = await getTarget(worker, actor, row.id);
        const changed = data<AdminUserDto>(await patch(worker, actor, dto, { role: "ADMIN" }));
        safeUser(changed);
        expect(changed.revision).toBe(dto.revision + 1);
        const after = await fixture.admin.user.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.role).toBe("ADMIN");
        expect(after.sessionVersion).toBe(row.sessionVersion + 1);
        const audits = await fixture.admin.auditLog.findMany({
          where: { action: "USER_UPDATE", targetId: row.id },
        });
        expect(audits).toHaveLength(1);
        expect(audits[0].actorId === fixture.seed.userId).toBe(true);
        expect(audits[0].actorEmailSnapshot === fixture.seed.email).toBe(true);
        expect(audits[0].detailJson).toEqual({
          before: { role: "USER", status: "ACTIVE", revision: 0 },
          after: { role: "ADMIN", status: "ACTIVE", revision: 1 },
          sessionVersionIncremented: true,
          reason: "***",
          result: "SUCCESS",
          reasonCode: "USER_UPDATED",
        });
        const peer = await startAdminWorker(fixture);
        try {
          const race = await Promise.all([
            patch(worker, actor, changed, { role: "USER" }),
            patch(peer, actor, changed, { status: "DISABLED" }),
          ]);
          expect(race.map((response) => response.status).sort()).toEqual([200, 409]);
          const winner = data<AdminUserDto>(race.find((response) => response.status === 200)!);
          const conflict = failure(
            race.find((response) => response.status === 409)!,
            409,
            "VERSION_CONFLICT",
          );
          expect(conflict.details?.currentVersion).toBe(winner.revision);
          expect(conflict.details?.action).toBe("RELOAD");
          sameDto(conflict.details!.current!, winner);
          expect(
            await fixture.admin.auditLog.count({
              where: { action: "USER_UPDATE", targetId: row.id },
            }),
          ).toBe(2);
          const beforeNoop = await fixture.admin.user.findUniqueOrThrow({ where: { id: row.id } });
          const staleNoop = { ...winner, revision: winner.revision - 1 };
          failure(await patch(worker, actor, staleNoop), 409, "VERSION_CONFLICT");
          sameDto(data<AdminUserDto>(await patch(worker, actor, winner)), winner);
          const afterNoop = await fixture.admin.user.findUniqueOrThrow({ where: { id: row.id } });
          expect(afterNoop.revision).toBe(beforeNoop.revision);
          expect(afterNoop.sessionVersion).toBe(beforeNoop.sessionVersion);
          expect(afterNoop.updatedAt.getTime()).toBe(beforeNoop.updatedAt.getTime());
          expect(
            await fixture.admin.auditLog.count({
              where: { action: "USER_UPDATE", targetId: row.id },
            }),
          ).toBe(2);
          await fixture.admin.user.update({
            where: { id: row.id },
            data: { lastLoginAt: new Date(fixture.clock.getTime() + 1000) },
          });
          const next = data<AdminUserDto>(
            await patch(worker, actor, winner, {
              role: winner.role === "ADMIN" ? "USER" : "ADMIN",
            }),
          );
          expect(next.revision).toBe(winner.revision + 1);
          expect(next.lastLoginAt).toBe(new Date(fixture.clock.getTime() + 1000).toISOString());
          safeUser(next);
          const finalAuditCount = await fixture.admin.auditLog.count({
            where: { action: "USER_UPDATE", targetId: row.id },
          });
          expect(finalAuditCount).toBe(3);
          observe("role-status", {
            revisionBefore: dto.revision,
            revisionAfter: next.revision,
            initialVersionBefore: row.sessionVersion,
            initialVersionAfter: after.sessionVersion,
            casRaceStatuses: race.map((response) => response.status).sort(),
            auditCount: finalAuditCount,
            noopIncrement: 0,
          });
        } finally {
          await peer.close();
        }
      });
    }, 120_000);

    it("rejects all unknown enums, duplicate body identifiers, wrong CAS types and unbounded reasons without writes", async () => {
      await withTransport(async ({ fixture, worker, actor }) => {
        const row = await createSubject(fixture);
        const before = await snapshot(fixture);
        const valid = { role: "USER", status: "DISABLED", expectedVersion: 0, reason: "合成原因" };
        for (const input of [
          { ...valid, role: "OWNER" },
          { ...valid, status: "DELETED" },
          { ...valid, userId: row.id },
          { ...valid, expectedUpdatedAt: fixture.clock.toISOString() },
          { ...valid, expectedVersion: -1 },
          { ...valid, expectedVersion: 0.5 },
          { ...valid, expectedVersion: "0" },
          { ...valid, reason: "   " },
          { ...valid, reason: "长".repeat(501) },
        ])
          failure(
            await worker.request({
              method: "PATCH",
              path: `/api/admin/users/${row.id}`,
              session: actor,
              idempotencyKey: key(),
              body: input,
            }),
            400,
            "VALIDATION_ERROR",
          );
        expect(await snapshot(fixture)).toBe(before);
        observe("role-status", { invalidSchemasRejected: 9, invalidSchemaWrites: 0 });
      });
    }, 90_000);

    it("rolls back the user, revocations and receipt if the transactional audit insert fails", async () => {
      await withTransport(async ({ fixture, worker, actor }) => {
        const row = await createSubject(fixture);
        await issueSession(fixture, row.id, "USER");
        const dto = await getTarget(worker, actor, row.id);
        await fixture.admin.$executeRawUnsafe(
          "CREATE FUNCTION public.phase012_reject_user_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='USER_UPDATE' THEN RAISE EXCEPTION 'synthetic audit rejection'; END IF; RETURN NEW; END; $$",
        );
        await fixture.admin.$executeRawUnsafe(
          'CREATE TRIGGER phase012_reject_user_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION public.phase012_reject_user_audit()',
        );
        const before = await snapshot(fixture);
        const result = await patch(worker, actor, dto, { status: "DISABLED" });
        expect(result.status).toBeGreaterThanOrEqual(500);
        expect((result.body as { error: { code: string } }).error.code).toBe("INTERNAL_ERROR");
        expect(await snapshot(fixture)).toBe(before);
        observe("role-status", {
          fault: "AUDIT_INSERT",
          httpStatus: result.status,
          businessChanges: 0,
          revocationChanges: 0,
          receiptChanges: 0,
        });
      });
    }, 90_000);
  });

  describe("self-protection", () => {
    it("rejects every actual self role/status change with zero row changes and permits a versioned no-op", async () => {
      await withTransport(async ({ fixture, worker, actor }) => {
        const dto = await getTarget(worker, actor, fixture.seed.userId);
        const before = await snapshot(fixture);
        for (const changes of [
          { role: "USER" as const },
          { status: "DISABLED" as const },
          { role: "USER" as const, status: "DISABLED" as const },
        ])
          failure(await patch(worker, actor, dto, changes), 403, "FORBIDDEN");
        expect(await snapshot(fixture)).toBe(before);
        const stale = failure(
          await patch(worker, actor, { ...dto, revision: 9 }, { role: "USER" }),
          409,
          "VERSION_CONFLICT",
        );
        sameDto(stale.details!.current!, dto);
        expect(await snapshot(fixture)).toBe(before);
        sameDto(data<AdminUserDto>(await patch(worker, actor, dto)), dto);
        expect(await fixture.admin.auditLog.count({ where: { action: "USER_UPDATE" } })).toBe(0);
        const actual = await fixture.admin.user.findUniqueOrThrow({
          where: { id: dto.id },
          select: { revision: true, sessionVersion: true },
        });
        expect(actual).toEqual({ revision: 0, sessionVersion: 0 });
        observe("self-protection", {
          rejectedChanges: 3,
          rejectedWrites: 0,
          noopRevision: actual.revision,
          noopVersion: actual.sessionVersion,
        });
      });
    }, 90_000);
  });

  describe("last-admin", () => {
    it("enforces the real locked invariant for the sole active administrator independently of the self guard", async () => {
      await withAdminDatabase(async (fixture) => {
        const before = await snapshot(fixture);
        for (const [role, status] of [
          ["USER", "ACTIVE"],
          ["ADMIN", "DISABLED"],
        ] as const) {
          let denied = false;
          try {
            await fixture.app.$transaction(
              async (tx) => {
                await tx.$queryRaw`SELECT id FROM "User" WHERE role='ADMIN' AND status='ACTIVE' ORDER BY id FOR UPDATE`;
                await assertActiveAdminRemains(tx, fixture.seed.userId, role, status);
              },
              { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
            );
          } catch (error) {
            denied = (error as { status?: number }).status === 403;
          }
          expect(
            denied,
            "The locked last-admin invariant must reject the sole administrator removal",
          ).toBe(true);
        }
        expect(await snapshot(fixture)).toBe(before);
        observe("last-admin", {
          isolatedInvariantChecks: 2,
          isolatedRejections: 2,
          databaseChanges: 0,
        });
      });
    }, 90_000);

    it("keeps one active administrator when two authorized processes concurrently disable each other", async () => {
      await withTransport(async ({ fixture, worker, actor }) => {
        const second = await createSubject(fixture, { role: "ADMIN" });
        const otherActor = await issueSession(fixture, second.id);
        const firstDto = await getTarget(worker, actor, fixture.seed.userId),
          secondDto = await getTarget(worker, actor, second.id);
        const peer = await startAdminWorker(fixture);
        let release!: () => void, locked!: () => void;
        const ready = new Promise<void>((resolve) => (locked = resolve));
        const untilReleased = new Promise<void>((resolve) => (release = resolve));
        const held = fixture.admin.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM "User" WHERE role='ADMIN' AND status='ACTIVE' ORDER BY id FOR UPDATE`;
            locked();
            await untilReleased;
          },
          { timeout: 20_000 },
        );
        try {
          await ready;
          const operations = Promise.all([
            patch(worker, actor, secondDto, { status: "DISABLED" }),
            patch(peer, otherActor, firstDto, { status: "DISABLED" }),
          ]);
          let waiters = 0;
          for (let attempt = 0; attempt < 50; attempt++) {
            const [row] = await fixture.admin.$queryRaw<Array<{ count: number }>>`
              SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND usename=${fixture.config.appUser} AND wait_event_type='Lock'
            `;
            waiters = row.count;
            if (waiters >= 2) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          release();
          await held;
          const results = await operations;
          expect(waiters).toBeGreaterThanOrEqual(2);
          expect(results.filter((response) => response.status === 200)).toHaveLength(1);
          expect(
            results.filter((response) => [401, 403, 409].includes(response.status)),
          ).toHaveLength(1);
          expect(
            await fixture.admin.user.count({ where: { role: "ADMIN", status: "ACTIVE" } }),
          ).toBe(1);
          expect(await fixture.admin.auditLog.count({ where: { action: "USER_UPDATE" } })).toBe(1);
          expect(
            await fixture.admin.adminCommandReceipt.count({ where: { status: "SUCCEEDED" } }),
          ).toBe(1);
          observe("last-admin", {
            schedule: "BOTH_REAL_ROUTES_WAIT_ON_HELD_ADMIN_SET_THEN_RELEASE",
            databaseLockWaiters: waiters,
            raceStatuses: results.map((response) => response.status).sort(),
            survivingActiveAdmins: 1,
            auditCount: 1,
          });
        } finally {
          release?.();
          await held;
          await peer.close();
        }
      });
    }, 120_000);
  });

  describe("session", () => {
    it("increments the revocation version and rejects old tokens even when their database rows are active", async () => {
      await withTransport(async ({ fixture, worker, actor }) => {
        const target = await createSubject(fixture, { role: "ADMIN" });
        const tokens = await Promise.all([
          issueSession(fixture, target.id),
          issueSession(fixture, target.id),
          issueSession(fixture, target.id, "USER"),
          issueSession(fixture, target.id, "USER"),
        ]);
        const sessions = createSessionService({ databaseUrl: fixture.url });
        try {
          for (const token of tokens)
            expect(
              (await sessions.validateSession(token.opaqueToken, token.audience)).id === target.id,
            ).toBe(true);
          const dto = await getTarget(worker, actor, target.id);
          const changed = data<AdminUserDto>(await patch(worker, actor, dto, { role: "USER" }));
          const after = await fixture.admin.user.findUniqueOrThrow({
            where: { id: target.id },
            select: { revision: true, sessionVersion: true },
          });
          expect(
            after.sessionVersion,
            "A role/status change must increment the revocation version independently of row revocation",
          ).toBe(target.sessionVersion + 1);
          expect(after.revision).toBe(target.revision + 1);
          const stored = await fixture.admin.authSession.findMany({
            where: { userId: target.id },
            select: { status: true, revokedAt: true },
          });
          expect(stored).toHaveLength(4);
          expect(
            stored.every(
              (row) =>
                row.status === "REVOKED" && row.revokedAt?.getTime() === fixture.clock.getTime(),
            ),
          ).toBe(true);
          failure(
            await worker.request({ method: "GET", session: tokens[0] }),
            401,
            "AUTH_REQUIRED",
          );
          for (const token of tokens) {
            let rejected = false;
            try {
              await sessions.validateSession(token.opaqueToken, token.audience);
            } catch (error) {
              rejected = (error as { status?: number }).status === 401;
            }
            expect(rejected).toBe(true);
          }
          // An in-flight old-version issue is deliberately ACTIVE after the revocation UPDATE.
          // USER audience avoids a role downgrade independently masking the version comparison.
          const staleActive = await issueSession(fixture, target.id, "USER", target.sessionVersion);
          let rejectedVersion = false;
          try {
            await sessions.validateSession(staleActive.opaqueToken, "USER");
          } catch (error) {
            rejectedVersion = (error as { status?: number }).status === 401;
          }
          expect(
            rejectedVersion,
            "An ACTIVE old-version USER session must not survive the role change",
          ).toBe(true);
          const current = await issueSession(fixture, target.id, "USER");
          expect(
            (await sessions.validateSession(current.opaqueToken, "USER")).id === target.id,
          ).toBe(true);
          sameDto(data<AdminUserDto>(await patch(worker, actor, changed)), changed);
          const unchanged = await fixture.admin.user.findUniqueOrThrow({
            where: { id: target.id },
            select: { sessionVersion: true },
          });
          expect(unchanged.sessionVersion).toBe(after.sessionVersion);
          expect(
            (await sessions.validateSession(current.opaqueToken, "USER")).id === target.id,
          ).toBe(true);
          const disabled = data<AdminUserDto>(
            await patch(worker, actor, changed, { status: "DISABLED" }),
          );
          const restored = data<AdminUserDto>(
            await patch(worker, actor, disabled, { status: "ACTIVE" }),
          );
          expect(restored.revision).toBe(changed.revision + 2);
          const final = await fixture.admin.user.findUniqueOrThrow({
            where: { id: target.id },
            select: { sessionVersion: true },
          });
          expect(final.sessionVersion).toBe(after.sessionVersion + 2);
          let survivedReenable = false;
          try {
            await sessions.validateSession(current.opaqueToken, "USER");
            survivedReenable = true;
          } catch {
            // The previous token is expected to remain invalid after re-enabling the account.
          }
          expect(survivedReenable).toBe(false);
          observe("session", {
            versionBefore: target.sessionVersion,
            versionAfterFirstChange: after.sessionVersion,
            versionAfterDisableReenable: final.sessionVersion,
            oldRowsRevoked: stored.length,
            oldTokenRejections: tokens.length,
            activeOldVersionRejected: rejectedVersion,
            noopVersionIncrement: 0,
            survivesReenable: survivedReenable,
          });
        } finally {
          await sessions.disconnect();
        }
      });
    }, 120_000);
    it("rejects expired and revoked principals and preserves both terminal row states", async () => {
      await withTransport(async ({ fixture, worker }) => {
        const revokedToken = await issueSession(fixture, fixture.seed.userId);
        const expiredToken = await issueSession(fixture, fixture.seed.userId);
        const sessions = createSessionService({ databaseUrl: fixture.url });
        try {
          await sessions.revokeSession(revokedToken.opaqueToken);
          failure(
            await worker.request({ method: "GET", session: revokedToken }),
            401,
            "AUTH_REQUIRED",
          );
          const revokedRow = await fixture.admin.authSession.findUniqueOrThrow({
            where: {
              tokenHash: createHash("sha256").update(revokedToken.opaqueToken).digest("hex"),
            },
          });
          expect(revokedRow.status).toBe("REVOKED");
          await fixture.setClock(new Date(expiredToken.expiresAt));
          failure(
            await worker.request({ method: "GET", session: expiredToken }),
            401,
            "AUTH_REQUIRED",
          );
          const expiredRow = await fixture.admin.authSession.findUniqueOrThrow({
            where: {
              tokenHash: createHash("sha256").update(expiredToken.opaqueToken).digest("hex"),
            },
          });
          expect(expiredRow.status).toBe("EXPIRED");
          const beforeMutation = await snapshot(fixture);
          for (const row of [revokedRow, expiredRow]) {
            expect(
              await rejected(
                fixture.app.authSession.update({
                  where: { id: row.id },
                  data: { status: "ACTIVE", revokedAt: null },
                }),
              ),
            ).toBe(true);
            expect(
              await rejected(
                fixture.admin.authSession.update({
                  where: { id: row.id },
                  data: { lastSeenAt: new Date(expiredToken.expiresAt) },
                }),
              ),
            ).toBe(true);
            expect(await rejected(fixture.app.authSession.delete({ where: { id: row.id } }))).toBe(
              true,
            );
          }
          expect(await snapshot(fixture)).toBe(beforeMutation);
          observe("session", {
            revokedPrincipalStatus: 401,
            expiredPrincipalStatus: 401,
            revokedRowStatus: revokedRow.status,
            expiredRowStatus: expiredRow.status,
            terminalMutationRejections: 6,
            terminalRowChanges: 0,
          });
        } finally {
          await sessions.disconnect();
        }
      });
    }, 120_000);

    it("rechecks the actor after a real advisory-lock wait and rolls back when logout wins", async () => {
      await withTransport(async ({ fixture, worker, actor }) => {
        const target = await createSubject(fixture);
        const dto = await getTarget(worker, actor, target.id);
        const sessions = createSessionService({ databaseUrl: fixture.url });
        let release!: () => void, locked!: () => void;
        const ready = new Promise<void>((resolve) => (locked = resolve));
        const untilReleased = new Promise<void>((resolve) => (release = resolve));
        const held = fixture.admin.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('serendipity:admin-users:v1', 0::bigint))`;
            locked();
            await untilReleased;
          },
          { timeout: 20_000 },
        );
        try {
          await ready;
          const waitingMutation = patch(worker, actor, dto, { status: "DISABLED" });
          let waiters = 0;
          for (let attempt = 0; attempt < 50; attempt++) {
            const [row] = await fixture.admin.$queryRaw<Array<{ count: number }>>`
              SELECT count(*)::int AS count FROM pg_stat_activity
              WHERE datname=current_database() AND usename=${fixture.config.appUser}
                AND wait_event_type='Lock' AND wait_event='advisory'
            `;
            waiters = row.count;
            if (waiters > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          // The real route has passed its outside authentication and is waiting inside the transaction.
          await sessions.revokeSession(actor.opaqueToken);
          const afterLogout = await snapshot(fixture);
          release();
          await held;
          const denied = await waitingMutation;
          expect(waiters).toBeGreaterThan(0);
          failure(denied, 401, "AUTH_REQUIRED");
          expect(await snapshot(fixture)).toBe(afterLogout);
          expect(await fixture.admin.auditLog.count({ where: { action: "SESSION_LOGOUT" } })).toBe(
            1,
          );
          expect(await fixture.admin.auditLog.count({ where: { action: "USER_UPDATE" } })).toBe(0);
          expect(await fixture.admin.adminCommandReceipt.count()).toBe(0);
          observe("session", {
            schedule: "AUTHORIZED_PATCH_WAITS_THEN_REAL_LOGOUT_COMMITS_BEFORE_LOCK_RELEASE",
            lockWaiters: waiters,
            requestStatusAfterLogout: denied.status,
            logoutAuditCount: 1,
            businessWritesAfterLogout: 0,
            userUpdateAuditCount: 0,
            receiptCount: 0,
          });
        } finally {
          release?.();
          await held;
          await sessions.disconnect();
        }
      });
    }, 120_000);
  });

  describe("authorization-idempotency", () => {
    it("authorizes before target queries and rejects absent, ordinary, disabled, old-version or non-CSRF identities without changes", async () => {
      await withTransport(async ({ fixture, worker, actor }) => {
        const target = await createSubject(fixture);
        const ordinary = await issueSession(fixture, target.id, "USER");
        const disabled = await createSubject(fixture, { role: "ADMIN", status: "DISABLED" });
        const disabledToken = await issueSession(fixture, disabled.id);
        const old = await createSubject(fixture, { role: "ADMIN" });
        const oldToken = await issueSession(fixture, old.id);
        await fixture.admin.user.update({
          where: { id: old.id },
          data: { sessionVersion: { increment: 1 } },
        });
        const body = {
          role: "USER",
          status: "DISABLED",
          expectedVersion: 0,
          reason: "合成授权检查",
        };
        const before = await snapshot(fixture);
        let rejected = 0;
        for (const [session, status] of [
          [undefined, 401],
          [ordinary, 403],
          [disabledToken, 401],
          [oldToken, 401],
        ] as const) {
          failure(
            await worker.request({ method: "GET", session }),
            status,
            status === 401 ? "AUTH_REQUIRED" : "FORBIDDEN",
          );
          rejected++;
          for (const id of [target.id, "missing-synthetic-user"]) {
            failure(
              await worker.request({
                method: "PATCH",
                path: `/api/admin/users/${id}`,
                session,
                idempotencyKey: key(),
                body,
              }),
              status,
              status === 401 ? "AUTH_REQUIRED" : "FORBIDDEN",
            );
            rejected++;
          }
        }
        for (const invalid of [
          { csrf: "missing" as const },
          { csrf: "mismatch" as const },
          { origin: "https://cross-origin.invalid" },
        ]) {
          failure(
            await worker.request({
              method: "PATCH",
              path: `/api/admin/users/${target.id}`,
              session: actor,
              idempotencyKey: key(),
              body,
              ...invalid,
            }),
            403,
            "FORBIDDEN",
          );
          rejected++;
        }
        failure(
          await worker.request({
            method: "PATCH",
            path: `/api/admin/users/${target.id}`,
            session: actor,
            body,
          }),
          400,
          "VALIDATION_ERROR",
        );
        failure(
          await worker.request({
            method: "PATCH",
            path: "/api/admin/users/missing-synthetic-user",
            session: actor,
            idempotencyKey: key(),
            body,
          }),
          404,
          "NOT_FOUND",
        );
        expect(await snapshot(fixture)).toBe(before);
        observe("authorization-idempotency", {
          rejectedAuthorizationRequests: rejected,
          objectExistenceLeaks: 0,
          unauthorizedWrites: 0,
          missingIdempotencyRejected: true,
        });
      });
    }, 120_000);

    it("distinguishes a successful empty result from a real database read failure", async () => {
      await withTransport(async ({ fixture, worker, actor }) => {
        const empty = data<AdminUserPage>(
          await worker.request({
            method: "GET",
            path: "/api/admin/users?role=USER&status=DISABLED",
            session: actor,
          }),
        );
        expect(empty.items).toHaveLength(0);
        expect(empty.nextCursor).toBeNull();
        const appUser = fixture.config.appUser;
        expect(appUser).toMatch(/^phase(?:012|013|014)_app$/);
        await fixture.admin.$executeRawUnsafe(`REVOKE SELECT ON TABLE "User" FROM "${appUser}"`);
        await fixture.admin.$executeRawUnsafe(
          `GRANT SELECT (id,email,role,status,"sessionVersion") ON TABLE "User" TO "${appUser}"`,
        );
        try {
          const unavailable = await worker.request({ method: "GET", session: actor });
          expect(unavailable.status).toBeGreaterThanOrEqual(500);
          expect((unavailable.body as { success: boolean; error: { code: string } }).success).toBe(
            false,
          );
          expect((unavailable.body as { error: { code: string } }).error.code).toBe(
            "INTERNAL_ERROR",
          );
          observe("authorization-idempotency", {
            emptyResultStatus: 200,
            databaseFailureStatus: unavailable.status,
            databaseErrorMisrepresentedAsEmpty: false,
          });
        } finally {
          await fixture.admin.$executeRawUnsafe(`GRANT SELECT ON TABLE "User" TO "${appUser}"`);
        }
      });
    }, 90_000);

    it("replays the original response after process restart and later updates, rejects changed payloads and freezes terminal receipts", async () => {
      await withAdminDatabase(async (fixture) => {
        const actor = await issueSession(fixture, fixture.seed.userId);
        const target = await createSubject(fixture);
        let worker = await startAdminWorker(fixture);
        try {
          const initial = await getTarget(worker, actor, target.id);
          const requestKey = key();
          const originalResponse = await patch(
            worker,
            actor,
            initial,
            { status: "DISABLED" },
            requestKey,
          );
          expect(originalResponse.headers["idempotency-replayed"]).toBe("false");
          const response = data<AdminUserDto>(originalResponse);
          await worker.close();
          worker = await startAdminWorker(fixture);
          const firstReplay = await patch(
            worker,
            actor,
            initial,
            { status: "DISABLED" },
            requestKey,
            "  合成管理变更  ",
          );
          expect(firstReplay.headers["idempotency-replayed"]).toBe("true");
          sameDto(data<AdminUserDto>(firstReplay), response);
          const restored = data<AdminUserDto>(
            await patch(worker, actor, response, { status: "ACTIVE" }),
          );
          expect(restored.revision).toBe(2);
          const secondReplay = await patch(
            worker,
            actor,
            initial,
            { status: "DISABLED" },
            requestKey,
          );
          expect(secondReplay.headers["idempotency-replayed"]).toBe("true");
          sameDto(data<AdminUserDto>(secondReplay), response);
          const beforeConflict = await snapshot(fixture);
          failure(
            await patch(worker, actor, initial, { status: "DISABLED" }, requestKey, "另一合成原因"),
            409,
            "IDEMPOTENCY_KEY_REUSED",
          );
          failure(
            await patch(worker, actor, initial, { role: "ADMIN" }, requestKey),
            409,
            "IDEMPOTENCY_KEY_REUSED",
          );
          expect(await snapshot(fixture)).toBe(beforeConflict);
          const receipts = await fixture.admin.adminCommandReceipt.findMany({
            where: {
              ownerUserId: fixture.seed.userId,
              resourceId: target.id,
              operationId: ADMIN_USER_OPERATION,
            },
          });
          expect(receipts).toHaveLength(2);
          const receipt = receipts.find(
            (row) => row.responseJson && (row.responseJson as { revision?: number }).revision === 1,
          )!;
          expect(receipt.status).toBe("SUCCEEDED");
          expect(/^[a-f0-9]{64}$/.test(receipt.idempotencyKeyHash)).toBe(true);
          expect(/^[a-f0-9]{64}$/.test(receipt.requestHash)).toBe(true);
          expect(JSON.stringify(receipts).includes(requestKey)).toBe(false);
          sameDto(receipt.responseJson as unknown as AdminUserDto, response);
          expect(receipt.completedAt === null).toBe(false);
          expect(
            receipt.expiresAt.getTime() - receipt.completedAt!.getTime(),
          ).toBeGreaterThanOrEqual(86_400_000);
          for (const mutation of [
            { responseJson: { overwritten: true } },
            { requestHash: "f".repeat(64) },
            { status: "PENDING" as const, completedAt: null },
            { expiresAt: new Date(receipt.completedAt!.getTime() + 86_399_999) },
          ])
            expect(
              await rejected(
                fixture.app.adminCommandReceipt.update({
                  where: { id: receipt.id },
                  data: mutation,
                }),
              ),
            ).toBe(true);
          expect(
            await rejected(fixture.admin.adminCommandReceipt.delete({ where: { id: receipt.id } })),
          ).toBe(true);
          await expect(
            fixture.app.$executeRawUnsafe('TRUNCATE "AdminCommandReceipt"'),
          ).rejects.toBeDefined();
          expect(await snapshot(fixture)).toBe(beforeConflict);
          const forged = makeAdminCommandIdentity({
            ownerUserId: fixture.seed.userId,
            operationId: ADMIN_USER_OPERATION,
            resourceId: target.id,
            idempotencyKey: key(),
            payload: {
              role: initial.role,
              status: "DISABLED",
              expectedVersion: initial.revision,
              reason: "合成管理变更",
            },
          });
          const normalized = await fixture.app.adminCommandReceipt.create({
            data: {
              ...forged,
              status: "SUCCEEDED",
              responseJson: { ...response },
              createdAt: fixture.clock,
              availableAt: fixture.clock,
              completedAt: fixture.clock,
              expiresAt: new Date(fixture.clock.getTime() + 86_399_999),
            },
          });
          expect(normalized.completedAt?.getTime()).toBe(fixture.clock.getTime());
          expect(normalized.expiresAt.getTime()).toBeGreaterThanOrEqual(
            fixture.clock.getTime() + 86_400_000,
          );
          expect(
            await rejected(
              fixture.admin.adminCommandReceipt.delete({ where: { id: normalized.id } }),
            ),
          ).toBe(true);
          expect(
            await fixture.admin.auditLog.count({
              where: { action: "USER_UPDATE", targetId: target.id },
            }),
          ).toBe(2);
          observe("authorization-idempotency", {
            processRestarts: 1,
            originalResponseReplays: 2,
            payloadConflicts: 2,
            originalResponseRevision: response.revision,
            currentRevision: restored.revision,
            receipts: receipts.length,
            auditCount: 2,
            terminalMutationRejections: 6,
            insertionMinimumRetentionNormalized: true,
            normalizedInsertionImmediatelyDeletable: false,
            minimumTerminalHours: 24,
          });
        } finally {
          await worker.close();
        }
      });
    }, 120_000);

    it("converges simultaneous same-key requests to one immutable effect and separates owner/resource domains", async () => {
      await withTransport(async ({ fixture, worker, actor }) => {
        const target = await createSubject(fixture);
        const dto = await getTarget(worker, actor, target.id);
        const peer = await startAdminWorker(fixture);
        try {
          const requestKey = key();
          const responses = await Promise.all(
            Array.from({ length: 6 }, (_, index) =>
              patch(index % 2 ? peer : worker, actor, dto, { status: "DISABLED" }, requestKey),
            ),
          );
          expect(responses.map((response) => response.status)).toEqual([
            200, 200, 200, 200, 200, 200,
          ]);
          expect(
            responses.filter((response) => response.headers["idempotency-replayed"] === "false"),
          ).toHaveLength(1);
          expect(
            responses.filter((response) => response.headers["idempotency-replayed"] === "true"),
          ).toHaveLength(5);
          const first = data<AdminUserDto>(responses[0]);
          for (const response of responses) sameDto(data<AdminUserDto>(response), first);
          expect(
            await fixture.admin.adminCommandReceipt.count({ where: { resourceId: target.id } }),
          ).toBe(1);
          expect(
            await fixture.admin.auditLog.count({
              where: { action: "USER_UPDATE", targetId: target.id },
            }),
          ).toBe(1);
          const actual = await fixture.admin.user.findUniqueOrThrow({
            where: { id: target.id },
            select: { revision: true, sessionVersion: true },
          });
          expect(actual).toEqual({ revision: 1, sessionVersion: 1 });
          const secondTarget = await createSubject(fixture);
          const secondDto = await getTarget(worker, actor, secondTarget.id);
          const second = data<AdminUserDto>(
            await patch(worker, actor, secondDto, { status: "DISABLED" }, requestKey),
          );
          expect(second.revision).toBe(1);
          const secondAdmin = await createSubject(fixture, { role: "ADMIN" });
          const secondActor = await issueSession(fixture, secondAdmin.id);
          sameDto(data<AdminUserDto>(await patch(peer, secondActor, first, {}, requestKey)), first);
          expect(
            await fixture.admin.adminCommandReceipt.count({ where: { resourceId: target.id } }),
          ).toBe(2);
          observe("authorization-idempotency", {
            schedule: "SIX_PARALLEL_REQUESTS_ACROSS_TWO_PROCESSES",
            sameKeySuccesses: responses.length,
            replayedResponses: responses.filter(
              (response) => response.headers["idempotency-replayed"] === "true",
            ).length,
            businessEffects: 1,
            auditCount: 1,
            finalRevision: actual.revision,
            finalVersion: actual.sessionVersion,
            separateOwnerDomain: true,
            separateResourceDomain: true,
          });
        } finally {
          await peer.close();
        }
      });
    }, 120_000);

    it("rolls back the mutation and audit if the terminal receipt write fails", async () => {
      await withTransport(async ({ fixture, worker, actor }) => {
        const target = await createSubject(fixture);
        await issueSession(fixture, target.id, "USER");
        const dto = await getTarget(worker, actor, target.id);
        await fixture.admin.$executeRawUnsafe(
          "CREATE FUNCTION public.phase012_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='SUCCEEDED' THEN RAISE EXCEPTION 'synthetic receipt failure'; END IF; RETURN NEW; END; $$",
        );
        await fixture.admin.$executeRawUnsafe(
          'CREATE TRIGGER phase012_reject_receipt BEFORE INSERT OR UPDATE ON "AdminCommandReceipt" FOR EACH ROW EXECUTE FUNCTION public.phase012_reject_receipt()',
        );
        const before = await snapshot(fixture);
        const response = await patch(worker, actor, dto, { status: "DISABLED" });
        expect(response.status).toBeGreaterThanOrEqual(500);
        expect(await snapshot(fixture)).toBe(before);
        observe("authorization-idempotency", {
          fault: "TERMINAL_RECEIPT_WRITE",
          httpStatus: response.status,
          userChanges: 0,
          revocationChanges: 0,
          auditChanges: 0,
          receiptChanges: 0,
        });
      });
    }, 90_000);

    it("requires a live claim for every state update and bases retention on real completion rather than backfilled creation time", async () => {
      await withAdminDatabase(async (fixture) => {
        const identity = () =>
          makeAdminCommandIdentity({
            ownerUserId: fixture.seed.userId,
            operationId: "post.admin.keys.id.rotate",
            resourceId: "synthetic-retention-probe",
            idempotencyKey: key(),
            payload: { expectedVersion: 0, keyFingerprint: "d".repeat(64) },
          });
        const receipt = await fixture.app.$transaction((tx) => reserveAdminCommand(tx, identity()));
        const completion = (now: Date) => ({
          status: "SUCCEEDED" as const,
          responseJson: { result: "SUCCESS" },
          completedAt: now,
          expiresAt: new Date(now.getTime() + 86_400_000),
          leaseOwner: null,
          leaseUntil: null,
        });
        const context = async (tx: Prisma.TransactionClient, claim: AdminCommandClaim) => {
          await tx.$executeRaw`SELECT set_config('serendipity.admin_lease_owner', ${claim.leaseOwner}, true),set_config('serendipity.admin_fencing_token', ${String(claim.fencingToken)}, true)`;
        };
        const pendingSnapshot = await snapshot(fixture);
        for (const update of [
          completion(fixture.clock),
          {
            status: "FAILED" as const,
            errorCode: "SYNTHETIC_FAILURE",
            completedAt: fixture.clock,
            expiresAt: new Date(fixture.clock.getTime() + 86_400_000),
          },
          { status: "RETRY_WAIT" as const, availableAt: fixture.clock },
        ])
          expect(
            await rejected(
              fixture.app.adminCommandReceipt.update({ where: { id: receipt.id }, data: update }),
            ),
          ).toBe(true);
        expect(await snapshot(fixture)).toBe(pendingSnapshot);
        const original = claimed(
          await fixture.app.$transaction((tx) =>
            claimAdminCommand(tx, {
              receiptId: receipt.id,
              leaseOwner: "fixture-claim-a",
              leaseMs: 1_000,
            }),
          ),
        );
        await fixture.setClock(new Date(original.leaseUntil.getTime()));
        const current = claimed(
          await fixture.app.$transaction((tx) =>
            claimAdminCommand(tx, {
              receiptId: receipt.id,
              leaseOwner: "fixture-claim-b",
              leaseMs: 10_000,
            }),
          ),
        );
        expect(current.fencingToken).toBe(original.fencingToken + 1);
        const retryAt = new Date(original.leaseUntil.getTime() + 1_000);
        await fixture.app.$transaction(async (tx) => {
          await context(tx, current);
          await tx.adminCommandReceipt.update({
            where: { id: receipt.id },
            data: {
              status: "RETRY_WAIT",
              availableAt: retryAt,
              leaseOwner: null,
              leaseUntil: null,
            },
          });
        });
        const retrySnapshot = await snapshot(fixture);
        for (const staleClaim of [original, current]) {
          expect(
            await rejected(
              fixture.app.$transaction(async (tx) => {
                await context(tx, staleClaim);
                await tx.adminCommandReceipt.update({
                  where: { id: receipt.id },
                  data: completion(new Date(original.leaseUntil.getTime())),
                });
              }),
            ),
          ).toBe(true);
        }
        expect(await snapshot(fixture)).toBe(retrySnapshot);
        const retainedRetry = await fixture.app.adminCommandReceipt.findUniqueOrThrow({
          where: { id: receipt.id },
          select: { status: true, fencingToken: true, attemptCount: true, responseJson: true },
        });
        expect(retainedRetry).toEqual({
          status: "RETRY_WAIT",
          fencingToken: 2,
          attemptCount: 2,
          responseJson: null,
        });
        await fixture.setClock(retryAt);
        const resumed = claimed(
          await fixture.app.$transaction((tx) =>
            claimAdminCommand(tx, {
              receiptId: receipt.id,
              leaseOwner: "fixture-claim-c",
              leaseMs: 10_000,
            }),
          ),
        );
        expect(resumed.fencingToken).toBe(3);
        const beforeFuture = await snapshot(fixture);
        expect(
          await rejected(
            fixture.app.$transaction(async (tx) => {
              await context(tx, resumed);
              await tx.adminCommandReceipt.update({
                where: { id: receipt.id },
                data: completion(new Date(retryAt.getTime() + 1)),
              });
            }),
          ),
        ).toBe(true);
        expect(await snapshot(fixture)).toBe(beforeFuture);
        await fixture.app.$transaction(async (tx) => {
          await context(tx, resumed);
          await tx.adminCommandReceipt.update({
            where: { id: receipt.id },
            data: completion(retryAt),
          });
        });
        const completed = await fixture.app.adminCommandReceipt.findUniqueOrThrow({
          where: { id: receipt.id },
          select: { status: true, fencingToken: true, completedAt: true },
        });
        expect(completed).toEqual({ status: "SUCCEEDED", fencingToken: 3, completedAt: retryAt });
        const oldPending = await fixture.app.$transaction((tx) =>
          reserveAdminCommand(tx, identity()),
        );
        const lateNow = new Date(oldPending.createdAt.getTime() + 172_800_000);
        await fixture.setClock(lateNow);
        expect(oldPending.expiresAt.getTime()).toBeLessThan(lateNow.getTime());
        const lateClaim = claimed(
          await fixture.app.$transaction((tx) =>
            claimAdminCommand(tx, {
              receiptId: oldPending.id,
              leaseOwner: "fixture-late-completion",
              leaseMs: 10_000,
            }),
          ),
        );
        const lateCompleted = await fixture.app.$transaction(async (tx) => {
          await context(tx, lateClaim);
          return tx.adminCommandReceipt.update({
            where: { id: oldPending.id },
            data: {
              ...completion(oldPending.createdAt),
              expiresAt: oldPending.expiresAt,
            },
          });
        });
        expect(lateCompleted.completedAt?.getTime()).toBe(lateNow.getTime());
        expect(lateCompleted.expiresAt.getTime()).toBeGreaterThanOrEqual(
          lateNow.getTime() + 86_400_000,
        );
        expect(
          await rejected(
            fixture.admin.adminCommandReceipt.delete({ where: { id: oldPending.id } }),
          ),
        ).toBe(true);
        observe("authorization-idempotency", {
          pendingUnclaimedTransitionRejections: 3,
          schedule: "A_FENCE1_EXPIRES_B_FENCE2_REQUEUES_A_AND_B_CANNOT_FINISH_WITHOUT_NEW_CLAIM",
          retryWaitUnclaimedCompletionRejections: 2,
          successfulFence: resumed.fencingToken,
          futureCompletionRejected: true,
          oldPendingAgeHours: 48,
          completionBackfillNormalized: lateCompleted.completedAt?.getTime() === lateNow.getTime(),
          retainedHoursAfterRealCompletion:
            (lateCompleted.expiresAt.getTime() - lateNow.getTime()) / 3_600_000,
          immediatelyDeletable: false,
        });
      });
    }, 120_000);

    it("persists preparation before testing, atomically rolls back partial candidates and fences resumed checkpoints with retained audit references", async () => {
      await withAdminDatabase(async (fixture) => {
        const oldInput = apiKeyFixture();
        registerCanary({ oldEnvelope: oldInput.encryptedKey });
        const oldKey = await fixture.app.apiKeyConfig.create({ data: oldInput });
        const referenceSetHash = createHash("sha256").update("[]").digest("hex");
        const identity = (fingerprint: string) =>
          makeAdminCommandIdentity({
            ownerUserId: fixture.seed.userId,
            operationId: "post.admin.keys.id.rotate",
            resourceId: oldKey.id,
            idempotencyKey: key(),
            payload: { expectedVersion: oldKey.revision, keyFingerprint: fingerprint },
          });
        const failedCandidate = apiKeyFixture();
        registerCanary({ failedEnvelope: failedCandidate.encryptedKey });
        const failedIdentity = identity(failedCandidate.keyFingerprint);
        const beforeFailure = await snapshot(fixture);
        await expect(
          fixture.app.$transaction(async (tx) => {
            const receipt = await reserveAdminCommand(tx, failedIdentity);
            const claim = claimed(
              await claimAdminCommand(tx, {
                receiptId: receipt.id,
                leaseOwner: "fixture-interrupted",
                leaseMs: 10_000,
              }),
            );
            const candidate = await tx.apiKeyConfig.create({
              data: { ...failedCandidate, status: "DISABLED" },
            });
            await prepareKeyRotationRun(tx, {
              claim,
              oldKeyId: oldKey.id,
              newKeyId: candidate.id,
              referenceSetHash,
              baseRevisionsJson: { [oldKey.id]: oldKey.revision },
            });
            throw new Error("Synthetic preparation interruption");
          }),
        ).rejects.toThrow("Synthetic preparation interruption");
        expect(await snapshot(fixture)).toBe(beforeFailure);
        const candidateInput = apiKeyFixture();
        registerCanary({ candidateEnvelope: candidateInput.encryptedKey });
        const commandIdentity = identity(candidateInput.keyFingerprint);
        const prepared = await fixture.app.$transaction(async (tx) => {
          const receipt = await reserveAdminCommand(tx, commandIdentity);
          const claim = claimed(
            await claimAdminCommand(tx, {
              receiptId: receipt.id,
              leaseOwner: "fixture-original",
              leaseMs: 10_000,
            }),
          );
          const candidate = await tx.apiKeyConfig.create({
            data: { ...candidateInput, status: "DISABLED" },
          });
          const run = await prepareKeyRotationRun(tx, {
            claim,
            oldKeyId: oldKey.id,
            newKeyId: candidate.id,
            referenceSetHash,
            baseRevisionsJson: { [oldKey.id]: oldKey.revision },
          });
          return { receipt, claim, run, candidateId: candidate.id };
        });
        expect(prepared.run.stage).toBe("PREPARING");
        expect(prepared.run.candidateIdsJson).toEqual([]);
        expect(prepared.run.checkpointJson).toEqual({
          version: 1,
          fencingToken: prepared.claim.fencingToken,
          step: "PREPARED",
        });
        expect(
          await fixture.app.$transaction((tx) =>
            claimAdminCommand(tx, {
              receiptId: prepared.receipt.id,
              leaseOwner: "fixture-early",
              leaseMs: 10_000,
            }),
          ),
        ).toBeNull();
        await expect(
          fixture.app.$transaction((tx) =>
            saveKeyRotationCheckpoint(tx, {
              claim: prepared.claim,
              runId: prepared.run.id,
              stage: "READY",
              step: "VERIFIED",
            }),
          ),
        ).rejects.toBeDefined();
        await fixture.app.$disconnect();
        const persisted = await fixture.app.keyRotationRun.findUniqueOrThrow({
          where: { id: prepared.run.id },
        });
        expect(persisted.stage).toBe("PREPARING");
        expect(persisted.newKeyId === prepared.candidateId).toBe(true);
        await fixture.setClock(new Date(prepared.claim.leaseUntil.getTime()));
        const resumed = claimed(
          await fixture.app.$transaction((tx) =>
            claimAdminCommand(tx, {
              receiptId: prepared.receipt.id,
              leaseOwner: "fixture-resumed",
              leaseMs: 10_000,
            }),
          ),
        );
        expect(resumed.fencingToken).toBe(prepared.claim.fencingToken + 1);
        const beforeStale = await snapshot(fixture);
        await expect(
          fixture.app.$transaction((tx) =>
            saveKeyRotationCheckpoint(tx, {
              claim: prepared.claim,
              runId: prepared.run.id,
              stage: "TESTING",
              step: "TESTING",
            }),
          ),
        ).rejects.toMatchObject({ kind: "CLAIM_LOST" });
        await expect(
          fixture.app.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('serendipity.admin_lease_owner', ${prepared.claim.leaseOwner}, true),set_config('serendipity.admin_fencing_token', ${String(prepared.claim.fencingToken)}, true)`;
            await tx.keyRotationRun.update({
              where: { id: prepared.run.id },
              data: {
                stage: "TESTING",
                checkpointJson: {
                  version: 1,
                  fencingToken: prepared.claim.fencingToken,
                  step: "TESTING",
                },
                updatedAt: new Date(prepared.claim.leaseUntil.getTime()),
              },
            });
          }),
        ).rejects.toBeDefined();
        expect(await snapshot(fixture)).toBe(beforeStale);
        const testing = await fixture.app.$transaction((tx) =>
          saveKeyRotationCheckpoint(tx, {
            claim: resumed,
            runId: prepared.run.id,
            stage: "TESTING",
            step: "TESTING",
          }),
        );
        expect(testing.stage).toBe("TESTING");
        const replayed = await fixture.app.$transaction((tx) =>
          prepareKeyRotationRun(tx, {
            claim: resumed,
            oldKeyId: oldKey.id,
            newKeyId: prepared.candidateId,
            referenceSetHash,
            baseRevisionsJson: { [oldKey.id]: oldKey.revision },
          }),
        );
        expect(replayed.id === prepared.run.id).toBe(true);
        expect(replayed.stage).toBe("TESTING");
        expect(await fixture.app.keyRotationRun.count()).toBe(1);
        expect(await fixture.app.apiKeyConfig.count()).toBe(2);
        await fixture.app.$transaction(async (tx) => {
          await saveKeyRotationCheckpoint(tx, {
            claim: resumed,
            runId: prepared.run.id,
            stage: "ABORTED",
            step: "ABORTED",
          });
          const now = new Date(prepared.claim.leaseUntil.getTime());
          await tx.adminCommandReceipt.update({
            where: { id: prepared.receipt.id },
            data: {
              status: "FAILED",
              errorCode: "SYNTHETIC_ABORT",
              completedAt: now,
              expiresAt: new Date(now.getTime() + 86_400_000),
              leaseOwner: null,
              leaseUntil: null,
            },
          });
        });
        const pending = await fixture.app.$transaction((tx) =>
          reserveAdminCommand(tx, identity("e".repeat(64))),
        );
        await fixture.setClock(new Date(fixture.clock.getTime() + 172_800_000));
        expect(
          await rejected(fixture.admin.adminCommandReceipt.delete({ where: { id: pending.id } })),
        ).toBe(true);
        expect(
          await rejected(
            fixture.admin.adminCommandReceipt.delete({ where: { id: prepared.receipt.id } }),
          ),
        ).toBe(true);
        expect(
          await rejected(fixture.admin.keyRotationRun.delete({ where: { id: prepared.run.id } })),
        ).toBe(true);
        expect(await rejected(fixture.app.apiKeyConfig.delete({ where: { id: oldKey.id } }))).toBe(
          true,
        );
        const lateClaim = claimed(
          await fixture.app.$transaction((tx) =>
            claimAdminCommand(tx, {
              receiptId: pending.id,
              leaseOwner: "fixture-late",
              leaseMs: 10_000,
            }),
          ),
        );
        expect(lateClaim.fencingToken).toBe(1);
        const oldUnchanged = await fixture.app.apiKeyConfig.findUniqueOrThrow({
          where: { id: oldKey.id },
          select: { status: true, revision: true },
        });
        const candidateUnchanged = await fixture.app.apiKeyConfig.findUniqueOrThrow({
          where: { id: prepared.candidateId },
          select: { status: true, revision: true },
        });
        expect(oldUnchanged).toEqual({ status: "ACTIVE", revision: 0 });
        expect(candidateUnchanged).toEqual({ status: "DISABLED", revision: 0 });
        observe("authorization-idempotency", {
          partialPreparationRolledBack: true,
          partialRowsRemaining: 0,
          persistedRuns: 1,
          persistedCandidates: 1,
          originalFence: prepared.claim.fencingToken,
          resumedFence: resumed.fencingToken,
          staleCheckpointRejections: 2,
          activeAfterTtlStillClaimable: true,
          rotationRetentionRejections: 3,
          oldKeyState: oldUnchanged.status,
          candidateState: candidateUnchanged.status,
          keyActivations: 0,
        });
      });
    }, 120_000);
  });
});
