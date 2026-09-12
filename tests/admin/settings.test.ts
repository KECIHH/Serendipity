// @vitest-environment node
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  configValue,
  parseAdminSetting,
  parseAdminSettings,
  parseSettingPatch,
  SettingInputError,
} from "@/lib/admin-settings";
import { SYSTEM_CONFIG_GROUPS } from "@/lib/schemas/system-config";
import { CONFIG_REGISTRY, configDefinition, parseConfig } from "@/server/config/config-registry";
import { canonicalConfigHash } from "@/server/config/config-service";
import { startApiKeyWorker, type WorkerResponse } from "../phase013/api-key-fixture";
import {
  insertUnknown,
  observe,
  patch,
  settingDefaults,
  snapshot,
  withSettings,
} from "../phase014/fixture";

const caps = { aiTimeoutMs: 60_000 };
const responseData = (response: WorkerResponse) => {
  expect(response.status).toBe(200);
  const envelope = response.body as { success: boolean; data: unknown; requestId: string };
  expect(envelope.success).toBe(true);
  expect(envelope.requestId.length).toBeGreaterThan(0);
  return envelope.data;
};
function failure(response: WorkerResponse, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = response.body as { success: boolean; error: { code: string } };
  expect(body.success).toBe(false);
  expect(body.error.code).toBe(code);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(JSON.stringify(body)).not.toMatch(
    /Prisma|SELECT |postgresql:\/\/|node_modules|passwordHash/,
  );
}
describe("admin/settings closed registry", () => {
  it("[settings] covers all five groups and every registered schema, preserving three private seed defaults", () => {
    expect(new Set(CONFIG_REGISTRY.map((entry) => entry.group))).toEqual(
      new Set(SYSTEM_CONFIG_GROUPS),
    );
    for (const entry of CONFIG_REGISTRY) {
      expect(
        parseConfig(entry.key, settingDefaults[entry.key as keyof typeof settingDefaults], caps),
      ).toBeDefined();
      expect(() => parseConfig(entry.key, null, caps)).toThrow(SettingInputError);
      expect(() => parseConfig(entry.key, { unknown: true }, caps)).toThrow(SettingInputError);
    }
    for (const key of Object.keys(settingDefaults).filter((key) => key.startsWith("planner."))) {
      expect(configDefinition(key).defaultVisibility).toBe("PRIVATE");
      expect(configDefinition(key).public).toBe(false);
    }
    for (const [key, min, max] of [
      ["planner.quick.defaultDurationDays", 1, 30],
      ["planner.quick.defaultTravelerCount", 1, 20],
      ["export.maxDurationDays", 1, 30],
      ["security.adminPageSize", 1, 100],
      ["ai.timeoutMs", 1000, 60_000],
    ] as const) {
      expect(parseConfig(key, min, caps)).toBe(min);
      expect(parseConfig(key, max, caps)).toBe(max);
      for (const bad of [min - 1, max + 1, 1.5, "2", NaN, Infinity, null, [], {}])
        expect(() => parseConfig(key, bad, caps)).toThrow();
    }
    for (const pace of ["slow", "moderate", "fast"])
      expect(parseConfig("planner.quick.defaultPace", pace, caps)).toBe(pace);
    expect(() => parseConfig("planner.quick.defaultPace", "medium", caps)).toThrow();
    expect(() => parseConfig("ai.timeoutMs", 10_001, { aiTimeoutMs: 10_000 })).toThrow();
  });
  it("[settings] rejects unknown keys/fields, unbounded JSON, coercion hooks, nonfinite values and invalid revisions", () => {
    expect(() => parseConfig("secret.apiKey", "value", caps)).toThrow();
    expect(() =>
      parseConfig("ui.notice", { ...settingDefaults["ui.notice"], extra: true }, caps),
    ).toThrow();
    for (const input of [
      { valueJson: 3, expectedVersion: 0, key: "override" },
      { valueJson: 3 },
      { valueJson: 3, expectedVersion: -1 },
      { valueJson: 3, expectedVersion: 0.5 },
      { valueJson: 3, expectedVersion: "0" },
    ])
      expect(() => parseSettingPatch(input)).toThrow();
    const accessor = Object.defineProperty({}, "bad", {
      enumerable: true,
      get: () => {
        throw new Error("DO_NOT_EVALUATE");
      },
    });
    for (const value of [
      NaN,
      Infinity,
      undefined,
      Array(34).fill(1),
      new Date(),
      accessor,
      { toJSON: () => ({}) },
      { value: "x".repeat(2049) },
      JSON.parse('{"__proto__":1}'),
    ])
      expect(() => configValue(value)).toThrow(SettingInputError);
    expect(() => configValue({ a: { a: { a: { a: { a: { a: { a: 1 } } } } } } })).toThrow();
  });
  it("[settings] normalizes bounded notice text with explicit empty/null semantics and canonical hashes", () => {
    const a = parseConfig(
      "ui.notice",
      { internalNote: null, message: " 提示 ", enabled: true },
      caps,
    );
    const b = parseConfig(
      "ui.notice",
      { enabled: true, message: "提示", internalNote: null },
      caps,
    );
    expect(a).toEqual(b);
    expect(canonicalConfigHash(a)).toBe(canonicalConfigHash(b));
    expect(
      parseConfig("ui.notice", { enabled: false, message: "", internalNote: null }, caps),
    ).toEqual({ enabled: false, message: "", internalNote: null });
    for (const bad of [
      { enabled: true, message: " ", internalNote: null },
      { enabled: false, message: "", internalNote: 0 },
      { enabled: true, message: "a".repeat(501), internalNote: "" },
    ])
      expect(() => parseConfig("ui.notice", bad, caps)).toThrow();
  });
});

describe.skipIf(!process.env.PHASE014_FIXTURE_CONFIG)(
  "admin/settings PostgreSQL and actual Route Handlers",
  () => {
    it("[settings] reads exact DTOs and updates every group with paired canonical-hash audits", async () => {
      await withSettings(async ({ fixture, worker, actor }) => {
        const list = parseAdminSettings(
          responseData(
            await worker.request({ method: "GET", path: "/api/admin/settings", session: actor }),
          ),
        );
        expect(list.items.length).toBe(CONFIG_REGISTRY.length);
        const values = {
          "planner.quick.defaultDurationDays": 4,
          "ai.timeoutMs": 30_000,
          "security.adminPageSize": 25,
          "export.maxDurationDays": 25,
          "ui.notice": { enabled: true, message: " 新提示 ", internalNote: null },
        };
        for (const [key, value] of Object.entries(values)) {
          const before = list.items.find((item) => item.key === key)!;
          const response = await worker.request(patch(actor, key, value));
          const setting = parseAdminSetting(responseData(response));
          expect(setting.key).toBe(key);
          expect(setting.revision).toBe(1);
          expect(setting.valueJson).toEqual(parseConfig(key, value, caps));
          expect(response.headers["idempotency-replayed"]).toBe("false");
          const target = await fixture.admin.systemConfig.findUniqueOrThrow({ where: { key } });
          const audits = await fixture.admin.auditLog.findMany({
            where: { action: "CONFIG_UPDATE", targetId: target.id },
          });
          expect(audits.length).toBe(1);
          expect(audits[0].detailJson).toEqual({
            before: { revision: 0, valueHash: canonicalConfigHash(before.valueJson) },
            after: { revision: 1, valueHash: canonicalConfigHash(setting.valueJson) },
            changedFields: ["valueJson", "revision"],
            result: "SUCCESS",
            reasonCode: "CONFIG_CHANGED",
          });
          expect(target.updatedBy).toBe(actor.userId);
        }
        expect(await fixture.admin.adminCommandReceipt.count()).toBe(5);
        observe("group-writes", {
          writes: Object.keys(values).length,
          audits: await fixture.admin.auditLog.count({ where: { action: "CONFIG_UPDATE" } }),
          receipts: await fixture.admin.adminCommandReceipt.count(),
        });
        const saved = await snapshot(fixture);
        failure(
          await worker.request(patch(actor, "secret.apiKey", "forbidden")),
          400,
          "VALIDATION_ERROR",
        );
        failure(
          await worker.request({ ...patch(actor, "ai.timeoutMs", 1), rawBody: '{"valueJson":' }),
          400,
          "VALIDATION_ERROR",
        );
        failure(
          await worker.request(patch(actor, "ai.timeoutMs", 60_001, 1)),
          400,
          "VALIDATION_ERROR",
        );
        failure(
          await worker.request({
            ...patch(actor, "ai.timeoutMs", 10_000, 1),
            body: { valueJson: 10_000, expectedVersion: 1, isPublic: true },
          }),
          400,
          "VALIDATION_ERROR",
        );
        expect(await snapshot(fixture)).toBe(saved);
      });
    }, 90_000);
    it("[settings] admits exactly one same-timestamp CAS winner and persists restart-safe idempotent replay", async () => {
      await withSettings(async ({ fixture, worker, actor }) => {
        const key = "planner.quick.defaultDurationDays";
        await fixture.admin.systemConfig.update({
          where: { key },
          data: { updatedAt: fixture.clock },
        });
        const commands = [patch(actor, key, 6), patch(actor, key, 8)];
        const results = await Promise.all(commands.map((command) => worker.request(command)));
        expect(results.map((row) => row.status).sort()).toEqual([200, 409]);
        const winnerIndex = results.findIndex((row) => row.status === 200);
        const winner = parseAdminSetting(responseData(results[winnerIndex]));
        expect(winner.updatedAt).toBe(fixture.clock.toISOString());
        expect(winner.revision).toBe(1);
        failure(results[1 - winnerIndex], 409, "VERSION_CONFLICT");
        expect(await fixture.admin.auditLog.count({ where: { action: "CONFIG_UPDATE" } })).toBe(1);
        expect(await fixture.admin.adminCommandReceipt.count()).toBe(1);
        await worker.close();
        const restarted = await startApiKeyWorker(fixture, "tests/phase014/worker.ts");
        try {
          const replay = await restarted.request(commands[winnerIndex]);
          expect(responseData(replay)).toEqual(winner);
          expect(replay.headers["idempotency-replayed"]).toBe("true");
          failure(
            await restarted.request({
              ...commands[winnerIndex],
              body: { valueJson: 9, expectedVersion: 0 },
            }),
            409,
            "IDEMPOTENCY_KEY_REUSED",
          );
          responseData(await restarted.request(patch(actor, key, 10, 1)));
          expect(responseData(await restarted.request(commands[winnerIndex]))).toEqual(winner);
          expect(
            (await fixture.admin.systemConfig.findUniqueOrThrow({ where: { key } })).valueJson,
          ).toBe(10);
          expect(await fixture.admin.auditLog.count({ where: { action: "CONFIG_UPDATE" } })).toBe(
            2,
          );
          observe("cas-idempotency", {
            statuses: results.map((row) => row.status).sort(),
            winnerRevision: winner.revision,
            sameTimestamp: winner.updatedAt === fixture.clock.toISOString(),
            auditsAfterReplayAndNextWrite: await fixture.admin.auditLog.count({
              where: { action: "CONFIG_UPDATE" },
            }),
          });
        } finally {
          await restarted.close();
        }
      });
    }, 90_000);
    it("[settings] rolls back configuration and receipts when audit or receipt persistence fails", async () => {
      await withSettings(async ({ fixture, worker, actor }) => {
        const before = await snapshot(fixture);
        for (const table of ["AuditLog", "AdminCommandReceipt"]) {
          await fixture.admin.$executeRawUnsafe(
            `REVOKE INSERT ON "${table}" FROM "${fixture.config.appUser}"`,
          );
          failure(
            await worker.request(patch(actor, "planner.quick.defaultDurationDays", 7)),
            503,
            "INTERNAL_ERROR",
          );
          expect(await snapshot(fixture)).toBe(before);
          observe(`rollback-${table}`, {
            unchanged: (await snapshot(fixture)) === before,
            audits: await fixture.admin.auditLog.count({ where: { action: "CONFIG_UPDATE" } }),
            receipts: await fixture.admin.adminCommandReceipt.count(),
          });
          await fixture.admin.$executeRawUnsafe(
            `GRANT INSERT ON "${table}" TO "${fixture.config.appUser}"`,
          );
        }
        expect(
          parseAdminSetting(
            responseData(
              await worker.request(patch(actor, "planner.quick.defaultDurationDays", 7)),
            ),
          ).revision,
        ).toBe(1);
      });
    }, 90_000);
    it("[settings] rejects invalid persisted keys, group drift and schema bypass instead of displaying a healthy empty list", async () => {
      await withSettings(async ({ fixture, worker, actor }) => {
        const read = () =>
          worker.request({ method: "GET", path: "/api/admin/settings", session: actor });
        const row = await insertUnknown(fixture);
        failure(await read(), 503, "CONFIG_ERROR");
        await fixture.admin.systemConfig.delete({ where: { id: row.id } });
        await fixture.admin.systemConfig.update({
          where: { key: "ai.timeoutMs" },
          data: { valueJson: 600_000 },
        });
        failure(await read(), 503, "CONFIG_ERROR");
        await fixture.admin.systemConfig.update({
          where: { key: "ai.timeoutMs" },
          data: { valueJson: 10_000, group: "UI" },
        });
        failure(await read(), 503, "CONFIG_ERROR");
        expect(await fixture.admin.auditLog.count({ where: { action: "CONFIG_UPDATE" } })).toBe(0);
      });
    }, 90_000);
    it("[public-projection] enforces both visibility gates, strips internal fields and changes ETag only for public projection", async () => {
      await withSettings(async ({ fixture, worker, actor }) => {
        const get = (etag?: string) =>
          worker.request({
            method: "GET",
            path: "/api/config/public",
            headers: etag ? { "if-none-match": etag } : {},
          });
        await fixture.admin.systemConfig.update({
          where: { key: "planner.quick.defaultDurationDays" },
          data: { isPublic: true },
        });
        await insertUnknown(fixture, { private: "must-not-appear" });
        const first = await get();
        expect(responseData(first)).toEqual({
          items: [{ key: "ui.notice", value: { enabled: true, message: "欢迎使用际遇" } }],
        });
        expect(JSON.stringify(first.body)).not.toMatch(
          /internalNote|must-not-appear|planner|仅管理员/,
        );
        expect(first.headers["cache-control"]).toBe("public, max-age=60, must-revalidate");
        expect(first.headers.etag).toMatch(/^W\/"[a-f0-9]{64}"$/);
        expect((await get(first.headers.etag)).status).toBe(304);
        responseData(await worker.request(patch(actor, "planner.quick.defaultDurationDays", 9)));
        expect((await get()).headers.etag).toBe(first.headers.etag);
        responseData(
          await worker.request(
            patch(actor, "ui.notice", {
              ...settingDefaults["ui.notice"],
              internalNote: randomUUID(),
            }),
          ),
        );
        expect((await get()).headers.etag).toBe(first.headers.etag);
        responseData(
          await worker.request(
            patch(
              actor,
              "ui.notice",
              { ...settingDefaults["ui.notice"], message: "更新后的提示" },
              1,
            ),
          ),
        );
        expect((await get()).headers.etag).not.toBe(first.headers.etag);
        await fixture.admin.systemConfig.update({
          where: { key: "ui.notice" },
          data: { isPublic: false },
        });
        expect(responseData(await get())).toEqual({ items: [] });
        const empty = await get();
        expect((await get(empty.headers.etag)).status).toBe(304);
        observe("public-projection", {
          projectedItems: (responseData(first) as { items: unknown[] }).items.length,
          privateFieldsVisible: /internalNote|must-not-appear|planner|仅管理员/.test(
            JSON.stringify(first.body),
          ),
          emptyItems: (responseData(empty) as { items: unknown[] }).items.length,
          conditionalStatus: (await get(empty.headers.etag)).status,
        });
      });
    }, 90_000);
  },
);
