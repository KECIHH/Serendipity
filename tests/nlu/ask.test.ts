// @vitest-environment node
import { describe, expect, it } from "vitest";
import { askMissingFields } from "@/server/services/nlu/ask-missing";
import type { MissingFieldSpec } from "@/server/services/nlu/detect-missing";
import { fixtureContext } from "./phase021-fixtures";

const specs: MissingFieldSpec[] = ["destinations", "dateRange", "travelers", "budget", "origin"].map((field, index) => ({ field: field as MissingFieldSpec["field"], priority: index < 3 ? "blocking" : index === 3 ? "normal" : "optional", reasonCode: "TEST" }));

describe("missing field questions", () => {
  it("3个缺失生成3个问题", async () => {
    const value = await askMissingFields(specs.slice(0, 3), fixtureContext());
    expect(value.questions).toHaveLength(3);
    expect(value.questions.every((item) => item.trim() && !item.startsWith("请输入"))).toBe(true);
  });
  it("5个缺失只生成3个问题", async () => {
    const value = await askMissingFields(specs, fixtureContext());
    expect(value.questions.length, "QUESTION_LIMIT_REQUIRED").toBeLessThanOrEqual(3);
    expect(value.missingFields).toHaveLength(5);
  });
  it("blocking优先", async () => {
    const value = await askMissingFields([...specs].reverse(), fixtureContext());
    expect(value.missingFields.slice(0, 3).every((item) => item.priority === "blocking")).toBe(true);
    expect(value.questions).toHaveLength(3);
  });
});
