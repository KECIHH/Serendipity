import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { CONFIG_REGISTRY } from "@/server/config/config-registry";
import { stableStringify } from "@/lib/json";
import {
  issueSession,
  startApiKeyWorker,
  withApiKeyDatabase,
  type ApiKeyFixture,
  type ApiKeyWorker,
  type FixtureSession,
} from "../phase013/api-key-fixture";

export const settingDefaults = {
  "planner.quick.defaultDurationDays": 3,
  "planner.quick.defaultTravelerCount": 1,
  "planner.quick.defaultPace": "moderate",
  "ai.timeoutMs": 20_000,
  "export.maxDurationDays": 20,
  "security.adminPageSize": 20,
  "ui.notice": { enabled: true, message: "欢迎使用际遇", internalNote: "仅管理员可见的运行说明" },
} as const;
/** Only measured non-secret counts enter reports; the original raw file is immutable. */
export function observe(kind: string, counts: Record<string, number | boolean | number[]>) {
  const output = process.env.PHASE014_OBSERVATIONS_PATH;
  if (!output) return;
  const config = process.env.PHASE014_FIXTURE_CONFIG;
  if (!config || path.dirname(path.resolve(output)) !== path.dirname(path.resolve(config)))
    throw new Error("Observation path escaped Phase014 fixture");
  fs.appendFileSync(output, `${JSON.stringify({ kind, counts })}\n`);
}
export async function populateSettings(fixture: ApiKeyFixture) {
  for (const entry of CONFIG_REGISTRY) {
    const exists = await fixture.admin.systemConfig.findUnique({ where: { key: entry.key } });
    if (!exists)
      await fixture.admin.systemConfig.create({
        data: {
          key: entry.key,
          valueJson: settingDefaults[entry.key as keyof typeof settingDefaults],
          description: entry.key === "ui.notice" ? "公开界面提示" : entry.key,
          group: entry.group,
          isPublic: entry.defaultVisibility === "PUBLIC",
          createdAt: fixture.clock,
          updatedAt: fixture.clock,
        },
      });
  }
}
export async function snapshot(fixture: ApiKeyFixture) {
  return stableStringify({
    settings: await fixture.admin.systemConfig
      .findMany({
        orderBy: { key: "asc" },
        select: { key: true, valueJson: true, revision: true, updatedAt: true },
      })
      .then((rows) => rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }))),
    audits: await fixture.admin.auditLog.count({ where: { action: "CONFIG_UPDATE" } }),
    receipts: await fixture.admin.adminCommandReceipt.count(),
  });
}
export async function withSettings<T>(
  operation: (context: {
    fixture: ApiKeyFixture;
    worker: ApiKeyWorker;
    actor: FixtureSession;
  }) => Promise<T>,
) {
  return withApiKeyDatabase(async (fixture) => {
    await populateSettings(fixture);
    const actor = await issueSession(fixture, fixture.seed.userId);
    const worker = await startApiKeyWorker(fixture, "tests/phase014/worker.ts");
    try {
      return await operation({ fixture, worker, actor });
    } finally {
      await worker.close();
    }
  });
}
export const patch = (
  session: FixtureSession | undefined,
  key: string,
  valueJson: unknown,
  expectedVersion = 0,
  idempotencyKey = randomUUID(),
) => ({
  method: "PATCH" as const,
  path: `/api/admin/settings/${key}`,
  session,
  body: { valueJson, expectedVersion },
  idempotencyKey,
});
export async function insertUnknown(
  fixture: ApiKeyFixture,
  value: Prisma.InputJsonValue = { internal: "private" },
) {
  return fixture.admin.systemConfig.create({
    data: {
      key: "unknown.privateConfig",
      group: "GENERAL",
      isPublic: true,
      valueJson: value,
      description: "未知键隔离反例",
    },
  });
}
