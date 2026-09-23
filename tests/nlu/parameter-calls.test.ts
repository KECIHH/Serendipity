// @vitest-environment node
import "../phase018/env";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNluContext } from "@/server/ai/nlu-context";
import {
  extractTravelParameters,
  NLU_PARAMETER_PROMPT_VERSION_ID,
} from "@/server/services/nlu/extract-parameters";
import { NLU_EXTRACT_PROMPT_KEY } from "@/lib/ai/prompts/nlu-extract";
import { client, config, initialize } from "../phase018/fixture";

let db: PrismaClient;
const fixedNow = Date.parse("2026-09-03T01:00:00Z");

function guardedContext() {
  return createNluContext(
    {
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      planningMode: "quick",
      ownerContext: { kind: "SYNTHETIC", runId: config().database },
      traceId: `trace_phase020_parameters_${randomUUID()}`,
      requestId: `request_phase020_parameters_${randomUUID()}`,
      signal: new AbortController().signal,
      deadlineAt: fixedNow + 30_000,
      tokenBudget: 1_000_000,
      costBudget: "5",
    },
    () => fixedNow,
  );
}

beforeAll(async () => {
  db = client();
  await initialize(db);
}, 120_000);

afterAll(async () => {
  await db.$disconnect();
});

describe("travel parameter guarded calls", () => {
  it("guarded call: 带爸妈人均预算和美食", async () => {
    const value = await extractTravelParameters(
      "带爸妈去云南，预算人均3000元，喜欢美食",
      guardedContext(),
      {
        db,
        mockProfileVerified: true,
        mockOutput: JSON.stringify({
          schemaVersion: 1,
          candidates: [
            { field: "travelers", text: "带爸妈", confidence: 1 },
            { field: "budget", text: "预算人均3000元", confidence: 1 },
            { field: "preferences.interests", text: "美食", confidence: 1 },
          ],
        }),
      },
    );
    expect(value.travelers.hasElder, "PARAMETER_ELDER_REQUIRED").toBeNull();
    expect(value.budget).toMatchObject({ amount: "3000", currency: "CNY", perPerson: true });
    expect(value.preferences.interests).toContain("美食");
    const active = await db.promptDefinition.findUniqueOrThrow({
      where: { key: NLU_EXTRACT_PROMPT_KEY },
      include: { versions: true, activation: { include: { championVersion: true } } },
    });
    const versions = [...active.versions].sort((left, right) => left.version - right.version);
    expect(versions.map((item) => item.version)).toEqual([1, 2]);
    expect(versions[1]?.id).toBe(NLU_PARAMETER_PROMPT_VERSION_ID);
    expect(versions[1]?.content.startsWith(versions[0]?.content ?? "")).toBe(true);
    expect(active.activation?.championVersionId).toBe(NLU_PARAMETER_PROMPT_VERSION_ID);
  });
  it("guarded call: 情侣预算一万不猜测币种", async () => {
    const value = await extractTravelParameters("情侣去哈尔滨看雪，预算一万", guardedContext(), {
      db,
      mockProfileVerified: true,
      mockOutput: JSON.stringify({
        schemaVersion: 1,
        candidates: [
          { field: "travelers", text: "情侣", confidence: 1 },
          { field: "budget", text: "预算一万", confidence: 1 },
        ],
      }),
    });
    expect(value.travelers.isCouple).toBe(true);
    expect(value.budget).toMatchObject({ amount: "10000", currency: null, perPerson: false });
  });
  it("guarded call: malformed provider output fails without partial parameters", async () => {
    await expect(
      extractTravelParameters("预算一万", guardedContext(), {
        db,
        mockProfileVerified: true,
        mockFailureMode: "invalid_json",
      }),
    ).rejects.toThrow("PROVIDER_UNAVAILABLE");
  });
  it("guarded call: timeout rejects without partial parameters", async () => {
    await expect(
      extractTravelParameters("预算一万", guardedContext(), {
        db,
        mockProfileVerified: true,
        mockFailureMode: "timeout",
      }),
    ).rejects.toThrow("PROVIDER_TIMEOUT");
  });
  it("guarded call: cancelled context never resets request limits", async () => {
    const ctx = guardedContext();
    const cancelled = createNluContext(
      {
        timezone: ctx.timezone,
        locale: ctx.locale,
        planningMode: ctx.planningMode,
        ownerContext: ctx.ownerContext,
        traceId: ctx.traceId,
        requestId: ctx.requestId,
        signal: AbortSignal.abort(),
        deadlineAt: fixedNow + 1,
        tokenBudget: 1,
        costBudget: "0",
      },
      () => fixedNow,
    );
    await expect(extractTravelParameters("预算一万", cancelled, { db })).rejects.toThrow(
      "CANCELLED",
    );
  });
});
