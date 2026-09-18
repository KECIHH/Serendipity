// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NluExtractOutputSchema } from "@/lib/ai/schemas";
import { entities } from "./fixtures";

describe("core origin extraction", () => {
  it("识别从深圳出发", () => {
    const value = entities("从深圳出发", [{ field: "origin", text: "深圳", confidence: 0.95 }]);
    expect(value.origin?.city).toBe("深圳");
    expect(value.origin?.confidence).toBeGreaterThanOrEqual(0);
    expect(value.origin?.confidence).toBeLessThanOrEqual(1);
  });
  it("识别人在广州", () => {
    expect(
      entities("人在广州", [{ field: "origin", text: "广州", confidence: 0.8 }]).origin?.city,
    ).toBe("广州");
  });
  it("缺失出发地保持 null", () => {
    expect(
      entities("去日本", [{ field: "destinations", text: "日本", confidence: 0.9 }]).origin,
    ).toBeNull();
  });
  it("候选缺失 confidence 时 Schema 拒绝结果", () => {
    expect(
      NluExtractOutputSchema.safeParse({
        schemaVersion: 1,
        candidates: [{ field: "origin", text: "深圳" }],
      }).success,
    ).toBe(false);
  });
});
