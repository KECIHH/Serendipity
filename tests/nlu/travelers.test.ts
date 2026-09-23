// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parameters } from "./parameter-fixtures";

describe("travel parameter travelers", () => {
  it("带爸妈不证明老人年龄", () => {
    const value = parameters("带爸妈去云南", [
      { field: "travelers", text: "带爸妈", confidence: 0.9 },
    ]);
    expect(value.travelers.hasElder, "HAS_ELDER_REQUIRED").toBeNull();
    expect(value.travelers.relationship).toBe("family");
    expect(value.travelers.isFamily).toBe(true);
    expect(value.travelers.totalCount).toBeNull();
  });
  it("情侣标记两名年龄明确的成人", () => {
    const value = parameters("情侣去哈尔滨", [{ field: "travelers", text: "情侣", confidence: 1 }]);
    expect(value.travelers).toMatchObject({
      totalCount: 2,
      adultCount: 2,
      childCount: 0,
      elderCount: 0,
      ageUnknownCount: 0,
      relationship: "couple",
      isCouple: true,
      hasElder: false,
      hasChild: false,
    });
  });
  it("一家三口只确定总数", () => {
    const value = parameters("一家三口去日本", [
      { field: "travelers", text: "一家三口", confidence: 0.8 },
    ]);
    expect(value.travelers.totalCount).toBe(3);
    expect(value.travelers.adultCount).toBeNull();
    expect(value.travelers.hasChild).toBeNull();
    expect(value.travelers.isFamily).toBe(true);
  });
  it("毕业旅行四个人不猜测年龄组", () => {
    const value = parameters("毕业旅行四个人", [
      { field: "travelers", text: "毕业旅行四个人", confidence: 0.7 },
    ]);
    expect(value.travelers).toMatchObject({
      totalCount: 4,
      adultCount: null,
      childCount: null,
      elderCount: null,
      ageUnknownCount: null,
      relationship: "friends",
      hasElder: null,
    });
  });
  it("两成人含一老人保持总数为二", () => {
    const value = parameters("我们两成人含一老人", [
      { field: "travelers", text: "两成人含一老人", confidence: 1 },
    ]);
    expect(value.travelers).toMatchObject({
      totalCount: 2,
      adultCount: 1,
      elderCount: 1,
      childCount: 0,
      ageUnknownCount: 0,
      hasElder: true,
    });
  });
  it("年龄未知保留 unknown 分组", () => {
    const value = parameters("四个人，其中一人年龄未知", [
      { field: "travelers", text: "四个人", confidence: 1 },
      { field: "travelers", text: "一人年龄未知", confidence: 1 },
    ]);
    expect(value.travelers.totalCount).toBe(4);
    expect(value.travelers.ageUnknownCount).toBe(1);
    expect(value.travelers.adultCount).toBeNull();
  });
  it("负数小数和总数不一致都拒绝", () => {
    expect(
      parameters("人数-1", [{ field: "travelers", text: "人数-1", confidence: 1 }]).travelers
        .totalCount,
    ).toBeNull();
    expect(
      parameters("人数1.5", [{ field: "travelers", text: "人数1.5", confidence: 1 }]).travelers
        .totalCount,
    ).toBeNull();
    expect(() =>
      parameters("两个人含三成人", [{ field: "travelers", text: "两个人含三成人", confidence: 1 }]),
    ).toThrow("VALIDATION_ERROR");
  });
  it("分组全已知时总数必须等于四项之和", () => {
    expect(() =>
      parameters("总人数四个，两成人，一个老人，一个儿童，一人年龄未知", [
        { field: "travelers", text: "总人数四个", confidence: 1 },
        { field: "travelers", text: "两成人", confidence: 1 },
        { field: "travelers", text: "一个老人", confidence: 1 },
        { field: "travelers", text: "一个儿童", confidence: 1 },
        { field: "travelers", text: "一人年龄未知", confidence: 1 },
      ]),
    ).toThrow("VALIDATION_ERROR");
  });
  it("同一成员重复提及不重复加总", () => {
    const value = parameters("带爸妈，爸妈一起去", [
      { field: "travelers", text: "带爸妈", confidence: 1 },
      { field: "travelers", text: "爸妈", confidence: 0.8 },
    ]);
    expect(value.travelers.totalCount).toBeNull();
    expect(value.travelers.elderCount).toBeNull();
  });
});
