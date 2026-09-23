// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseCnAmount } from "@/server/services/nlu/amount-parser";
import { parameters } from "./parameter-fixtures";

describe("travel parameter budget", () => {
  it("预算一万转为十进制字符串且不猜测币种", () => {
    const value = parameters("预算一万去新疆自驾", [
      { field: "budget", text: "预算一万", confidence: 1 },
    ]);
    expect(parseCnAmount("一万"), "CN_AMOUNT_REQUIRED").toBe("10000");
    expect(value.budget.amount, "CN_AMOUNT_REQUIRED").toBe("10000");
    expect(value.budget.currency).toBeNull();
    expect(value.budget.perPerson).toBe(false);
  });
  it("人均3000元区分人均和币种", () => {
    const value = parameters("人均3000元去云南", [
      { field: "budget", text: "人均3000元", confidence: 0.9 },
    ]);
    expect(value.budget).toMatchObject({ amount: "3000", currency: "CNY", perPerson: true });
  });
  it("预算低一点映射预算等级", () => {
    const value = parameters("预算低一点", [
      { field: "budget", text: "预算低一点", confidence: 0.8 },
    ]);
    expect(value.budget.level).toBe("budget");
    expect(value.budget.amount).toBeNull();
    expect(value.budget.perPerson).toBe(false);
  });
  it("预算未提及保持空预算", () => {
    expect(parameters("去云南", []).budget).toMatchObject({
      amount: null,
      currency: null,
      level: null,
      isFlexible: null,
      perPerson: null,
      hardLimit: null,
      confidence: 0,
    });
  });
  it("无法解析的金额保持 null", () => {
    expect(parseCnAmount("很多钱")).toBeNull();
    expect(
      parameters("预算很多钱", [{ field: "budget", text: "预算很多钱", confidence: 1 }]).budget
        .amount,
    ).toBeNull();
  });
  it("k和小数不经过浮点并去掉末尾零", () => {
    expect(parseCnAmount("3k")).toBe("3000");
    expect(parseCnAmount("5000左右")).toBe("5000");
    expect(parseCnAmount("12.50")).toBe("12.5");
    expect(parseCnAmount("0.00")).toBe("0");
  });
});
