// @vitest-environment node
import "../phase018/env";
import { describe, expect, it } from "vitest";
import type { TravelRequirement } from "@/lib/ai/schema-types";
import {
  mergeRequirements,
  replayOrMerge,
  type RequirementPatch,
} from "@/server/services/nlu/merge-requirements";
import { emptyRequirement } from "@/server/services/nlu/requirement-snapshot";
import { fixtureContext, requirement } from "./phase021-fixtures";

const ctx = fixtureContext("precise", true);
const policy = {
  planningMode: "precise" as const,
  quickDefaults: { durationDays: 3, travelerCount: 1, pace: "moderate" as const },
};
const capabilities = { selfDriving: true, hiking: true, overseas: true };
const place = (id: string, name: string): TravelRequirement["destinations"][number] => ({
  id,
  name,
  city: null,
  country: "CN",
  type: name === "武功山" ? "attraction" : "province",
  confidence: 1,
});

async function apply(current: TravelRequirement, patch: RequirementPatch) {
  return mergeRequirements(current, patch, ctx, { policy, capabilities, hash: "b".repeat(64) });
}

describe("requirement merge", () => {
  it("首轮输入", async () => {
    const current = emptyRequirement();
    const snapshot = structuredClone(current);
    const destination = place("placeWugong", "武功山");
    const result = await apply(current, {
      baseRevision: 0,
      set: {},
      clearFields: [],
      arrayOps: [{ field: "destinations", op: "add", values: [destination] }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextRevision).toBe(1);
    expect(result.requirement.revision).toBe(1);
    expect(result.requirement.destinations).toEqual([destination]);
    expect(result.diff).toContainEqual({ field: "destinations", before: [], after: [destination] });
    expect(current).toEqual(snapshot);
  });

  it("第二轮补充时间", async () => {
    const current = requirement({
      destinations: [place("placeWugong", "武功山")],
      fieldSources: [
        {
          field: "destinations",
          messageId: null,
          inputHash: "a".repeat(64),
          method: "USER_TEXT",
          confidence: 1,
        },
      ],
      missingFields: [
        {
          field: "dateRange",
          priority: "blocking",
          question: "想什么时候出发？",
          reason: "精确规划还缺少出发日期。",
        },
      ],
    });
    const dateRange = {
      startDate: "2026-09-05",
      endDate: "2026-09-06",
      text: "这周末",
      isFlexible: false,
      timezone: "Asia/Shanghai",
      confidence: 1,
    };
    const result = await apply(current, {
      baseRevision: 0,
      set: { dateRange },
      clearFields: [],
      arrayOps: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextRevision).toBe(1);
    expect(result.requirement.dateRange).toEqual(dateRange);
    expect(
      result.requirement.missingFields.some((item) => item.field === "dateRange"),
      "MISSING_FIELDS_RECALCULATED",
    ).toBe(false);
    expect(current.dateRange).toBeNull();
    expect(current.missingFields.some((item) => item.field === "dateRange")).toBe(true);
  });

  it("覆盖目的地", async () => {
    const original = place("placeJiangxi", "江西");
    const replacement = place("placeYunnan", "云南");
    const current = requirement({ revision: 1, destinations: [original] });
    const snapshot = structuredClone(current);
    const result = await apply(current, {
      baseRevision: 1,
      set: { destinations: [replacement] },
      clearFields: [],
      arrayOps: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextRevision).toBe(2);
    expect(result.requirement.destinations).toEqual([replacement]);
    expect(result.diff).toContainEqual({
      field: "destinations",
      before: [original],
      after: [replacement],
    });
    expect(current).toEqual(snapshot);
  });

  it("数组 add 去重", async () => {
    const destination = place("placeWugong", "武功山");
    const result = await apply(emptyRequirement(), {
      baseRevision: 0,
      set: {},
      clearFields: [],
      arrayOps: [{ field: "destinations", op: "add", values: [destination, destination] }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requirement.destinations).toEqual([destination]);
    expect(result.nextRevision).toBe(1);
  });

  it("数组 remove", async () => {
    const kept = place("placeJiangxi", "江西");
    const removed = place("placeYunnan", "云南");
    const current = requirement({ revision: 2, destinations: [kept, removed] });
    const snapshot = structuredClone(current);
    const result = await apply(current, {
      baseRevision: 2,
      set: {},
      clearFields: [],
      arrayOps: [{ field: "destinations", op: "remove", values: [removed] }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requirement.destinations).toEqual([kept]);
    expect(result.nextRevision).toBe(3);
    expect(current).toEqual(snapshot);
  });

  it("显式 clear", async () => {
    const current = requirement({
      revision: 1,
      origin: { city: "深圳", country: "CN", confidence: 1 },
    });
    const snapshot = structuredClone(current);
    const result = await apply(current, {
      baseRevision: 1,
      set: {},
      clearFields: ["origin"],
      arrayOps: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requirement.origin).toBeNull();
    expect(result.nextRevision).toBe(2);
    expect(result.diff).toContainEqual({ field: "origin", before: current.origin, after: null });
    expect(current).toEqual(snapshot);
  });

  it("同 patch 重放", async () => {
    const patch: RequirementPatch = {
      baseRevision: 0,
      set: {},
      clearFields: [],
      arrayOps: [{ field: "preferences.transport", op: "add", values: ["self_driving"] }],
    };
    const ledger = new Map();
    const first = await replayOrMerge(ledger, emptyRequirement(), patch, ctx, {
      policy,
      capabilities,
      hash: "c".repeat(64),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replayed = await replayOrMerge(ledger, first.requirement, patch, ctx, {
      policy,
      capabilities,
      hash: "c".repeat(64),
    });
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.nextRevision).toBe(first.nextRevision);
    expect(replayed.requirement.preferences.transport).toEqual(["self_driving"]);
    expect(replayed.requirement).toBe(first.requirement);
  });

  it("stale baseRevision", async () => {
    const current = requirement({
      revision: 4,
      origin: { city: "深圳", country: "CN", confidence: 1 },
    });
    const snapshot = structuredClone(current);
    const result = await apply(current, {
      baseRevision: 3,
      set: {},
      clearFields: ["origin"],
      arrayOps: [],
    });
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      code: "VERSION_CONFLICT",
      currentRevision: 4,
      reload: true,
    });
    expect(current).toEqual(snapshot);
  });
});
