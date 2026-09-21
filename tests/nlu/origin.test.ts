// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NluExtractOutputSchema } from "@/lib/ai/schemas";
import { CoreEntitiesSchema } from "@/lib/schemas/core-entities";
import { entities } from "./fixtures";

describe("core origin extraction", () => {
  it("识别从深圳出发", () => {
    const value = entities("从深圳出发", [{ field: "origin", text: "深圳", confidence: 0.95 }]);
    expect(value.origin?.city).toBe("深圳");
    expect(value.origin?.confidence).toBeGreaterThanOrEqual(0);
    expect(value.origin?.confidence).toBeLessThanOrEqual(1);
    expect(CoreEntitiesSchema.safeParse(value).success, "CORE_CONFIDENCE_REQUIRED").toBe(true);
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
  it("服务返回字段复用需求 Schema 且禁止缺失 confidence", () => {
    const result = entities("北京过去", [{ field: "origin", text: "北京", confidence: 0.9 }]);
    expect(result.origin?.city).toBe("北京");
    expect(CoreEntitiesSchema.safeParse(result).success).toBe(true);
    expect(
      CoreEntitiesSchema.safeParse({ ...result, origin: { city: "北京", country: null } }).success,
    ).toBe(false);
  });
  it("非词典城市仍可识别且不猜测国家", () => {
    const result = entities("人在里昂", [{ field: "origin", text: "里昂", confidence: 0.7 }]);
    expect(result.origin).toEqual({ city: "里昂", country: null, confidence: 0.7 });
  });
});
