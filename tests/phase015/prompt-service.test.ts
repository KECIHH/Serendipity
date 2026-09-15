// @vitest-environment node
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalHash } from "@/server/ai/canonical-hash";
import { resolvePromptSnapshot, activatePromptModelTuple } from "@/server/services/prompt-service";
import { resolveModelSnapshot } from "@/server/services/model-resolution-service";
import { callGuardedAi } from "@/server/ai/guarded-client";
import {
  ensurePhase015Enabled,
  phase015Client,
  phase015OwnerClient,
  promptInput,
  resetGovernance,
  syntheticOwner,
  createDeployment,
  activateFixture,
} from "./fixture";

const enabled = Boolean(process.env.PHASE015_FIXTURE_CONFIG);
const db = enabled ? phase015Client() : undefined;
afterAll(async () => {
  await db?.$disconnect();
});
beforeEach(async () => {
  if (db) {
    await resetGovernance(db);
    await ensurePhase015Enabled(db);
  }
});
const key = "nlu.extract",
  definitionId = "prompt-nlu-extract";
const resolve = () =>
  db!.$transaction((tx) => resolvePromptSnapshot(tx, key, promptInput[key]), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
async function changeVersion(
  data: {
    content?: string;
    contentHash?: string;
    variablesJson?: Prisma.InputJsonValue;
    responseSchemaVersion?: number;
  } = {},
) {
  const version = await db!.promptVersion.findUniqueOrThrow({
    where: { id: `${definitionId}-v1` },
  });
  const content = data.content ?? `${version.content}\nSynthetic revision two.`;
  await db!.promptVersion.create({
    data: {
      ...version,
      id: `${definitionId}-v2`,
      version: 2,
      variablesJson: version.variablesJson as Prisma.InputJsonValue,
      content,
      contentHash: canonicalHash(content),
      ...data,
    },
  });
  await db!.$transaction((tx) =>
    activatePromptModelTuple(tx, {
      definitionId,
      promptVersionId: `${definitionId}-v2`,
      deploymentId: "mock-model",
      deploymentConfigVersion: 1,
      providerId: "mock-provider",
      providerConfigVersion: 1,
    }),
  );
}
async function zeroAttempt() {
  const traceId = randomUUID();
  const result = await callGuardedAi(
    {
      promptKey: key,
      variables: promptInput[key],
      userMessage: "synthetic resolution check",
      traceId,
    },
    { db: db!, owner: syntheticOwner() },
  );
  expect(result).toMatchObject({ ok: false, errorCode: "CONFIG_ERROR" });
  expect(await db!.aiUsageReservation.count({ where: { traceId } })).toBe(0);
}

describe.skipIf(!enabled)("Phase015 prompt resolution", () => {
  it("[resolution] resolves exact immutable versions and accepts a compatible prompt version two", async () => {
    const first = await resolve();
    expect(first).toMatchObject({
      promptKey: key,
      promptVersion: 1,
      promptVersionId: `${definitionId}-v1`,
      planningPolicyVersionId: "planning-policy-v1",
      model: { deploymentId: "mock-model", deploymentConfigVersion: 1 },
      provider: { providerId: "mock-provider", configVersion: 1, mode: "MOCK" },
    });
    await changeVersion();
    const next = await resolve();
    expect(next.promptVersion).toBe(2);
    expect(next.promptVersionId).toBe(`${definitionId}-v2`);
    expect(next.activationRevision).toBe(first.activationRevision + 1);
  });
  it("[resolution] rejects missing, unknown, nullable and structurally invalid variables", async () => {
    for (const input of [
      { ...promptInput[key], extra: "x" },
      { locale: "zh-CN" },
      { ...promptInput[key], userText: null },
      { ...promptInput[key], locale: "not_a_locale" },
      { ...promptInput[key], stage: "UNKNOWN" },
    ])
      await expect(db!.$transaction((tx) => resolvePromptSnapshot(tx, key, input))).rejects.toThrow(
        "CONFIG_ERROR",
      );
    await expect(
      db!.$transaction((tx) => resolvePromptSnapshot(tx, "unknown", {})),
    ).rejects.toThrow("CONFIG_ERROR");
  });
  it("[resolution] both resolvers reject disabled tuples and stale activation CAS", async () => {
    const old = await db!.promptActivation.findUniqueOrThrow({ where: { definitionId } });
    const tuple = {
      definitionId,
      promptVersionId: `${definitionId}-v1`,
      deploymentId: "mock-model",
      deploymentConfigVersion: 1,
      providerId: "mock-provider",
      providerConfigVersion: 1,
    };
    await db!.$transaction((tx) =>
      activatePromptModelTuple(tx, {
        ...tuple,
        status: "DISABLED",
        expectedRevision: old.revision,
      }),
    );
    await expect(resolve()).rejects.toThrow("CONFIG_ERROR");
    await expect(db!.$transaction((tx) => resolveModelSnapshot(tx, definitionId))).rejects.toThrow(
      "CONFIG_ERROR",
    );
    await zeroAttempt();
    await expect(
      db!.$transaction((tx) =>
        activatePromptModelTuple(tx, { ...tuple, expectedRevision: old.revision }),
      ),
    ).rejects.toThrow("CONFIG_ERROR");
  });
  it("[resolution] absent activation pointers fail closed before creating reservations", async () => {
    const owner = phase015OwnerClient();
    try {
      await owner.$transaction(async (tx) => {
        await tx.promptModelActivation.delete({ where: { definitionId } });
        await tx.promptActivation.delete({ where: { definitionId } });
      });
    } finally {
      await owner.$disconnect();
    }
    await expect(resolve()).rejects.toThrow("CONFIG_ERROR");
    await zeroAttempt();
  });
  it("[resolution] invalid prompt hash is rejected before egress", async () => {
    await changeVersion({ contentHash: "0".repeat(64) });
    await expect(resolve()).rejects.toThrow("CONFIG_ERROR");
    await zeroAttempt();
  });
  it("[resolution] variable schema drift and incompatible response schema are rejected", async () => {
    await changeVersion({ variablesJson: [], responseSchemaVersion: 99 });
    await expect(resolve()).rejects.toThrow("CONFIG_ERROR");
    await zeroAttempt();
  });
  it("[resolution] provider locale, model context and unpriced bounds cannot be activated for a call", async () => {
    for (const options of [
      { locale: "en-US" },
      { contextWindowTokens: 2048 },
      {
        pricing: {
          inputPerToken: "0",
          outputPerToken: "0",
          fixedPerRequest: "0",
          basis: "UNKNOWN",
        },
      },
    ]) {
      const tuple = await createDeployment(db!, options);
      await activateFixture(db!, key, tuple);
      await expect(resolve()).rejects.toThrow("CONFIG_ERROR");
      await zeroAttempt();
    }
    const incompatible = await createDeployment(db!, { capabilities: ["export.markdown"] });
    await expect(activateFixture(db!, key, incompatible)).rejects.toThrow("CONFIG_ERROR");
  });
  it("[resolution] database rejects cross-definition and cross-provider tuple references", async () => {
    const tuple = await createDeployment(db!);
    await expect(
      db!.$transaction((tx) =>
        activatePromptModelTuple(tx, {
          definitionId,
          promptVersionId: "prompt-export-markdown-v1",
          ...tuple,
        }),
      ),
    ).rejects.toThrow("CONFIG_ERROR");
    await expect(
      db!.$transaction(async (tx) => {
        const old = await tx.promptActivation.findUniqueOrThrow({ where: { definitionId } });
        await tx.promptActivation.update({
          where: { definitionId },
          data: { revision: old.revision + 1 },
        });
        await tx.promptModelActivation.update({
          where: { definitionId },
          data: { ...tuple, providerId: "mock-provider", revision: old.revision + 1 },
        });
      }),
    ).rejects.toThrow();
  });
  it("[resolution] concurrent tuple switches expose only complete old or new snapshots", async () => {
    const old = {
      definitionId,
      promptVersionId: `${definitionId}-v1`,
      deploymentId: "mock-model",
      deploymentConfigVersion: 1,
      providerId: "mock-provider",
      providerConfigVersion: 1,
    };
    const model = await createDeployment(db!, {
      providerId: "mock-provider",
      providerVersion: 2,
      deploymentId: "mock-model",
      deploymentVersion: 2,
    });
    await changeVersion();
    const next = { definitionId, promptVersionId: `${definitionId}-v2`, ...model };
    await db!.$transaction((tx) => activatePromptModelTuple(tx, old));
    const observed: string[] = [];
    async function reader() {
      for (let i = 0; i < 10; i++) {
        // The service locks both pointers; READ COMMITTED and REPEATABLE READ both reject mixed rows.
        const row = await db!.$transaction(
          (tx) => resolvePromptSnapshot(tx, key, promptInput[key]),
          { timeout: 15000 },
        );
        observed.push(
          `${row.promptVersion}:${row.model.deploymentConfigVersion}:${row.provider.configVersion}`,
        );
      }
    }
    await Promise.all([
      reader(),
      reader(),
      (async () => {
        for (let i = 0; i < 8; i++)
          await db!.$transaction((tx) => activatePromptModelTuple(tx, i % 2 ? old : next));
      })(),
    ]);
    expect(observed).toHaveLength(20);
    expect(observed.every((x) => x === "1:1:1" || x === "2:2:2")).toBe(true);
    expect((await resolve()).activationRevision).toBeGreaterThan(8);
  });
});
