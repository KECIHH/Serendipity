// @vitest-environment node
import fs from "node:fs";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { withAdminRoute } from "@/server/auth/guards";
import { ADMIN_NAV } from "@/components/admin/admin-nav";
import { createSubject, issueSession } from "../phase013/api-key-fixture";
import { observe, patch, snapshot, withSettings } from "../phase014/fixture";

describe("admin/security common boundary and M3 inventory", () => {
  it("[authorization] requireAdmin rejects an anonymous route before its resource callback", async () => {
    let callbacks = 0;
    const guarded = withAdminRoute(async () => {
      callbacks++;
      return Response.json({ reachedResource: true });
    });
    const response = await guarded(
      new Request("http://127.0.0.1:3000/api/admin/settings"),
      undefined,
    );
    expect(response.status).toBe(401);
    expect(callbacks).toBe(0);
  });
  it("[m3-regression] preserves Phase011–013 Gate hashes and exposes exactly five existing menus with one common component implementation", () => {
    const state = JSON.parse(fs.readFileSync("docs/roadmap-run.json", "utf8"));
    for (const phase of [11, 12, 13]) {
      const checkpoint = state.checkpoints.find((item: { phase: number }) => item.phase === phase);
      expect(
        createHash("sha256").update(fs.readFileSync(checkpoint.evidencePath)).digest("hex"),
      ).toBe(checkpoint.evidenceHash);
      expect(JSON.parse(fs.readFileSync(checkpoint.evidencePath, "utf8")).status).toBe("PASS");
    }
    expect(ADMIN_NAV.filter((item) => item.kind === "link").map((item) => item.href)).toEqual([
      "/admin",
      "/admin/users",
      "/admin/api-keys",
      "/admin/logs",
      "/admin/settings",
    ]);
    for (const page of ["", "users/", "api-keys/", "logs/", "settings/"])
      expect(fs.existsSync(`src/app/admin/(protected)/${page}page.tsx`)).toBe(true);
    for (const client of ["users", "api-keys", "logs", "settings", "dashboard"]) {
      const source = fs.readFileSync(`src/components/admin/${client}-client.tsx`, "utf8");
      for (const component of [
        "page-header",
        "loading-state",
        "empty-state",
        "error-state",
        "data-table",
      ])
        expect(source).toContain(`@/components/common/${component}`);
      if (["users", "api-keys", "logs"].includes(client))
        expect(source).toContain("@/components/admin/admin-pagination");
    }
    expect(fs.existsSync("src/components/admin/page-header.tsx")).toBe(false);
    const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
    expect(schema).not.toMatch(
      /model\s+(?:AiModelConfig|PromptConfig|AiOutputRecord|ModelDeployment|PromptVersion|ProviderConfig)\b/,
    );
  });
});
describe.skipIf(!process.env.PHASE014_FIXTURE_CONFIG)("admin/security real sessions", () => {
  it("[authorization] denies anonymous USER disabled-admin stale/revoked sessions and missing CSRF without configuration side effects", async () => {
    await withSettings(async ({ fixture, worker, actor }) => {
      const user = await createSubject(fixture),
        disabled = await createSubject(fixture, { role: "ADMIN", status: "DISABLED" }),
        stale = await createSubject(fixture, { role: "ADMIN" });
      const normalUser = await issueSession(fixture, user.id, "USER"),
        disabledAdmin = await issueSession(fixture, disabled.id),
        old = await issueSession(fixture, stale.id, "ADMIN", 0);
      await fixture.admin.user.update({
        where: { id: stale.id },
        data: { sessionVersion: { increment: 1 } },
      });
      const revoked = await issueSession(fixture, fixture.seed.userId);
      await fixture.admin.authSession.updateMany({
        where: { tokenHash: createHash("sha256").update(revoked.opaqueToken).digest("hex") },
        data: { status: "REVOKED", revokedAt: fixture.clock },
      });
      const before = await snapshot(fixture);
      for (const session of [undefined, normalUser, disabledAdmin, old, revoked]) {
        for (const path of ["/api/admin/settings", "/api/admin/dashboard/stats"]) {
          const response = await worker.request({ method: "GET", path, session });
          expect([401, 403]).toContain(response.status);
          expect((response.body as { success: boolean }).success).toBe(false);
        }
        expect([401, 403]).toContain(
          (await worker.request(patch(session, "planner.quick.defaultDurationDays", 14))).status,
        );
      }
      for (const csrf of ["missing", "mismatch"] as const)
        expect(
          (await worker.request({ ...patch(actor, "planner.quick.defaultDurationDays", 14), csrf }))
            .status,
        ).toBe(403);
      expect(
        (
          await worker.request({
            ...patch(actor, "planner.quick.defaultDurationDays", 14),
            origin: "https://foreign.invalid",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await worker.request({
            ...patch(actor, "planner.quick.defaultDurationDays", 14),
            idempotencyKey: undefined,
          })
        ).status,
      ).toBe(400);
      expect(await snapshot(fixture)).toBe(before);
      observe("authorization", {
        unchanged: (await snapshot(fixture)) === before,
        unauthorizedAudits: await fixture.admin.auditLog.count({
          where: { action: "CONFIG_UPDATE" },
        }),
        unauthorizedReceipts: await fixture.admin.adminCommandReceipt.count(),
      });
    });
  }, 90_000);
  it("[authorization] rechecks actor sessionVersion under the write lock after concurrent revocation", async () => {
    await withSettings(async ({ fixture, worker, actor }) => {
      const before = await snapshot(fixture);
      let request!: Promise<{ status: number }>;
      await fixture.admin.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('serendipity:admin-users:v1',0::bigint))`;
          request = worker.request(patch(actor, "planner.quick.defaultDurationDays", 14));
          void request.catch(() => {});
          let waiting = false;
          for (let i = 0; i < 100; i++) {
            const [row] = await fixture.admin.$queryRaw<
              Array<{ waiting: boolean }>
            >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename=${fixture.config.appUser} AND wait_event_type='Lock') AS waiting`;
            if (row.waiting) {
              waiting = true;
              break;
            }
            await delay(25);
          }
          expect(waiting).toBe(true);
          await tx.user.update({
            where: { id: actor.userId },
            data: { sessionVersion: { increment: 1 } },
          });
        },
        { timeout: 10_000 },
      );
      expect([401, 403]).toContain((await request).status);
      expect(await snapshot(fixture)).toBe(before);
    });
  }, 90_000);
});
