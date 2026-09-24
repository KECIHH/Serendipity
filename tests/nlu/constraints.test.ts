// @vitest-environment node
import { describe, expect, it } from "vitest";
import { deriveSpecialFlags } from "@/server/services/nlu/constraint-mapping";
import { constraints, requirement } from "./phase021-fixtures";

describe("travel constraints", () => {
  it("新疆自驾标记自驾且不猜测海外", () => {
    const mapped = constraints("新疆自驾", [
      { field: "preferences.transport", text: "自驾", confidence: 1 },
    ]);
    const flags = deriveSpecialFlags(
      requirement({
        destinations: [
          { id: "d1", name: "新疆", city: null, country: "CN", type: "province", confidence: 1 },
        ],
        preferences: { ...requirement().preferences, transport: mapped.transport },
        fieldSources: [
          {
            field: "preferences.transport",
            messageId: null,
            inputHash: "a".repeat(64),
            method: "USER_TEXT",
            confidence: 1,
          },
          {
            field: "destinations",
            messageId: null,
            inputHash: "a".repeat(64),
            method: "USER_TEXT",
            confidence: 1,
          },
        ],
      }),
    );
    expect(flags.isSelfDriving, "SELF_DRIVING_REQUIRED").toBe(true);
    expect(flags.isOverseas).toBeNull();
  });
  it("武功山徒步标记徒步", () => {
    const mapped = constraints("武功山徒步", [
      { field: "preferences.transport", text: "徒步", confidence: 1 },
    ]);
    expect(
      deriveSpecialFlags(
        requirement({
          preferences: { ...requirement().preferences, transport: mapped.transport },
          fieldSources: [
            {
              field: "preferences.transport",
              messageId: null,
              inputHash: "a".repeat(64),
              method: "USER_TEXT",
              confidence: 1,
            },
          ],
        }),
      ).isHiking,
    ).toBe(true);
  });
  it("飞去日本在国家明确时标记海外", () => {
    const mapped = constraints("飞去日本", [
      { field: "preferences.transport", text: "飞去日本", confidence: 1 },
    ]);
    const flags = deriveSpecialFlags(
      requirement({
        origin: { city: "深圳", country: "CN", confidence: 1 },
        destinations: [
          { id: "d1", name: "日本", city: null, country: "JP", type: "country", confidence: 1 },
        ],
        preferences: { ...requirement().preferences, transport: mapped.transport },
        fieldSources: [
          {
            field: "origin",
            messageId: null,
            inputHash: "a".repeat(64),
            method: "USER_TEXT",
            confidence: 1,
          },
          {
            field: "destinations",
            messageId: null,
            inputHash: "a".repeat(64),
            method: "USER_TEXT",
            confidence: 1,
          },
          {
            field: "preferences.transport",
            messageId: null,
            inputHash: "a".repeat(64),
            method: "USER_TEXT",
            confidence: 1,
          },
        ],
      }),
    );
    expect(flags.isOverseas).toBe(true);
    expect(mapped.transport).toContain("flight");
  });
  it("高铁去云南标记高铁且国内", () => {
    const mapped = constraints("高铁去云南", [
      { field: "preferences.transport", text: "高铁", confidence: 1 },
    ]);
    const flags = deriveSpecialFlags(
      requirement({
        origin: { city: "深圳", country: "CN", confidence: 1 },
        destinations: [
          { id: "d1", name: "云南", city: null, country: "CN", type: "province", confidence: 1 },
        ],
        preferences: { ...requirement().preferences, transport: mapped.transport },
        fieldSources: [
          {
            field: "origin",
            messageId: null,
            inputHash: "a".repeat(64),
            method: "USER_TEXT",
            confidence: 1,
          },
          {
            field: "destinations",
            messageId: null,
            inputHash: "a".repeat(64),
            method: "USER_TEXT",
            confidence: 1,
          },
          {
            field: "preferences.transport",
            messageId: null,
            inputHash: "a".repeat(64),
            method: "USER_TEXT",
            confidence: 1,
          },
        ],
      }),
    );
    expect(mapped.transport).toEqual(["high_speed_rail"]);
    expect(flags.isOverseas).toBe(false);
  });
});
