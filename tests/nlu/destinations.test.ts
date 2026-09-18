// @vitest-environment node
import { describe, expect, it } from "vitest";
import { entities } from "./fixtures";

describe("core destination extraction", () => {
  it("识别国家级目的地", () => {
    const value = entities("去日本", [{ field: "destinations", text: "日本", confidence: 0.95 }]);
    expect(value.destinations).toHaveLength(1);
    expect(value.destinations[0].name).toBe("日本");
    expect(value.destinations[0].type).toBe("country");
  });
  it("识别省级目的地", () => {
    expect(
      entities("去云南", [{ field: "destinations", text: "云南", confidence: 0.8 }]).destinations[0]
        .type,
    ).toBe("province");
  });
  it("模糊目的地不强行补全城市", () => {
    const value = entities("想出去玩", [
      { field: "destinations", text: "出去玩", confidence: 0.2 },
    ]);
    expect(value.destinations[0].city).toBeNull();
    expect(value.destinations[0].confidence).toBeLessThan(0.5);
  });
  it("保留多目的地顺序", () => {
    const value = entities("川西+稻城", [
      { field: "destinations", text: "川西+稻城", confidence: 0.9 },
    ]);
    expect(value.destinations.map((item) => item.name)).toEqual(["川西", "稻城"]);
  });
  it("忽略不在用户原文中的模型候选", () => {
    const value = entities("去日本", [{ field: "destinations", text: "东京", confidence: 0.95 }]);
    expect(value.destinations).toEqual([]);
  });
});
