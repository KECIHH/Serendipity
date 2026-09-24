// @vitest-environment node
import { describe, expect, it } from "vitest";
import { askMissingFields } from "@/server/services/nlu/ask-missing";
import { detectMissingFields } from "@/server/services/nlu/detect-missing";
import { fixtureContext, requirement } from "./phase021-fixtures";

const policy = {
  planningMode: "precise" as const,
  quickDefaults: { durationDays: 3, travelerCount: 1, pace: "moderate" as const },
};
const capabilities = { selfDriving: null, hiking: true, overseas: true };
function fields(value: ReturnType<typeof requirement>, mode: "precise" | "quick" = "precise") {
  return detectMissingFields(
    value,
    fixtureContext(mode),
    { ...policy, planningMode: mode },
    capabilities,
  );
}

describe("missing requirement fields", () => {
  it("缺少目的地是阻断项", async () => {
    const specs = fields(requirement());
    expect(
      specs.find((item) => item.field === "destinations")?.priority,
      "DESTINATION_BLOCKING_REQUIRED",
    ).toBe("blocking");
    const asked = await askMissingFields(specs, fixtureContext("precise", true));
    expect(
      asked.missingFields.every(
        (item) => item.question.trim().length > 0 && item.reason.trim().length > 0,
      ),
    ).toBe(true);
  });
  it("缺少时间在精确模式阻断", () => {
    expect(
      fields(
        requirement({
          destinations: [
            {
              id: "d1",
              name: "武功山",
              city: null,
              country: "CN",
              type: "attraction",
              confidence: 1,
            },
          ],
        }),
      ).some((item) => item.field === "dateRange" && item.priority === "blocking"),
    ).toBe(true);
  });
  it("自驾但安全能力未知时阻断", () => {
    const specs = fields(
      requirement({
        destinations: [
          { id: "d1", name: "新疆", city: null, country: "CN", type: "province", confidence: 1 },
        ],
        preferences: { ...requirement().preferences, transport: ["self_driving"] },
        travelers: { ...requirement().travelers, totalCount: null },
      }),
    );
    expect(
      specs.some(
        (item) => item.reasonCode === "SAFETY_CAPABILITY_UNKNOWN" && item.priority === "blocking",
      ),
    ).toBe(true);
  });
  it("预算缺失但可先规划", () => {
    const specs = fields(
      requirement({
        destinations: [
          { id: "d1", name: "云南", city: null, country: "CN", type: "province", confidence: 1 },
        ],
        dateRange: {
          startDate: "2026-09-05",
          endDate: "2026-09-07",
          text: "三天",
          isFlexible: false,
          timezone: "Asia/Shanghai",
          confidence: 1,
        },
        durationDays: 3,
        travelers: {
          ...requirement().travelers,
          totalCount: 2,
          adultCount: 2,
          childCount: 0,
          elderCount: 0,
          ageUnknownCount: 0,
          relationship: "couple",
          hasChild: false,
          hasElder: false,
          isCouple: true,
          isFamily: false,
          confidence: 1,
        },
        origin: { city: "深圳", country: "CN", confidence: 1 },
      }),
    );
    expect(specs.find((item) => item.field === "budget")?.priority).toBe("normal");
    expect(specs.some((item) => item.priority === "blocking")).toBe(false);
  });
});
