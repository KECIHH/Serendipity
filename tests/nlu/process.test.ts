// @vitest-environment node
import "../phase018/env";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNluContext, type NluContext } from "@/server/ai/nlu-context";
import { detectMissingFields } from "@/server/services/nlu/detect-missing";
import { processNLUInput } from "@/server/services/nlu/process-input";
import { client, config, initialize } from "../phase018/fixture";

let db: PrismaClient;
const fixedNow = Date.parse("2026-09-03T00:00:00Z");
const policy = {
  planningMode: "precise" as const,
  quickDefaults: { durationDays: 3, travelerCount: 1, pace: "moderate" as const },
};
const capabilities = { selfDriving: true, hiking: true, overseas: true };

function ctx(
  planningMode: NluContext["planningMode"],
  signal = new AbortController().signal,
): NluContext {
  return createNluContext(
    {
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      planningMode,
      ownerContext: { kind: "SYNTHETIC", runId: config().database },
      traceId: `trace_phase021_process_${randomUUID()}`,
      requestId: `request_phase021_process_${randomUUID()}`,
      signal,
      deadlineAt: fixedNow + 30_000,
      tokenBudget: 1_000_000,
      costBudget: "5",
    },
    () => fixedNow,
  );
}

function mock(candidates: readonly { field: string; text: string; confidence: number }[]) {
  return JSON.stringify({ schemaVersion: 1, candidates });
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

afterAll(async () => {
  await db.$disconnect();
});

describe("nlu process input", () => {
  it("从一句话到追问回答后生成完整 JSON", async () => {
    const first = await processNLUInput("想出去玩", null, 0, ctx("precise"), {
      db,
      mockProfileVerified: true,
      mockOutput: mock([]),
    });
    expect(first.confirmationStatus).toBe("NEEDS_INFORMATION");
    expect(first.recordStatus).toBe("NEEDS_INFO");
    expect(
      first.missingFields
        .filter((item) => item.field === "destinations" || item.field === "dateRange")
        .map((item) => item.priority),
    ).toEqual(["blocking", "blocking"]);
    expect(first.questions.length).toBeGreaterThan(0);
    expect(first.questions.length).toBeLessThanOrEqual(3);
    expect(first.questions.every((item) => item.trim() && !item.startsWith("请输入"))).toBe(true);
    const previous = structuredClone(first.requirement);
    const second = await processNLUInput(
      "这周末去武功山",
      first.requirement,
      first.requirement.revision,
      ctx("precise"),
      {
        db,
        mockProfileVerified: true,
        stageOutputs: {
          CORE: mock([
            { field: "destinations", text: "武功山", confidence: 1 },
            { field: "dateRange", text: "这周末", confidence: 1 },
          ]),
          PARAMETERS: mock([]),
          CONSTRAINTS: mock([]),
        },
      },
    );
    expect(first.requirement).toEqual(previous);
    expect(second.requirement.destinations.map((item) => item.name)).toEqual(["武功山"]);
    expect(second.requirement.dateRange?.startDate).toBe("2026-09-05");
    expect(
      second.requirement.missingFields.some(
        (item) => item.field === "destinations" || item.field === "dateRange",
      ),
    ).toBe(false);
    expect(second.requirement.revision).toBe(first.requirement.revision + 1);
    expect(second.questions.length).toBeLessThanOrEqual(3);
  });

  it("quick模式江西上饶可规划且precise追问日期", async () => {
    const quick = await processNLUInput("江西上饶旅行攻略", null, 0, ctx("quick"), {
      db,
      mockProfileVerified: true,
      stageOutputs: {
        CORE: mock([{ field: "destinations", text: "上饶", confidence: 1 }]),
        PARAMETERS: mock([]),
        CONSTRAINTS: mock([]),
      },
    });
    expect(quick.confirmationStatus).toBe("READY_FOR_PLANNING");
    expect(quick.recordStatus).toBe("DRAFT");
    expect(quick.requirement.destinations.map((item) => item.name)).toContain("上饶");
    expect(quick.missingFields.some((item) => item.priority === "blocking")).toBe(false);
    const precise = detectMissingFields(
      quick.requirement,
      ctx("precise"),
      { ...policy, planningMode: "precise" },
      capabilities,
    );
    expect(precise.some((item) => item.field === "dateRange" && item.priority === "blocking")).toBe(
      true,
    );
    const blocked = detectMissingFields(
      { ...quick.requirement, destinations: [] },
      ctx("quick"),
      { ...policy, planningMode: "quick" },
      capabilities,
    );
    expect(
      blocked.some((item) => item.field === "destinations" && item.priority === "blocking"),
    ).toBe(true);
  });

  it("取消后下游调用为零且缺目的地阻断", async () => {
    const calls = { count: 0 };
    const controller = new AbortController();
    const cancelled = ctx("precise", controller.signal);
    controller.abort();
    await expect(
      processNLUInput("江西上饶旅行攻略", null, 0, cancelled, {
        db,
        calls,
        mockProfileVerified: true,
        mockOutput: mock([{ field: "destinations", text: "上饶", confidence: 1 }]),
      }),
    ).rejects.toThrow("CANCELLED");
    expect(calls.count).toBe(0);
  });
});
