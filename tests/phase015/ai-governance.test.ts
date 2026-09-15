// @vitest-environment node
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalHash } from "@/server/ai/canonical-hash";
import { parsePromptVariables, parsePromptResponse, PROMPT_KEY_CONTRACTS } from "@/lib/ai/schemas";
import contract from "@/lib/ai/prompt-contract.json";
import templates from "@/server/ai/bootstrap-templates.json";
import policy from "@/server/ai/planning-policy-bootstrap.json";
import probes from "@/server/ai/bootstrap-probes.json";
import { parsePlanningPolicy } from "@/server/ai/planning-policy";
import { bootstrapAiGovernance, enableMockAi } from "@/server/services/ai-governance-service";
import { callGuardedAi } from "@/server/ai/guarded-client";
import { resolvePromptSnapshot } from "@/server/services/prompt-service";
import { enableMockWorker } from "./worker";
import {
  phase015Client,
  phase015Config,
  promptInput,
  resetGovernance,
  setAiEnabled,
  syntheticOwner,
} from "./fixture";

const enabled = Boolean(process.env.PHASE015_FIXTURE_CONFIG);
const db = enabled ? phase015Client() : undefined;
beforeEach(async () => {
  if (db) await resetGovernance(db);
});
afterAll(async () => {
  await db?.$disconnect();
});
const actor = () =>
  db!.user.upsert({
    where: { email: "phase015-admin@serendipity.invalid" },
    update: {},
    create: {
      email: "phase015-admin@serendipity.invalid",
      passwordHash: "synthetic",
      role: "ADMIN",
    },
  });
const options = async () => ({
  actorId: (await actor()).id,
  runId: phase015Config().database,
  databaseUrl: phase015Config().appUrl,
});
const call = () =>
  callGuardedAi(
    {
      promptKey: "export.markdown",
      variables: promptInput["export.markdown"],
      userMessage: "synthetic",
      traceId: randomUUID(),
    },
    { db: db!, owner: syntheticOwner() },
  );

describe("Phase015 frozen prompt and policy contracts", () => {
  it("[schema-bootstrap] the eight templates and runtime schemas match reviewed source documents", () => {
    const prompt = [
      ...fs.readFileSync("docs/prompt-design.md", "utf8").matchAll(/```json\s*([\s\S]*?)```/g),
    ].map((x) => JSON.parse(x[1]));
    expect(templates).toEqual(prompt[1].bootstrapTemplates);
    expect(contract.keys).toEqual(prompt[0].keys);
    expect(contract.definitions).toEqual(prompt[0].$defs);
    expect(policy).toEqual(JSON.parse(fs.readFileSync("docs/planning-policy.json", "utf8")));
    for (const key of PROMPT_KEY_CONTRACTS) {
      expect(() => parsePromptVariables(key.key, probes[key.key].input)).not.toThrow();
      expect(() =>
        parsePromptResponse(key.key, JSON.stringify(probes[key.key].output)),
      ).not.toThrow();
      expect(() => parsePromptResponse(key.key, '{"unexpected":true}')).toThrow("SCHEMA_MISMATCH");
      expect(() => parsePromptResponse(key.key, "{")).toThrow("INVALID_JSON");
      expect(() =>
        parsePromptVariables(key.key, { ...probes[key.key].input, extra: "forbidden" }),
      ).toThrow("CONFIG_ERROR");
    }
    expect(() =>
      parsePromptVariables("planner.generate", {
        ...probes["planner.generate"].input,
        requirement: {
          ...probes["planner.generate"].input.requirement,
          dateRange: { startDate: "2026-02-30", endDate: null, isFlexible: false, durationDays: 1 },
        },
      }),
    ).toThrow("CONFIG_ERROR");
    expect(() =>
      parsePromptResponse(
        "export.markdown",
        '{"schemaVersion":1,"markdown":"<script>alert(1)</script>"}',
      ),
    ).toThrow("SCHEMA_MISMATCH");
  });
  it("[schema-bootstrap] typed policy rejects missing groups, wrong units, ranges, decimals and production scope", () => {
    expect(parsePlanningPolicy(policy)).toEqual(policy);
    for (const change of [
      (p: typeof policy) => {
        p.scope = "PRODUCTION";
      },
      (p: typeof policy) => {
        p.freshness.ttlSeconds.value = 0;
      },
      (p: typeof policy) => {
        p.freshness.ttlSeconds.unit = "hour";
      },
      (p: typeof policy) => {
        p.freshness.ttlSeconds.max = 999999;
      },
      (p: typeof policy) => {
        p.planning.budgetTolerance.value = "NaN";
      },
      (p: typeof policy) => {
        p.quality.requireSourceRefs = false;
      },
      (p: typeof policy) => {
        p.freshness.agingAfterSeconds.value = 121;
      },
    ]) {
      const changed = structuredClone(policy);
      change(changed);
      expect(() => parsePlanningPolicy(changed)).toThrow("CONFIG_ERROR");
    }
    expect(() => parsePlanningPolicy({})).toThrow("CONFIG_ERROR");
  });
});

describe.skipIf(!enabled)("Phase015 AI governance database", () => {
  it("[schema-bootstrap] creates the exact final schema with disabled defaults and an idempotent bootstrap", async () => {
    expect(await db!.promptDefinition.count()).toBe(8);
    expect(await db!.promptVersion.count()).toBe(8);
    expect(await db!.promptActivation.count()).toBe(8);
    expect(await db!.promptModelActivation.count({ where: { status: "DISABLED" } })).toBe(8);
    expect(await db!.providerConfigVersion.count()).toBe(1);
    expect(await db!.modelDeployment.count()).toBe(1);
    expect(await db!.planningPolicyVersion.count()).toBe(1);
    expect(await db!.planningPolicyActivation.count()).toBe(1);
    expect(await db!.apiKeyConfig.count({ where: { id: { startsWith: "bootstrap-" } } })).toBe(0);
    expect(
      (await db!.systemConfig.findUniqueOrThrow({ where: { key: "ai.calls.enabled" } })).valueJson,
    ).toBe(false);
    const before = await db!.promptVersion.findMany({ orderBy: { id: "asc" } });
    const repeat = await db!.$transaction((tx) => bootstrapAiGovernance(tx));
    expect(
      Object.values(repeat)
        .filter((x) => typeof x === "number")
        .every((x) => x === 0),
    ).toBe(true);
    expect(await db!.promptVersion.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    const [tables] = await db!.$queryRaw<
      Array<{ prompt: string | null; model: string | null }>
    >`SELECT to_regclass('"PromptConfig"')::text AS prompt,to_regclass('"AiModelConfig"')::text AS model`;
    expect(tables).toEqual({ prompt: null, model: null });
  });
  it("[schema-bootstrap] bootstrap rejects stored provider and model content with copied valid hashes", async () => {
    const provider = await db!.providerConfigVersion.findFirstOrThrow();
    const model = await db!.modelDeployment.findFirstOrThrow();
    await resetGovernance(db!, false);
    await db!.providerConfigVersion.create({
      data: {
        ...provider,
        capabilities: provider.capabilities as Prisma.InputJsonValue,
        timeoutMs: 59000,
      },
    });
    await expect(db!.$transaction((tx) => bootstrapAiGovernance(tx))).rejects.toThrow(
      "CONFIG_ERROR",
    );
    expect(await db!.promptDefinition.count()).toBe(0);
    await resetGovernance(db!, false);
    await db!.providerConfigVersion.create({
      data: { ...provider, capabilities: provider.capabilities as Prisma.InputJsonValue },
    });
    await db!.modelDeployment.create({
      data: {
        ...model,
        paramsJson: model.paramsJson as Prisma.InputJsonValue,
        capabilitiesJson: model.capabilitiesJson as Prisma.InputJsonValue,
        providerModelName: "unexpected-model",
      },
    });
    await expect(db!.$transaction((tx) => bootstrapAiGovernance(tx))).rejects.toThrow(
      "CONFIG_ERROR",
    );
    expect(await db!.promptDefinition.count()).toBe(0);
  });
  it("[schema-bootstrap] the application role cannot update or delete any immutable version", async () => {
    const rows = await db!.$queryRaw<
      Array<{ name: string; update: boolean; delete: boolean; owner: boolean }>
    >`SELECT c.relname AS name,has_table_privilege(current_user,c.oid,'UPDATE') AS update,has_table_privilege(current_user,c.oid,'DELETE') AS delete,c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner FROM pg_class c WHERE c.relname IN ('PromptDefinition','PromptVersion','PlanningPolicyVersion','ProviderConfigVersion','ModelDeployment','AiOutputRecord')`;
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => !r.update && !r.delete && !r.owner)).toBe(true);
    await expect(
      db!.promptVersion.update({
        where: { id: "prompt-nlu-extract-v1" },
        data: { content: "changed" },
      }),
    ).rejects.toThrow();
    await expect(
      db!.promptVersion.delete({ where: { id: "prompt-nlu-extract-v1" } }),
    ).rejects.toThrow();
    await expect(
      db!.$transaction((tx) =>
        tx.promptActivation.update({
          where: { definitionId: "prompt-nlu-extract" },
          data: { revision: 1 },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db!.$transaction(async (tx) => {
        await tx.promptActivation.update({
          where: { definitionId: "prompt-nlu-extract" },
          data: { revision: 4 },
        });
        await tx.promptModelActivation.update({
          where: { definitionId: "prompt-nlu-extract" },
          data: { revision: 4 },
        });
      }),
    ).rejects.toThrow();
  });
  it("[kill-switch] default and restart stay closed; real ADMIN enablement is audited and guarded", async () => {
    expect(await call()).toMatchObject({ ok: false, errorCode: "FEATURE_DISABLED" });
    expect(await db!.aiUsageReservation.count()).toBe(0);
    const audits = await db!.auditLog.count({ where: { action: "CONFIG_UPDATE" } });
    expect(await enableMockAi(db!, await options())).toEqual({ activated: 8, enabled: true });
    expect(await db!.auditLog.count({ where: { action: "CONFIG_UPDATE" } })).toBe(audits + 1);
    expect(
      await db!.adminCommandReceipt.count({ where: { operationId: "patch.admin.settings.key" } }),
    ).toBeGreaterThan(0);
    expect(await db!.aiOutputRecord.count({ where: { status: "SUCCEEDED" } })).toBe(8);
    expect(await call()).toMatchObject({ ok: true });
    await setAiEnabled(db!, false);
    expect((await db!.$transaction((tx) => bootstrapAiGovernance(tx))).aiCallsEnabled).toBe(false);
    const reservations = await db!.aiUsageReservation.count();
    expect(await call()).toMatchObject({ ok: false, errorCode: "FEATURE_DISABLED" });
    expect(await db!.aiUsageReservation.count()).toBe(reservations);
  });
  it("[kill-switch] unauthorized actors and failed fixture preflight leave all activations disabled", async () => {
    const normal = await db!.user.create({
      data: { email: `${randomUUID()}@serendipity.invalid`, passwordHash: "synthetic" },
    });
    const wrongAdmin = await db!.user.create({
      data: {
        email: `${randomUUID()}@serendipity.invalid`,
        passwordHash: "synthetic",
        role: "ADMIN",
      },
    });
    const valid = await options();
    for (const invalid of [
      { ...valid, actorId: normal.id },
      { ...valid, actorId: wrongAdmin.id },
      { ...valid, runId: "phase015_disposable_000000000000" },
      { ...valid, probe: async () => false },
    ])
      await expect(enableMockAi(db!, invalid)).rejects.toThrow("CONFIG_ERROR");
    expect(await db!.promptModelActivation.count({ where: { status: "ACTIVE" } })).toBe(0);
    expect(await db!.aiUsageReservation.count()).toBe(0);
    expect(
      (await db!.systemConfig.findUniqueOrThrow({ where: { key: "ai.calls.enabled" } })).valueJson,
    ).toBe(false);
  });
  it("[kill-switch] failed guarded post-enable probe closes the switch and disables every tuple", async () => {
    await db!.aiUsageReservation.create({
      data: {
        bucketKey: `daily:mock-provider:${new Date().toISOString().slice(0, 10)}`,
        traceId: randomUUID(),
        attemptNo: 1,
        estimatedTokens: 100000,
        estimatedCost: "0",
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    await expect(enableMockAi(db!, await options())).rejects.toThrow("CONFIG_ERROR");
    expect(
      (await db!.systemConfig.findUniqueOrThrow({ where: { key: "ai.calls.enabled" } })).valueJson,
    ).toBe(false);
    expect(await db!.promptModelActivation.count({ where: { status: "ACTIVE" } })).toBe(0);
    expect(await db!.aiOutputRecord.count()).toBe(0);
  });
  it("[schema-bootstrap] invalid but correctly hashed planning policy remains unusable", async () => {
    await enableMockAi(db!, await options());
    const invalid = { schemaVersion: 1, scope: "SYNTHETIC_ONLY" };
    await db!.planningPolicyVersion.create({
      data: {
        id: "invalid-policy",
        version: 2,
        contentJson: invalid,
        contentHash: canonicalHash(invalid),
      },
    });
    await db!.planningPolicyActivation.update({
      where: { policyKey: "default" },
      data: { activeVersionId: "invalid-policy", revision: 1 },
    });
    await expect(
      db!.$transaction((tx) =>
        resolvePromptSnapshot(tx, "nlu.extract", promptInput["nlu.extract"]),
      ),
    ).rejects.toThrow("CONFIG_ERROR");
  });
  it("[kill-switch] the isolated CLI uses the same ADMIN settings service and can be rerun", async () => {
    await actor();
    for (let i = 0; i < 2; i++) {
      const result = await enableMockWorker(process.env.PHASE015_FIXTURE_CONFIG!);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        activated: 8,
        enabled: true,
        productionRequests: 0,
      });
    }
    expect(await db!.aiOutputRecord.count({ where: { status: "SUCCEEDED" } })).toBe(16);
  });
});
