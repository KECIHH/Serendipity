// @vitest-environment node
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { parseDashboardStats, RECORD_STATUSES } from "@/lib/admin-dashboard";
import { queryDashboardWidgets } from "@/server/admin/dashboard";
import { ADMIN_MIGRATIONS } from "@/server/admin/migration-inventory";
import { assertAdminReadiness } from "@/server/admin/readiness";
import { createSubject, type WorkerResponse } from "../phase013/api-key-fixture";
import { observe, patch, withSettings } from "../phase014/fixture";

function dashboard(response: WorkerResponse) {
  expect(response.status).toBe(200);
  const body = response.body as { success: boolean; data: unknown };
  expect(body.success).toBe(true);
  expect(response.headers["cache-control"]).toBe("no-store");
  return parseDashboardStats(body.data);
}
function unavailable(response: WorkerResponse) {
  expect(response.status).toBe(503);
  expect((response.body as { success: boolean }).success).toBe(false);
  expect(JSON.stringify(response.body)).not.toMatch(
    /Prisma|SELECT |postgresql:|node_modules|"data"/,
  );
}
describe("admin/dashboard DTO", () => {
  it("[dashboard] rejects fabricated counts and invalid discriminated error unions", () => {
    const error = {
      status: "error",
      error: { code: "INTERNAL_ERROR", requestId: "fixture-request" },
    };
    const base = {
      widgets: { users: error, travelRecords: error, configs: error, recentAudits: error },
    };
    expect(parseDashboardStats(base)).toEqual(base);
    for (const users of [
      { status: "ok", data: { total: 1, active: 2 } },
      { status: "error", error: error.error, data: { total: 0, active: 0 } },
      { status: "ok", data: { total: NaN, active: 0 } },
    ])
      expect(() => parseDashboardStats({ widgets: { ...base.widgets, users } })).toThrow();
    expect(() => parseDashboardStats({ widgets: { ...base.widgets, aiCalls: error } })).toThrow();
  });
});
describe.skipIf(!process.env.PHASE014_FIXTURE_CONFIG)("admin/dashboard real PostgreSQL", () => {
  it("[dashboard] returns four exact aggregates and the newest ten sanitized audit summaries", async () => {
    await withSettings(async ({ fixture, worker, actor }) => {
      await createSubject(fixture, { status: "DISABLED" });
      await createSubject(fixture);
      await fixture.admin.travelRecord.createMany({
        data: ["DRAFT", "NEEDS_INFO", "ARCHIVED"].map((status) => ({
          userId: actor.userId,
          title: "合成行程",
          status: status as "DRAFT" | "NEEDS_INFO" | "ARCHIVED",
        })),
      });
      for (let i = 0; i < 12; i++)
        expect(
          (await worker.request(patch(actor, "security.adminPageSize", 30 + i, i))).status,
        ).toBe(200);
      const result = dashboard(
        await worker.request({ method: "GET", path: "/api/admin/dashboard/stats", session: actor }),
      );
      expect(result.widgets.users).toEqual({ status: "ok", data: { total: 3, active: 2 } });
      expect(result.widgets.configs).toEqual({ status: "ok", data: { total: 7, public: 1 } });
      expect(result.widgets.travelRecords).toEqual({
        status: "ok",
        data: {
          total: 3,
          byStatus: Object.fromEntries(
            RECORD_STATUSES.map((status) => [
              status,
              ["DRAFT", "NEEDS_INFO", "ARCHIVED"].includes(status) ? 1 : 0,
            ]),
          ),
        },
      });
      expect(result.widgets.recentAudits.status).toBe("ok");
      if (result.widgets.recentAudits.status === "ok") {
        const expected = await fixture.admin.auditLog.findMany({
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 10,
          select: { id: true },
        });
        expect(result.widgets.recentAudits.data.map((row) => row.id)).toEqual(
          expected.map((row) => row.id),
        );
        expect(result.widgets.recentAudits.data.length).toBe(10);
        expect(JSON.stringify(result.widgets.recentAudits)).not.toContain(fixture.seed.email);
        expect(JSON.stringify(result.widgets.recentAudits)).not.toMatch(
          /actorEmailSnapshot|passwordHash|userAgentSummary/,
        );
      }
    });
  }, 90_000);
  it("[dashboard] reports true empty tables as successful zeros and empty audit data", async () => {
    await withSettings(async ({ fixture }) => {
      // Owner-only fixture reset; production append-only roles and triggers are not relaxed.
      await fixture.admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE "AuditLog" DISABLE TRIGGER ALL');
        await tx.$executeRawUnsafe('ALTER TABLE "AuthSession" DISABLE TRIGGER ALL');
        await tx.$executeRawUnsafe('DELETE FROM "AuditLog"');
        await tx.$executeRawUnsafe('DELETE FROM "AuthSession"');
        await tx.systemConfig.deleteMany();
        await tx.user.deleteMany();
        await tx.$executeRawUnsafe('ALTER TABLE "AuditLog" ENABLE TRIGGER ALL');
        await tx.$executeRawUnsafe('ALTER TABLE "AuthSession" ENABLE TRIGGER ALL');
      });
      await assertAdminReadiness(fixture.app);
      const result = await queryDashboardWidgets(fixture.app, randomUUID());
      expect(result.widgets.users).toEqual({ status: "ok", data: { total: 0, active: 0 } });
      expect(result.widgets.configs).toEqual({ status: "ok", data: { total: 0, public: 0 } });
      expect(result.widgets.travelRecords).toEqual({
        status: "ok",
        data: { total: 0, byStatus: Object.fromEntries(RECORD_STATUSES.map((key) => [key, 0])) },
      });
      expect(result.widgets.recentAudits).toEqual({ status: "ok", data: [] });
    });
  }, 90_000);
  it("[dashboard] isolates a real single-query permission failure and preserves three successful widgets", async () => {
    await withSettings(async ({ fixture, worker, actor }) => {
      await fixture.admin.$executeRawUnsafe(
        `REVOKE SELECT ON "TravelRecord" FROM "${fixture.config.appUser}"`,
      );
      const result = dashboard(
        await worker.request({ method: "GET", path: "/api/admin/dashboard/stats", session: actor }),
      );
      expect(result.widgets.travelRecords.status).toBe("error");
      expect(Object.keys(result.widgets.travelRecords).sort()).toEqual(["error", "status"]);
      expect(result.widgets.users).toEqual({ status: "ok", data: { total: 1, active: 1 } });
      observe("dashboard-partial", {
        failedWidgets: Object.values(result.widgets).filter((widget) => widget.status === "error")
          .length,
        successfulWidgets: Object.values(result.widgets).filter((widget) => widget.status === "ok")
          .length,
        failedWidgetHasData: "data" in result.widgets.travelRecords,
      });
      expect(result.widgets.configs.status).toBe("ok");
      expect(result.widgets.recentAudits.status).toBe("ok");
      await fixture.admin.$executeRawUnsafe(
        `GRANT SELECT ON "TravelRecord" TO "${fixture.config.appUser}"`,
      );
      expect(
        dashboard(
          await worker.request({
            method: "GET",
            path: "/api/admin/dashboard/stats",
            session: actor,
          }),
        ).widgets.travelRecords.status,
      ).toBe("ok");
      for (const table of ["User", "TravelRecord", "SystemConfig", "AuditLog"])
        await fixture.admin.$executeRawUnsafe(
          `REVOKE SELECT ON "${table}" FROM "${fixture.config.appUser}"`,
        );
      const allFailed = await queryDashboardWidgets(fixture.app, randomUUID());
      expect(
        Object.values(allFailed.widgets).every(
          (widget) => widget.status === "error" && !("data" in widget),
        ),
      ).toBe(true);
      unavailable(
        await worker.request({ method: "GET", path: "/api/admin/dashboard/stats", session: actor }),
      );
    });
  }, 90_000);
  it("[dashboard] refuses every missing prerequisite migration, checksum drift and each missing table", async () => {
    await withSettings(async ({ fixture, worker, actor }) => {
      for (const migration of ADMIN_MIGRATIONS) {
        const [row] = await fixture.admin.$queryRaw<
          Array<{ id: string; finished_at: Date }>
        >`SELECT id,finished_at FROM "_prisma_migrations" WHERE migration_name=${migration.name}`;
        await fixture.admin
          .$executeRaw`UPDATE "_prisma_migrations" SET finished_at=NULL WHERE id=${row.id}`;
        unavailable(
          await worker.request({
            method: "GET",
            path: "/api/admin/dashboard/stats",
            session: actor,
          }),
        );
        unavailable(await worker.request({ method: "GET", path: "/api/config/public" }));
        await fixture.admin
          .$executeRaw`UPDATE "_prisma_migrations" SET finished_at=${row.finished_at} WHERE id=${row.id}`;
      }
      await fixture.admin
        .$executeRaw`UPDATE "_prisma_migrations" SET checksum=${"f".repeat(64)} WHERE migration_name=${ADMIN_MIGRATIONS[0].name}`;
      unavailable(
        await worker.request({ method: "GET", path: "/api/admin/settings", session: actor }),
      );
      await fixture.admin
        .$executeRaw`UPDATE "_prisma_migrations" SET checksum=${ADMIN_MIGRATIONS[0].sha256} WHERE migration_name=${ADMIN_MIGRATIONS[0].name}`;
      for (const table of [
        "User",
        "SystemConfig",
        "TravelRecord",
        "ChatMessage",
        "AuditLog",
        "ApiKeyConfig",
        "AuthSession",
        "AuthLoginAttempt",
        "AdminCommandReceipt",
        "KeyRotationRun",
      ]) {
        await fixture.admin.$executeRawUnsafe(`ALTER TABLE "${table}" RENAME TO "absent_${table}"`);
        unavailable(await worker.request({ method: "GET", path: "/api/config/public" }));
        await fixture.admin.$executeRawUnsafe(`ALTER TABLE "absent_${table}" RENAME TO "${table}"`);
      }
      expect(
        dashboard(
          await worker.request({
            method: "GET",
            path: "/api/admin/dashboard/stats",
            session: actor,
          }),
        ).widgets.users.status,
      ).toBe("ok");
      observe("readiness", {
        missingMigrationChecks: ADMIN_MIGRATIONS.length,
        missingTableChecks: 10,
        checksumDriftChecks: 1,
      });
    });
  }, 90_000);
  it("[dashboard] returns safe503 during a real database outage and recovers after reconnection", async () => {
    await withSettings(async ({ fixture, worker, actor }) => {
      dashboard(
        await worker.request({ method: "GET", path: "/api/admin/dashboard/stats", session: actor }),
      );
      const control = new PrismaClient({ datasourceUrl: fixture.config.url, log: [] });
      try {
        await control.$executeRawUnsafe(
          `ALTER DATABASE "${fixture.database}" ALLOW_CONNECTIONS false`,
        );
        await control.$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${fixture.database} AND usename=${fixture.config.appUser}`;
        unavailable(
          await worker.request({
            method: "GET",
            path: "/api/admin/dashboard/stats",
            session: actor,
          }),
        );
        unavailable(await worker.request({ method: "GET", path: "/api/config/public" }));
      } finally {
        await control.$executeRawUnsafe(
          `ALTER DATABASE "${fixture.database}" ALLOW_CONNECTIONS true`,
        );
        await control.$disconnect();
      }
      let recovered = await worker.request({
        method: "GET",
        path: "/api/admin/dashboard/stats",
        session: actor,
      });
      for (let attempt = 0; recovered.status === 503 && attempt < 15; attempt++) {
        await delay(100);
        recovered = await worker.request({
          method: "GET",
          path: "/api/admin/dashboard/stats",
          session: actor,
        });
      }
      expect(dashboard(recovered).widgets.users.status).toBe("ok");
      observe("database-recovery", { recoveredStatus: recovered.status });
    });
  }, 90_000);
});
