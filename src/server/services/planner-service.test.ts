// @vitest-environment node
import "../../../tests/phase018/env";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SchemaValidationError } from "@/lib/ai/schema-validation";
import { reserveNluBudget, createNluContext, type NluContext } from "@/server/ai/nlu-context";
import { PLANNER_GENERATE_PROMPT_KEY } from "@/lib/ai/prompts/planner-generate";
import type { TravelRequirement } from "@/lib/ai/schema-types";
import { emptyRequirement } from "@/server/services/nlu/requirement-snapshot";
import { readyRequirement } from "../../../tests/nlu/phase021-fixtures";
import {
  client,
  config,
  initialize,
  mockCallCount,
  resetMockCalls,
} from "../../../tests/phase018/fixture";
import {
  generateTravelPlanSummary,
  PlannerServiceError,
  validateTravelPlanSummaryDraft,
  type SummaryLedger,
} from "./planner-service";

let db: PrismaClient;
const fixedNow = Date.parse("2026-09-03T01:00:00Z");

function context(
  options: { signal?: AbortSignal; tokenBudget?: number; costBudget?: string } = {},
): NluContext {
  return createNluContext(
    {
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      planningMode: "quick",
      ownerContext: { kind: "SYNTHETIC", runId: config().database },
      traceId: `trace_phase022_${randomUUID()}`,
      requestId: `request_phase022_${randomUUID()}`,
      signal: options.signal ?? new AbortController().signal,
      deadlineAt: fixedNow + 30_000,
      tokenBudget: options.tokenBudget ?? 1_000_000,
      costBudget: options.costBudget ?? "5",
    },
    () => fixedNow,
  );
}

function wording(title: string, description: string) {
  return JSON.stringify({
    schemaVersion: 1,
    title,
    description,
    bestFor: ["喜欢美食的旅行者"],
    overallRecommendation: "先核验交通和开放信息，再确定每日安排。",
    recommendedReason: description,
  });
}

function beijing(revision: number, overrides: Partial<TravelRequirement> = {}) {
  return readyRequirement({
    revision,
    destinations: [
      {
        id: "destBeijing",
        name: "北京",
        city: "北京",
        country: "CN",
        type: "city",
        confidence: 1,
      },
    ],
    preferences: {
      ...emptyRequirement().preferences,
      pace: "moderate",
      interests: ["美食"],
      confidence: 1,
    },
    ...overrides,
  });
}

beforeAll(async () => {
  db = client();
  await initialize(db);
  for (const [key, valueJson, description] of [
    ["planner.quick.defaultDurationDays", 3, "默认快速规划天数"],
    ["planner.quick.defaultTravelerCount", 1, "默认快速规划人数"],
    ["planner.quick.defaultPace", "moderate", "默认快速规划节奏"],
  ] as const) {
    await db.systemConfig.upsert({
      where: { key },
      create: { key, valueJson, description, group: "GENERAL", isPublic: false },
      update: { valueJson },
    });
  }
}, 120_000);

beforeEach(() => {
  resetMockCalls();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("planner summary", () => {
  it("单元：解析需求、生成完整概要并通过草稿校验", async () => {
    const records = await db.travelRecord.count();
    const ledger: SummaryLedger = new Map();
    const result = await generateTravelPlanSummary(beijing(3), context(), {
      db,
      ledger,
      mockProfileVerified: true,
      mockOutput: wording(
        "北京三日美食",
        "围绕北京安排三日，预算3000元，偏好美食，具体开放信息仍需核验。",
      ),
    });
    expect(result.summary.title, "SUMMARY_FIELDS_REQUIRED").toContain("北京");
    expect(result.summary.durationDays).toBe(3);
    expect(result.summary).toMatchObject({
      schemaVersion: 1,
      requirementRevision: 3,
      bestFor: ["喜欢美食的旅行者"],
    });
    expect(result.summary.description.length).toBeGreaterThan(0);
    expect(result.summary.overallRecommendation.length).toBeGreaterThan(0);
    expect(result.summary.recommendedReason.length).toBeGreaterThan(0);
    expect(validateTravelPlanSummaryDraft(result.summary)).toEqual(result.summary);
    expect(result.handoff).toMatchObject({
      handoffStage: "REQUIREMENT_SUMMARY",
      formalPlanWritten: false,
      sourceRefs: [],
      orderedDestinationIds: ["destBeijing"],
    });
    expect(result).not.toHaveProperty("planJson");
    expect(result.summary).not.toHaveProperty("planJson");
    expect(await db.travelRecord.count()).toBe(records);
    const prompt = await db.promptDefinition.findUniqueOrThrow({
      where: { key: PLANNER_GENERATE_PROMPT_KEY },
      include: { versions: true },
    });
    expect(prompt.versions.map((item) => item.version)).toEqual([1]);
    const source = readFileSync(
      new URL("../../lib/ai/prompts/planner-generate.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("You produce bounded candidate JSON");
  });

  it("集成：两个目的地保持原顺序且不折叠成字符串", async () => {
    const requirement = beijing(4, {
      destinations: [
        {
          id: "destBeijing",
          name: "北京",
          city: "北京",
          country: "CN",
          type: "city",
          confidence: 1,
        },
        {
          id: "destShanghai",
          name: "上海",
          city: "上海",
          country: "CN",
          type: "city",
          confidence: 1,
        },
      ],
    });
    const result = await generateTravelPlanSummary(requirement, context(), {
      db,
      ledger: new Map(),
      mockProfileVerified: true,
      mockOutput: wording(
        "北京、上海三日",
        "按北京、上海的顺序安排三日，预算3000元，偏好美食，细节仍需核验。",
      ),
    });
    expect(
      result.summary.destinations.map((item) => item.name),
      "DESTINATION_ORDER_REQUIRED",
    ).toEqual(["北京", "上海"]);
    expect(result.handoff.orderedDestinationIds).toEqual(["destBeijing", "destShanghai"]);
    expect("destination" in result.summary).toBe(false);
    expect(result.summary.durationDays).toBe(3);
  });

  it("反向：空目的地拒绝且不生成默认值", async () => {
    const calls = mockCallCount();
    let caught: unknown;
    try {
      await generateTravelPlanSummary(beijing(1, { destinations: [] }), context(), {
        db,
        ledger: new Map(),
        mockProfileVerified: true,
        mockOutput: wording("默认城市", "不应生成。"),
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as PlannerServiceError | undefined)?.reason, "EMPTY_DESTINATIONS_REJECTED").toBe(
      "EMPTY_DESTINATIONS",
    );
    expect(mockCallCount(), "EMPTY_DESTINATIONS_REJECTED").toBe(calls);
  });

  it("反向：多目的地折叠成字符串时拒绝", async () => {
    const calls = mockCallCount();
    const folded = { ...beijing(2), destinations: "北京,上海" } as unknown as TravelRequirement;
    let caught: unknown;
    try {
      await generateTravelPlanSummary(folded, context(), { db, ledger: new Map() });
    } catch (error) {
      caught = error;
    }
    expect((caught as PlannerServiceError | undefined)?.reason, "FOLDED_DESTINATION_REJECTED").toBe(
      "FOLDED_DESTINATION",
    );
    expect(mockCallCount(), "FOLDED_DESTINATION_REJECTED").toBe(calls);
  });

  it("反向：与需求冲突的偏好不得进入概要", async () => {
    let caught: unknown;
    try {
      await generateTravelPlanSummary(beijing(5), context(), {
        db,
        ledger: new Map(),
        mockProfileVerified: true,
        mockOutput: wording("北京快节奏滑雪", "改成滑雪和快节奏，预算9999元，安排五日。"),
      });
    } catch (error) {
      caught = error;
    }
    expect(
      (caught as PlannerServiceError | undefined)?.reason,
      "CONFLICTING_PREFERENCE_REJECTED",
    ).toBe("CONFLICTING_PREFERENCE");
  });

  it("反向：删除草稿必需字段时校验失败", async () => {
    const result = await generateTravelPlanSummary(beijing(11), context(), {
      db,
      ledger: new Map(),
      mockProfileVerified: true,
      mockOutput: wording(
        "北京三日美食",
        "围绕北京安排三日，预算3000元，偏好美食，具体开放信息仍需核验。",
      ),
    });
    const broken = { ...result.summary };
    delete (broken as { recommendedReason?: string }).recommendedReason;
    expect(() => validateTravelPlanSummaryDraft(broken), "SUMMARY_SCHEMA_REQUIRED").toThrow(
      SchemaValidationError,
    );
  });

  it("同一 revision 重试幂等，hash 变化要求新 revision", async () => {
    const ledger: SummaryLedger = new Map();
    const requirement = beijing(6);
    const first = await generateTravelPlanSummary(requirement, context(), {
      db,
      ledger,
      mockProfileVerified: true,
      mockOutput: wording(
        "北京三日美食",
        "围绕北京安排三日，预算3000元，偏好美食，具体开放信息仍需核验。",
      ),
    });
    const calls = mockCallCount();
    const second = await generateTravelPlanSummary(requirement, context(), {
      db,
      ledger,
      mockProfileVerified: true,
      mockOutput: wording("另一份文案", "不应再次外呼。"),
    });
    expect(second.replayed).toBe(true);
    expect(second.summary).toEqual(first.summary);
    expect(mockCallCount()).toBe(calls);
    const changed = beijing(6, {
      budget: { ...requirement.budget, amount: "4000" },
    });
    await expect(
      generateTravelPlanSummary(changed, context(), { db, ledger, mockProfileVerified: true }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", reason: "REVISION_HASH_CONFLICT" });
    expect(mockCallCount()).toBe(calls);
  });

  it("取消和预算耗尽时零外呼", async () => {
    const calls = mockCallCount();
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      generateTravelPlanSummary(beijing(7), context({ signal: aborted.signal }), { db }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    const limited = context({ tokenBudget: 1, costBudget: "0" });
    reserveNluBudget(limited, 1, new Prisma.Decimal(0));
    await expect(generateTravelPlanSummary(beijing(8), limited, { db })).rejects.toMatchObject({
      code: "COST_LIMIT",
    });
    expect(mockCallCount()).toBe(calls);
  });

  it("快速默认时长可见，且不会写成用户明确事实", async () => {
    const requirement = beijing(9, { durationDays: null, dateRange: null });
    const result = await generateTravelPlanSummary(requirement, context(), {
      db,
      ledger: new Map(),
      mockProfileVerified: true,
      mockOutput: wording("北京三日", "按已登记的默认时长安排3天，偏好美食，细节仍需核验。"),
    });
    expect(result.summary.durationDays).toBe(3);
    expect(result.handoff.assumptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "durationDays",
          source: "REGISTERED_QUICK_DEFAULT",
          value: 3,
        }),
      ]),
    );
    expect(result.summary.description).not.toMatch(/用户明确|您已确定|你已经确定/);
    expect(result.handoff.formalPlanWritten).toBe(false);
  });

  it("缺少上下文入口字段时失败", async () => {
    await expect(generateTravelPlanSummary(beijing(10), {} as NluContext)).rejects.toBeInstanceOf(
      PlannerServiceError,
    );
    await expect(generateTravelPlanSummary(beijing(10), {} as NluContext)).rejects.toMatchObject({
      code: "CONFIG_ERROR",
      reason: "CONTEXT",
    });
  });
});
