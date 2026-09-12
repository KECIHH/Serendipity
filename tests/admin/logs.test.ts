// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isAuditLogPage, type AuditLogPage } from "@/lib/admin-logs";
import { createAdminLogsService, AdminLogsError } from "@/server/admin/logs";
import { createAuditContext } from "@/server/audit-log";
import { createSubject, issueSession } from "../phase013/api-key-fixture";
import {
  adminAudit,
  appendAudits,
  containsNoSecrets,
  directLogsRequest,
  insertLegacyAudit,
  logSecrets,
  logSnapshot,
  revokeDuringRead,
  withLogsTransport,
  type LogsResponse,
} from "../phase013/logs-fixture";

const fields = [
  "id",
  "actorType",
  "actorId",
  "targetType",
  "targetId",
  "action",
  "requestId",
  "traceId",
  "createdAt",
  "safeSummary",
];

function page(response: LogsResponse): AuditLogPage {
  expect(response.status).toBe(200);
  const body = response.body as { success: boolean; data?: unknown; requestId: string };
  expect(body.success).toBe(true);
  expect(isAuditLogPage(body.data)).toBe(true);
  expect(typeof body.requestId === "string" && body.requestId.length > 0).toBe(true);
  expect(response.headers["cache-control"]).toBe("no-store");
  const result = body.data as AuditLogPage;
  for (const item of result.items) expect(Object.keys(item).sort()).toEqual([...fields].sort());
  return result;
}

function failure(response: LogsResponse, status: number, code: string): void {
  expect(response.status).toBe(status);
  const body = response.body as {
    success: boolean;
    error: { code: string; message: string; details?: unknown };
    requestId: string;
  };
  expect(body.success).toBe(false);
  expect(body.error.code).toBe(code);
  expect(typeof body.requestId === "string" && body.requestId.length > 0).toBe(true);
  expect("details" in body.error).toBe(false);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(/stack|Prisma|node_modules|SELECT |postgresql:\/\//i.test(JSON.stringify(body))).toBe(
    false,
  );
}

describe("admin/logs DTO parser boundaries", () => {
  const item: AuditLogPage["items"][number] = {
    id: "fixture-audit",
    actorType: "SYSTEM",
    actorId: null,
    targetType: "SystemConfig",
    targetId: "fixture-config",
    action: "CONFIG_UPDATE",
    requestId: "fixture-request",
    traceId: null,
    createdAt: "2026-09-12T00:00:00.000Z",
    safeSummary: "未记录详情",
  };

  it("accepts only the exact string actor kinds", () => {
    for (const actorType of ["USER", "ADMIN", "SYSTEM"])
      expect(isAuditLogPage({ items: [{ ...item, actorType }], nextCursor: null })).toBe(true);
  });

  it.each(["USER", "ADMIN", "SYSTEM"])(
    "rejects non-string actorType values for %s without calling coercion hooks",
    (member) => {
      const toString = vi.fn(() => member),
        toPrimitive = vi.fn(() => member);
      const boxed: unknown = Object(member);
      for (const actorType of [
        undefined,
        null,
        false,
        true,
        0,
        1,
        {},
        [],
        [member],
        [[member]],
        boxed,
        { toString },
        { [Symbol.toPrimitive]: toPrimitive },
        "UNKNOWN",
        `${member} `,
      ])
        expect(isAuditLogPage({ items: [{ ...item, actorType }], nextCursor: null })).toBe(false);
      expect(toString).not.toHaveBeenCalled();
      expect(toPrimitive).not.toHaveBeenCalled();
    },
  );
});

describe.skipIf(!process.env.PHASE013_FIXTURE_CONFIG)(
  "admin/logs PostgreSQL and guarded handlers",
  () => {
    it("[crypto-redaction] reads exact safe DTOs and re-sanitizes nested legacy secrets without writes", async () => {
      await withLogsTransport(async ({ fixture, actor, worker }) => {
        const secrets = logSecrets(),
          targetId = `logs-${randomUUID()}`;
        const detail = {
          result: "SUCCESS",
          before: {
            plainKey: secrets.plainKey,
            encryptedKey: secrets.encryptedKey,
            keyFingerprint: secrets.keyFingerprint,
          },
          metadata: {
            items: [
              { authorization: secrets.plainKey },
              { envelope: secrets.encryptedKey, encryptionKey: secrets.master },
            ],
            accountHash: secrets.secretHash,
          },
          seedFingerprint: secrets.secretHash,
        };
        const [normal] = await appendAudits(fixture, [adminAudit(fixture, targetId, detail)]);
        const legacy = await insertLegacyAudit(fixture, { targetId, detailJson: detail });
        const before = await logSnapshot(fixture);
        const response = await worker.request({
          method: "GET",
          path: `/api/admin/logs?targetId=${targetId}`,
          session: actor,
          mode: "observed-logs",
        });
        const result = page(response);
        expect(result.items.length).toBe(2);
        expect(
          result.items.every((row) => row.actorType === "ADMIN" && row.targetId === targetId),
        ).toBe(true);
        expect(new Set(result.items.map((row) => row.id)).has(normal.id)).toBe(true);
        expect(new Set(result.items.map((row) => row.id)).has(legacy.id)).toBe(true);
        expect(containsNoSecrets(response.body, secrets)).toBe(true);
        expect(JSON.stringify(response.body).includes(fixture.seed.email)).toBe(false);
        for (const item of result.items) {
          const summary = JSON.parse(item.safeSummary) as {
            before: Record<string, string>;
            metadata: { items: Array<Record<string, string>>; accountHash: string };
            seedFingerprint: string;
          };
          expect(Object.values(summary.before).every((value) => value === "***")).toBe(true);
          expect(
            summary.metadata.items.every((entry) =>
              Object.values(entry).every((value) => value === "***"),
            ),
          ).toBe(true);
          expect(summary.metadata.accountHash === "***" && summary.seedFingerprint === "***").toBe(
            true,
          );
        }
        const queries = response.queries?.filter((query) => query.includes('"AuditLog"')) ?? [];
        expect(queries.length > 0).toBe(true);
        expect(
          queries.every(
            (query) => !/actorEmailSnapshot|userAgentSummary|ipHash|SELECT\s+\*/i.test(query),
          ),
        ).toBe(true);
        expect((await logSnapshot(fixture)) === before).toBe(true);
      });
    }, 90_000);

    it("[crypto-redaction] distinguishes immutable administrator user and system audit kinds", async () => {
      await withLogsTransport(async ({ fixture, actor, worker }) => {
        const user = await createSubject(fixture, { role: "USER" });
        const targetId = `actor-kinds-${randomUUID()}`;
        const refs = await appendAudits(fixture, [
          adminAudit(fixture, targetId),
          {
            actor: { kind: "USER", id: user.id, emailSnapshot: user.email },
            action: "LOGIN_SUCCESS",
            targetType: "User",
            targetId,
            context: createAuditContext(),
            detailJson: { result: "SUCCESS", reasonCode: "LOGIN_ACCEPTED" },
          },
          {
            actor: { kind: "SYSTEM", systemActor: "MAINTENANCE" },
            action: "CONFIG_UPDATE",
            targetType: "SystemConfig",
            targetId,
            context: createAuditContext(),
            detailJson: { result: "SUCCESS", reasonCode: "MAINTENANCE" },
          },
          { ...adminAudit(fixture, targetId), detailJson: null },
        ]);
        const result = page(
          await worker.request({
            method: "GET",
            path: `/api/admin/logs?targetId=${targetId}`,
            session: actor,
          }),
        );
        expect(result.items.map((item) => item.actorType).sort()).toEqual([
          "ADMIN",
          "ADMIN",
          "SYSTEM",
          "USER",
        ]);
        expect(result.items.find((item) => item.actorType === "SYSTEM")?.actorId).toBeNull();
        expect(result.items.find((item) => item.actorType === "USER")?.actorId === user.id).toBe(
          true,
        );
        expect(JSON.stringify(result).includes(user.email)).toBe(false);
        const withoutDetail = result.items.find((item) => item.id === refs[3].id);
        expect(withoutDetail?.safeSummary).toBe("未记录详情");
        expect(withoutDetail?.safeSummary.includes("SUCCESS")).toBe(false);
      });
    }, 90_000);

    it("[failure-atomicity] enforces default and maximum page size with stable tied-timestamp keysets", async () => {
      await withLogsTransport(async ({ fixture, actor, worker }) => {
        const targetId = `pages-${randomUUID()}`;
        const refs = await appendAudits(
          fixture,
          Array.from({ length: 105 }, () => adminAudit(fixture, targetId)),
          { at: fixture.clock },
        );
        expect(new Set(refs.map((ref) => ref.createdAt.getTime())).size).toBe(1);
        const expected = await fixture.admin.auditLog.findMany({
          where: { targetId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true },
        });
        const before = await logSnapshot(fixture);
        const first = page(
          await worker.request({
            method: "GET",
            path: `/api/admin/logs?targetId=${targetId}`,
            session: actor,
          }),
        );
        expect(first.items.length).toBe(20);
        const maximum = page(
          await worker.request({
            method: "GET",
            path: `/api/admin/logs?targetId=${targetId}&limit=100`,
            session: actor,
          }),
        );
        expect(maximum.items.length).toBe(100);
        expect(typeof maximum.nextCursor).toBe("string");
        const seen: string[] = [];
        let cursor: string | null = null;
        let requests = 0;
        do {
          const query = new URLSearchParams({ targetId, limit: "17" });
          if (cursor) query.set("cursor", cursor);
          const result = page(
            await worker.request({
              method: "GET",
              path: `/api/admin/logs?${query}`,
              session: actor,
            }),
          );
          expect(result.items.length <= 17).toBe(true);
          seen.push(...result.items.map((item) => item.id));
          cursor = result.nextCursor;
          requests += 1;
          expect(requests <= 7).toBe(true);
        } while (cursor);
        expect(seen.length).toBe(105);
        expect(new Set(seen).size).toBe(105);
        expect(seen.every((id, index) => id === expected[index]?.id)).toBe(true);
        expect((await logSnapshot(fixture)) === before).toBe(true);
      });
    }, 90_000);

    it("[failure-atomicity] filters by actor action target and inclusive time while retaining the first-page watermark", async () => {
      await withLogsTransport(async ({ fixture, actor, worker }) => {
        const targetId = `filters-${randomUUID()}`;
        const refs = await appendAudits(
          fixture,
          [
            adminAudit(fixture, targetId),
            adminAudit(fixture, targetId),
            {
              actor: { kind: "SYSTEM", systemActor: "SCHEDULER" },
              action: "CONFIG_UPDATE",
              targetType: "SystemConfig",
              targetId,
              context: createAuditContext(),
              detailJson: { result: "SUCCESS", reasonCode: "SCHEDULED" },
            },
          ],
          { at: fixture.clock },
        );
        const at = refs[0].createdAt.toISOString();
        for (const [filters, count] of [
          [{ actorId: fixture.seed.userId }, 2],
          [{ action: "API_KEY_CREATE" }, 2],
          [{ targetType: "SystemConfig" }, 1],
          [{ from: at, to: at }, 3],
          [{ to: new Date(refs[0].createdAt.getTime() - 1).toISOString() }, 0],
        ] as Array<[Record<string, string>, number]>) {
          const query = new URLSearchParams({ targetId, ...filters });
          expect(
            page(
              await worker.request({
                method: "GET",
                path: `/api/admin/logs?${query}`,
                session: actor,
              }),
            ).items.length,
          ).toBe(count);
        }
        const first = page(
          await worker.request({
            method: "GET",
            path: `/api/admin/logs?targetId=${targetId}&limit=1`,
            session: actor,
          }),
        );
        expect(typeof first.nextCursor).toBe("string");
        const futureTime = new Date(Date.now() + 60_000);
        const future = await insertLegacyAudit(fixture, {
          targetId,
          detailJson: { result: "SUCCESS" },
          createdAt: futureTime,
        });
        const seen = first.items.map((item) => item.id);
        let cursor = first.nextCursor;
        for (let pageNumber = 0; cursor && pageNumber < 5; pageNumber++) {
          const query = new URLSearchParams({ targetId, limit: "1", cursor });
          const next = page(
            await worker.request({
              method: "GET",
              path: `/api/admin/logs?${query}`,
              session: actor,
            }),
          );
          seen.push(...next.items.map((item) => item.id));
          cursor = next.nextCursor;
        }
        expect(cursor).toBeNull();
        expect(seen.length).toBe(3);
        expect(seen.includes(future.id)).toBe(false);
        const refreshed = page(
          await worker.request({
            method: "GET",
            path: `/api/admin/logs?targetId=${targetId}`,
            session: actor,
          }),
        );
        expect(refreshed.items.length).toBe(4);
        expect(refreshed.items[0].id === future.id).toBe(true);
      });
    }, 90_000);

    it("[failure-atomicity] rejects malformed bounded queries before issuing protected reads", async () => {
      await withLogsTransport(async ({ fixture, actor, worker }) => {
        const before = await logSnapshot(fixture);
        const invalid = [
          "limit=0",
          "limit=101",
          "limit=01",
          "limit=1.5",
          "limit=-1",
          "limit=20&limit=20",
          "action=UNKNOWN_ACTION",
          "action=API_KEY_CREATE&action=API_KEY_CREATE",
          "targetType=NoSuchTable",
          "targetId=x%27%20OR%201%3D1",
          "actorId=",
          `action=${"a".repeat(65)}`,
          `targetId=${"x".repeat(129)}`,
          "from=2026-02-30T00%3A00%3A00Z",
          "from=2026-09-12",
          "from=2026-09-12T25%3A00%3A00Z",
          "from=2026-09-12T00%3A00%3A00Z&to=2026-09-11T00%3A00%3A00Z",
          "cursor=bad",
          `cursor=${"x".repeat(2_049)}`,
          `unknown=${"x".repeat(4_097)}`,
          "encryptedKey=unexpected",
        ];
        for (const query of invalid) {
          const response = await worker.request({
            method: "GET",
            path: `/api/admin/logs?${query}`,
            session: actor,
            mode: "observed-logs",
          });
          failure(response, 400, "VALIDATION_ERROR");
          expect(
            response.queries?.some((statement) => statement.includes('"AuditLog"')) ?? false,
          ).toBe(false);
        }
        expect((await logSnapshot(fixture)) === before).toBe(true);
      });
    }, 90_000);

    it("[authorization] binds opaque cursors to signature administrator filters and page size", async () => {
      await withLogsTransport(async ({ fixture, actor, worker }) => {
        const targetId = `cursor-${randomUUID()}`;
        await appendAudits(fixture, [adminAudit(fixture, targetId), adminAudit(fixture, targetId)]);
        const first = page(
          await worker.request({
            method: "GET",
            path: `/api/admin/logs?targetId=${targetId}&limit=1`,
            session: actor,
          }),
        );
        expect(typeof first.nextCursor).toBe("string");
        const cursor = first.nextCursor!;
        const other = await createSubject(fixture, { role: "ADMIN" });
        const otherSession = await issueSession(fixture, other.id);
        const before = await logSnapshot(fixture);
        const tampered = `${cursor[0] === "A" ? "B" : "A"}${cursor.slice(1)}`;
        for (const [session, changes] of [
          [actor, { cursor: tampered }],
          [otherSession, { cursor }],
          [actor, { cursor, action: "API_KEY_CREATE" }],
          [actor, { cursor, limit: "2" }],
          [actor, { cursor, targetId: `different-${randomUUID()}` }],
        ] as Array<[typeof actor, Record<string, string>]>) {
          const query = new URLSearchParams({ targetId, limit: "1", ...changes });
          failure(
            await worker.request({ method: "GET", path: `/api/admin/logs?${query}`, session }),
            400,
            "VALIDATION_ERROR",
          );
        }
        const query = new URLSearchParams({ targetId, limit: "1", cursor });
        expect(
          page(
            await worker.request({
              method: "GET",
              path: `/api/admin/logs?${query}`,
              session: actor,
            }),
          ).items.length,
        ).toBe(1);
        expect((await logSnapshot(fixture)) === before).toBe(true);
      });
    }, 90_000);

    it("[authorization] denies anonymous ordinary disabled stale and revoked identities with zero business queries", async () => {
      await withLogsTransport(async ({ fixture, actor, worker }) => {
        const user = await createSubject(fixture, { role: "USER" });
        const disabled = await createSubject(fixture, { role: "ADMIN", status: "DISABLED" });
        const stale = await createSubject(fixture, { role: "ADMIN" });
        const revoked = await createSubject(fixture, { role: "ADMIN" });
        const userSession = await issueSession(fixture, user.id, "USER"),
          disabledSession = await issueSession(fixture, disabled.id);
        const staleSession = await issueSession(fixture, stale.id, "ADMIN", 1),
          revokedSession = await issueSession(fixture, revoked.id);
        await fixture.admin.authSession.updateMany({
          where: {
            tokenHash: createHash("sha256").update(revokedSession.opaqueToken).digest("hex"),
          },
          data: { status: "REVOKED", revokedAt: fixture.clock },
        });
        const before = await logSnapshot(fixture);
        for (const [session, status, code] of [
          [undefined, 401, "AUTH_REQUIRED"],
          [userSession, 403, "FORBIDDEN"],
          [disabledSession, 401, "AUTH_REQUIRED"],
          [staleSession, 401, "AUTH_REQUIRED"],
          [revokedSession, 401, "AUTH_REQUIRED"],
        ] as const) {
          for (const target of ["known-target", "nonexistent-target"]) {
            const response = await worker.request({
              method: "GET",
              path: `/api/admin/logs?targetId=${target}`,
              session,
              mode: "observed-logs",
            });
            failure(response, status, code);
            expect(
              response.queries?.some((query) =>
                /AuditLog|ApiKeyConfig|AdminCommandReceipt|KeyRotationRun/.test(query),
              ) ?? false,
            ).toBe(false);
          }
        }
        page(
          await worker.request({
            method: "GET",
            path: "/api/admin/logs?targetId=nonexistent-target",
            session: actor,
          }),
        );
        expect((await logSnapshot(fixture)) === before).toBe(true);
      });
    }, 90_000);

    it("[authorization] rechecks the database session after the audit query before releasing rows", async () => {
      await withLogsTransport(async ({ fixture, actor }) => {
        const targetId = `race-${randomUUID()}`;
        await appendAudits(fixture, [adminAudit(fixture, targetId)]);
        let intercepted = false,
          revoked = false;
        const service = createAdminLogsService({
          databaseUrl: fixture.url,
          cursorSecret: fixture.config.authSecret,
          queryObserver(query) {
            if (!intercepted && query.includes('"AuditLog"')) {
              intercepted = true;
              revoked = revokeDuringRead(fixture, actor);
            }
          },
        });
        try {
          let denied = false;
          try {
            await service.list(await directLogsRequest(actor, `targetId=${targetId}`));
          } catch (error) {
            denied =
              error instanceof AdminLogsError &&
              error.status === 401 &&
              error.code === "AUTH_REQUIRED";
          }
          expect(intercepted).toBe(true);
          expect(revoked).toBe(true);
          expect(denied).toBe(true);
        } finally {
          await service.disconnect();
        }
      });
    }, 90_000);

    it("[failure-atomicity] reports real database and malformed legacy failures without unsafe partial responses", async () => {
      await withLogsTransport(async ({ fixture, actor, worker }) => {
        const targetId = `fault-${randomUUID()}`,
          secrets = logSecrets();
        await appendAudits(fixture, [adminAudit(fixture, targetId)]);
        await fixture.admin.$executeRawUnsafe(
          `REVOKE SELECT ON TABLE "AuditLog" FROM "${fixture.config.appUser}"`,
        );
        try {
          const response = await worker.request({
            method: "GET",
            path: `/api/admin/logs?targetId=${targetId}`,
            session: actor,
          });
          failure(response, 503, "INTERNAL_ERROR");
          expect(containsNoSecrets(response.body, secrets)).toBe(true);
        } finally {
          await fixture.admin.$executeRawUnsafe(
            `GRANT SELECT ON TABLE "AuditLog" TO "${fixture.config.appUser}"`,
          );
        }
        expect(
          page(
            await worker.request({
              method: "GET",
              path: `/api/admin/logs?targetId=${targetId}`,
              session: actor,
            }),
          ).items.length,
        ).toBe(1);
        await insertLegacyAudit(fixture, {
          targetId,
          detailJson: { unregisteredValue: secrets.plainKey },
        });
        const before = await logSnapshot(fixture);
        const response = await worker.request({
          method: "GET",
          path: `/api/admin/logs?targetId=${targetId}`,
          session: actor,
        });
        failure(response, 503, "INTERNAL_ERROR");
        expect(containsNoSecrets(response.body, secrets)).toBe(true);
        expect((await logSnapshot(fixture)) === before).toBe(true);
      });
    }, 90_000);
  },
);
