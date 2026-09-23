// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parameters } from "./parameter-fixtures";

describe("travel parameter preferences", () => {
  it("拍照日出归一化为摄影", () => {
    const value = parameters("想拍照看日出", [
      { field: "preferences.interests", text: "拍照看日出", confidence: 0.9 },
    ]);
    expect(value.preferences.interests).toEqual(["摄影"]);
    expect(value.preferences.avoid).toEqual([]);
  });
  it("不想太累进入避免项", () => {
    const value = parameters("不想太累", [
      { field: "preferences.avoid", text: "不想太累", confidence: 1 },
      { field: "preferences.pace", text: "不想太累", confidence: 0.7 },
    ]);
    expect(value.preferences.avoid, "AVOID_REQUIRED").toEqual(["不想太累"]);
    expect(value.preferences.pace).toBe("slow");
  });
  it("美食和 City Walk 保持枚举并去重", () => {
    const value = parameters("喜欢美食和City Walk", [
      { field: "preferences.interests", text: "美食", confidence: 1 },
      { field: "preferences.interests", text: "City Walk", confidence: 0.8 },
      { field: "preferences.interests", text: "美食", confidence: 0.6 },
    ]);
    expect(value.preferences.interests).toEqual(["美食", "City Walk"]);
  });
  it("无特殊偏好返回空数组", () => {
    const value = parameters("无特殊偏好", []);
    expect(value.preferences.interests).toEqual([]);
    expect(value.preferences.avoid).toEqual([]);
    expect(value.preferences.interests).not.toBeNull();
  });
  it("负向偏好覆盖网红景点和饮食限制", () => {
    const value = parameters("不要网红景点也不吃辣", [
      { field: "preferences.avoid", text: "不要网红景点", confidence: 1 },
      { field: "preferences.avoid", text: "不吃辣", confidence: 1 },
    ]);
    expect(value.preferences.avoid).toEqual(["不要网红景点", "不吃辣"]);
  });
  it("忽略不在原文中的兴趣候选", () => {
    expect(
      parameters("想去云南", [{ field: "preferences.interests", text: "滑雪", confidence: 1 }])
        .preferences.interests,
    ).toEqual([]);
  });
});
