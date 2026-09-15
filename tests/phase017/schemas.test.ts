// @vitest-environment node
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TravelRequirementSchema,
  TravelPlanSummaryDraftSchema,
  PromptOutputSchemas,
  parsePromptResponse,
  validatePromptReferences,
  type RuntimeSchema,
} from "@/lib/ai/schemas";
import { safeParseAiJson } from "@/lib/ai/json-parser";
import { requirementHash } from "@/server/ai/canonical-hash";
import { validateSummaryBinding } from "@/server/ai/summary-binding";
import fixtures from "./fixtures.json";
import travel from "@/lib/ai/travel-contract.json";

describe("frozen AI schemas", () => {
  it.each(fixtures.requirementCases)("schema: requirement v1 $id", (fixture) => {
    const value = structuredClone(fixtures.requirement) as Record<string, unknown>;
    for (const change of fixture.changes as Array<{
      path: string;
      value?: unknown;
      remove?: boolean;
    }>) {
      const parts = change.path.split("."),
        key = parts.pop()!;
      const target = parts.reduce(
        (object, field) => object[field] as Record<string, unknown>,
        value,
      );
      if (change.remove) delete target[key];
      else target[key] = structuredClone(change.value);
    }
    expect(TravelRequirementSchema.safeParse(value).success, fixture.id).toBe(
      fixture.expected === "PASS",
    );
  });
  it("schema: runtime structures are byte-for-value projections of the named document contracts", () => {
    const text = fs.readFileSync("docs/travel-plan-schema.md", "utf8");
    const block = (id: string) =>
      JSON.parse(
        text.match(
          new RegExp(`<!-- contract:${id} -->\\s*\x60\x60\x60json\\s*([\\s\\S]*?)\x60\x60\x60`),
        )![1],
      );
    expect(travel.requirement).toEqual(block("travel-requirement-v1"));
    expect(travel.summary).toEqual(block("travel-summary-v1"));
    expect(travel.scalars).toEqual(block("requirement-scalar-policy-v1"));
    expect(fixtures.requirementCases).toEqual(block("schema-fixtures").cases);
    expect(fixtures.fixtureIds).toEqual([
      "clean",
      "parse",
      "schema",
      "repair-success",
      "repair-failure",
      "truncation",
    ]);
  });
  it("schema: all eight prompt outputs reject extra keys, missing fields, enums and version drift", () => {
    for (const [key, schema] of Object.entries(PromptOutputSchemas)) {
      const value = fixtures.promptOutputs[key as keyof typeof fixtures.promptOutputs];
      expect(parsePromptResponse(key, JSON.stringify(value))).toEqual(value);
      for (const invalid of [
        { ...value, rawOutputText: "forbidden" },
        { ...value, schemaVersion: 99 },
        {},
      ])
        expect(safeParseAiJson(JSON.stringify(invalid), schema as RuntimeSchema<unknown>).ok).toBe(
          false,
        );
    }
  });
  it("schema: summary binds exact revision hash destination order and duration without saving", () => {
    const requirement = TravelRequirementSchema.parse(fixtures.requirement);
    const summary = {
      ...fixtures.promptOutputs["planner.generate"],
      schemaVersion: 1,
      durationDays: requirement.durationDays,
      destinations: requirement.destinations,
      requirementRevision: requirement.revision,
      requirementHash: requirementHash(requirement),
    };
    expect(TravelPlanSummaryDraftSchema.safeParse(summary).success).toBe(true);
    expect(validateSummaryBinding(summary, requirement)).toEqual(summary);
    for (const value of [
      { ...summary, requirementRevision: 2 },
      { ...summary, requirementHash: "0".repeat(64) },
      { ...summary, destinations: [...summary.destinations].reverse() },
      { ...summary, durationDays: 3 },
    ])
      expect(() => validateSummaryBinding(value, requirement)).toThrow("VALIDATION_ERROR");
    for (const value of [
      { ...summary, coordinates: [1, 2] },
      { ...summary, destinations: [summary.destinations[0], summary.destinations[0]] },
      { ...summary, schemaVersion: 2 },
    ])
      expect(TravelPlanSummaryDraftSchema.safeParse(value).success).toBe(false);
  });
  it("schema: known prompt references are constrained to this request", () => {
    expect(() =>
      validatePromptReferences(
        "nlu.extract",
        {
          userText: "深圳",
          locale: "zh-CN",
          serverDate: "2026-09-15",
          timezone: "Asia/Shanghai",
          stage: "CORE",
        },
        { schemaVersion: 1, candidates: [{ field: "origin", text: "北京", confidence: 1 }] },
      ),
    ).toThrow("VALIDATION_ERROR");
    expect(() =>
      validatePromptReferences(
        "nlu.ask_missing",
        {
          locale: "zh-CN",
          specs: [{ field: "destinations", priority: "blocking", reasonCode: "MISSING" }],
        },
        { schemaVersion: 1, questions: [{ field: "origin", question: "出发地？" }] },
      ),
    ).toThrow("VALIDATION_ERROR");
    expect(() =>
      validatePromptReferences(
        "conversation.modify",
        {
          userText: "删除",
          locale: "zh-CN",
          candidates: [{ candidateId: "known", label: "合成", allowedOperations: ["ADD"] }],
        },
        {
          schemaVersion: 1,
          operation: "REMOVE",
          targetCandidateIds: ["known"],
          requestedText: "删除",
          explanation: "合成",
        },
      ),
    ).toThrow("VALIDATION_ERROR");
    expect(() =>
      validatePromptReferences(
        "planner.score",
        { locale: "zh-CN", scoreReasons: [{ dimension: "comfort", score: 80, reasonCodes: [] }] },
        {
          schemaVersion: 1,
          explanations: [{ dimension: "budgetFit", text: "合成" }],
          overallExplanation: "合成",
        },
      ),
    ).toThrow("VALIDATION_ERROR");
  });
});
