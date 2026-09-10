import { describe, expect, it } from "vitest";

import {
  formatCostEstimate,
  formatDateRange,
  formatDuration,
  formatMoney,
  truncate,
  type CostEstimate,
  type MoneyCurrency,
} from "@/lib/format";

function knownCost(overrides: Partial<CostEstimate> = {}): CostEstimate {
  return {
    amount: "1234",
    currency: "CNY",
    costStatus: "estimated",
    costBasis: "总额",
    sourceRefs: ["source-fixture"],
    fetchedAt: "2026-09-09T08:00:00Z",
    confidence: 0.8,
    freshness: {
      status: "fresh",
      checkedAt: "2026-09-10T08:00:00+08:00",
      freshnessPolicyVersion: "fixture-v1",
    },
    ...overrides,
  };
}

function unknownCost(): CostEstimate {
  return knownCost({
    amount: null,
    costStatus: "unknown",
    costBasis: null,
    sourceRefs: [],
    fetchedAt: null,
    confidence: 0,
    freshness: {
      status: "unknown",
      checkedAt: "2026-09-10T08:00:00Z",
      freshnessPolicyVersion: "fixture-v1",
    },
  });
}

describe("formatDateRange", () => {
  it("formats fixed local dates without applying an offset or locale", () => {
    expect(formatDateRange("2026-09-10", "2026-09-12")).toBe("2026年9月10日 ～ 2026年9月12日");
    expect(formatDateRange("2026-12-31", "2027-01-01")).toBe("2026年12月31日 ～ 2027年1月1日");
  });

  it("displays one date for equal endpoints and preserves four-digit early years", () => {
    expect(formatDateRange("2024-02-29", "2024-02-29")).toBe("2024年2月29日");
    expect(formatDateRange("0001-01-01", "0001-01-01")).toBe("0001年1月1日");
  });

  it("rejects a reversed range", () => {
    expect(() => formatDateRange("2026-09-12", "2026-09-10")).toThrow(RangeError);
  });

  it.each(["2025-02-29", "1900-02-29", "2024-02-30", "2026-13-01", "2026-00-01", "0000-01-01"])(
    "rejects the nonexistent Gregorian date %s at either endpoint",
    (date) => {
      expect(() => formatDateRange(date, "9999-12-31")).toThrow(RangeError);
      expect(() => formatDateRange("0001-01-01", date)).toThrow(RangeError);
    },
  );

  it("rejects timestamps, missing padding and non-string input", () => {
    for (const date of ["2026-9-10", "2026-09-10T00:00:00Z", "2026-09-10 ", "invalid", null]) {
      expect(() => formatDateRange(date as string, "2026-09-12")).toThrow(RangeError);
    }
    expect(formatDateRange("2000-02-29", "2000-02-29")).toBe("2000年2月29日");
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0分钟"],
    [45, "45分钟"],
    [90, "1小时30分钟"],
    [120, "2小时"],
  ])("formats %i minutes as %s", (durationMinutes, expected) => {
    expect(formatDuration(durationMinutes)).toBe(expected);
  });

  it("rejects negative duration values", () => {
    expect(() => formatDuration(-1)).toThrow(RangeError);
    expect(() => formatDuration(-60)).toThrow(RangeError);
  });

  it("rejects fractions, nonfinite values, unsafe integers and coerced input", () => {
    for (const durationMinutes of [1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "45", null]) {
      expect(() => formatDuration(durationMinutes as number)).toThrow(RangeError);
    }
  });
});

describe("formatMoney", () => {
  it("formats CNY and USD with fixed symbols, grouping and two decimal places", () => {
    expect(formatMoney("1234", "CNY")).toBe("¥1,234.00");
    expect(formatMoney("1234", "USD")).toBe("$1,234.00");
    expect(formatMoney("0", "CNY")).toBe("¥0.00");
    expect(formatMoney("12.5", "USD")).toBe("$12.50");
  });

  it("keeps all decimal digits beyond Number.MAX_SAFE_INTEGER", () => {
    expect(formatMoney("9007199254740993.01", "CNY")).toBe("¥9,007,199,254,740,993.01");
    expect(formatMoney("123456789012345678901234567890.995", "USD")).toBe(
      "$123,456,789,012,345,678,901,234,567,891.00",
    );
  });

  it("uses half-even rounding for ties, preserving a later nonzero digit", () => {
    expect(formatMoney("1.005", "CNY")).toBe("¥1.00");
    expect(formatMoney("1.015", "CNY")).toBe("¥1.02");
    expect(formatMoney("1.0050001", "CNY")).toBe("¥1.01");
    expect(formatMoney("1.0050000", "CNY")).toBe("¥1.00");
    expect(formatMoney("9.999", "CNY")).toBe("¥10.00");
  });

  it("rejects malformed decimals without coercion", () => {
    for (const amount of [
      "",
      " ",
      "-1",
      "+1",
      "01",
      "1.",
      ".5",
      "1e3",
      "NaN",
      "1,000",
      1234,
      NaN,
    ]) {
      expect(() => formatMoney(amount as string, "CNY")).toThrow(RangeError);
    }
  });

  it("rejects unknown or incorrectly cased currencies", () => {
    for (const currency of ["EUR", "cny", "", null]) {
      expect(() => formatMoney("1234", currency as MoneyCurrency)).toThrow(RangeError);
    }
  });
});

describe("formatCostEstimate", () => {
  it("displays the amount with an explicit estimate label", () => {
    expect(formatCostEstimate(knownCost())).toBe("¥1,234.00（估算）");
  });

  it("distinguishes a verified estimate from a final price", () => {
    expect(formatCostEstimate(knownCost({ costStatus: "verified_estimate" }))).toBe(
      "¥1,234.00（已核验估算）",
    );
  });

  it("displays unknown costs without a zero amount", () => {
    expect(formatCostEstimate(unknownCost())).toBe("未知");
    expect(formatCostEstimate(unknownCost())).not.toMatch(/0|免费/);
  });

  it("displays free only for an evidenced explicit zero", () => {
    expect(formatCostEstimate(knownCost({ amount: "0", costStatus: "free" }))).toBe("免费");
    for (const amount of ["1", "0.00", null]) {
      expect(() => formatCostEstimate(knownCost({ amount, costStatus: "free" }))).toThrow(
        RangeError,
      );
    }
    expect(() => formatCostEstimate(knownCost({ amount: "0" }))).toThrow(RangeError);
    expect(() => formatCostEstimate({ ...unknownCost(), amount: "0" })).toThrow(RangeError);
  });

  it("keeps stale evidence visible without consulting the current time", () => {
    expect(formatCostEstimate(knownCost({ costStatus: "stale" }))).toBe(
      "¥1,234.00（已过期/待核验）",
    );
    const estimate = knownCost();
    estimate.freshness.status = "expired";
    expect(formatCostEstimate(estimate)).toBe("¥1,234.00（估算；已过期/待核验）");
  });

  it("rejects incomplete canonical shapes and invalid confidence", () => {
    const missingFreshness = { ...knownCost(), freshness: { status: "fresh" } };
    expect(() => formatCostEstimate(missingFreshness as CostEstimate)).toThrow(RangeError);
    expect(() => formatCostEstimate({ ...knownCost(), legacyAmount: "1" } as CostEstimate)).toThrow(
      RangeError,
    );
    for (const confidence of [-0.1, 1.1, NaN, "0.8"]) {
      expect(() => formatCostEstimate(knownCost({ confidence: confidence as number }))).toThrow(
        RangeError,
      );
    }
  });

  it("requires source evidence and real timestamps for known costs", () => {
    for (const sourceRefs of [
      [],
      new Array<string>(1),
      [" "],
      ["source-fixture", "source-fixture"],
    ]) {
      expect(() => formatCostEstimate(knownCost({ sourceRefs }))).toThrow(RangeError);
    }
    expect(() => formatCostEstimate(knownCost({ fetchedAt: null }))).toThrow(RangeError);
    expect(() => formatCostEstimate(knownCost({ fetchedAt: "2026-02-30T08:00:00Z" }))).toThrow(
      RangeError,
    );
    const estimate = knownCost();
    estimate.freshness.checkedAt = "2026-09-10T25:00:00Z";
    expect(() => formatCostEstimate(estimate)).toThrow(RangeError);
  });

  it("does not change source amounts or freshness metadata", () => {
    const estimate = knownCost({ amount: "1234.125" });
    const original = structuredClone(estimate);
    expect(formatCostEstimate(estimate)).toBe("¥1,234.12（估算）");
    expect(estimate).toEqual(original);
  });
});

describe("truncate", () => {
  it("keeps strings that fit and includes the ellipsis in the limit", () => {
    expect(truncate("际遇", 2)).toBe("际遇");
    expect(truncate("际遇旅行计划", 4)).toBe("际遇旅…");
    expect(truncate("际遇", 1)).toBe("…");
    expect(truncate("际遇", 0)).toBe("");
    expect(truncate("", 3)).toBe("");
  });

  it("counts Unicode code points without splitting a surrogate pair", () => {
    expect(truncate("A🌍B🚆C", 4)).toBe("A🌍B…");
    expect(truncate("🌍🚆", 2)).toBe("🌍🚆");
  });

  it("rejects negative, fractional, nonfinite and unsafe limits", () => {
    for (const maxLength of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => truncate("际遇", maxLength)).toThrow(RangeError);
    }
  });
});
