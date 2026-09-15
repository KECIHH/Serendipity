// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cleanAiOutput, safeParseAiJson } from "@/lib/ai/json-parser";
import { NluExtractOutputSchema, PlannerGenerateOutputSchema } from "@/lib/ai/schemas";
import fixtures from "./fixtures.json";

describe("AI JSON parser", () => {
  it("clean: paired fences and BOM preserve the complete JSON", () => {
    const text = JSON.stringify(fixtures.promptOutputs["planner.generate"]);
    for (const raw of [
      `\uFEFF \n${text}\t`,
      `\uFEFF\n\`\`\`json\n${text}\n\`\`\`\n`,
      `~~~~json\r\n${text}\r\n~~~~`,
    ]) {
      expect(cleanAiOutput(raw), "FENCE_CLEANING_REQUIRED").toBe(text);
      const parsed = safeParseAiJson(raw, PlannerGenerateOutputSchema);
      expect(parsed.ok, "FENCE_CLEANING_REQUIRED").toBe(true);
      if (parsed.ok) expect(parsed.data).toEqual(fixtures.promptOutputs["planner.generate"]);
    }
  });
  it("clean: empty and unpaired or prefixed fences never discard content", () => {
    for (const raw of [
      "",
      "\uFEFF   ",
      "```json\n{}",
      "before\n```json\n{}\n```",
      "```json\n{}\n```\nafter",
      "```json\n{}\n~~~~",
    ])
      expect(safeParseAiJson(raw, NluExtractOutputSchema)).toMatchObject({
        ok: false,
        errorCode: "INVALID_JSON",
      });
    expect(cleanAiOutput('{"text":"```json\\nuntouched\\n```"}')).toBe(
      '{"text":"```json\\nuntouched\\n```"}',
    );
  });
  it("parse: data is typed only after strict schema validation", () => {
    const input = JSON.stringify({ schemaVersion: 1, candidates: [] });
    expect(safeParseAiJson(input, NluExtractOutputSchema)).toEqual({
      ok: true,
      data: { schemaVersion: 1, candidates: [] },
    });
    expect(
      safeParseAiJson('{"schemaVersion":1}', NluExtractOutputSchema).ok,
      "SCHEMA_VALIDATION_REQUIRED",
    ).toBe(false);
    expect(safeParseAiJson(input.slice(0, -1), NluExtractOutputSchema)).toMatchObject({
      ok: false,
      errorCode: "INVALID_JSON",
    });
    for (const value of [
      { schemaVersion: 2, candidates: [] },
      { schemaVersion: 1, candidates: [], planJson: {} },
      { schemaVersion: 1, candidates: [{ field: "coordinates", text: "1,2", confidence: 1 }] },
    ])
      expect(safeParseAiJson(JSON.stringify(value), NluExtractOutputSchema)).toMatchObject({
        ok: false,
        errorCode: "SCHEMA_MISMATCH",
      });
  });
  it("parse: bounded failures expose only safe known paths and fixed summaries", () => {
    const canary = "private-diagnostic-" + "x".repeat(200);
    const cases = [
      JSON.stringify({ schemaVersion: 1, candidates: [], [canary]: canary }),
      `{"${canary}":`,
      " ".repeat(21000),
      '{"schemaVersion":1,"candidates":[],"__proto__":{"admin":true}}',
    ];
    for (const raw of cases) {
      const result = safeParseAiJson(raw, NluExtractOutputSchema);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(canary);
      expect(JSON.stringify(result)).not.toContain("stack");
      if (!result.ok) {
        expect(result.details.length).toBeLessThanOrEqual(20);
        for (const issue of result.details)
          expect(issue.path).toMatch(/^\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]+\])*$/);
      }
    }
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });
});
