// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseRelativeDate } from "@/server/services/nlu/date-parser";
import { entities } from "./fixtures";

describe("core date range extraction", () => {
  it("将这周末锚定到 serverDate 所在周", () => {
    const value = entities("这周末从深圳去武功山", [
      { field: "dateRange", text: "这周末", confidence: 1 },
      { field: "origin", text: "深圳", confidence: 1 },
      { field: "destinations", text: "武功山", confidence: 1 },
    ]);
    expect(value.dateRange?.startDate).toBe("2026-09-05");
    expect(value.dateRange?.endDate).toBe("2026-09-06");
  });
  it("国庆七天使用确定性时长", () => {
    const value = entities("国庆去日本玩七天", [{ field: "dateRange", text: "国庆", confidence: 1 }]);
    expect(value.dateRange?.startDate).toBe("2026-10-01");
    expect(value.dateRange?.endDate).toBe("2026-10-07");
  });
  it("下个月返回完整月份范围", () => {
    const value = entities("下个月带爸妈去云南", [{ field: "dateRange", text: "下个月", confidence: 1 }]);
    expect(value.dateRange?.startDate).toBe("2026-10-01");
    expect(value.dateRange?.endDate).toBe("2026-10-31");
    expect(value.dateRange?.isFlexible).toBe(true);
  });
  it("时间未定保持 null", () => {
    expect(entities("时间未定", []).dateRange).toBeNull();
  });
  it("周日规划从当天开始，周一才滚动到下一周", () => {
    const sunday = parseRelativeDate("这周末", { serverDate: "2026-09-06", timezone: "Asia/Shanghai", locale: "zh-CN" });
    expect(sunday?.startDate).toBe("2026-09-06");
    expect(sunday?.endDate).toBe("2026-09-07");
    const monday = parseRelativeDate("这周末", { serverDate: "2026-09-07", timezone: "Asia/Shanghai", locale: "zh-CN" });
    expect(monday?.startDate).toBe("2026-09-12");
    expect(monday?.endDate).toBe("2026-09-13");
  });
  it("周六和周日规划当日开始的周末", () => {
    expect(parseRelativeDate("这周末", { serverDate: "2026-09-05", timezone: "Asia/Shanghai", locale: "zh-CN" })?.startDate).toBe("2026-09-05");
    expect(parseRelativeDate("这周末", { serverDate: "2026-09-06", timezone: "Asia/Shanghai", locale: "zh-CN" })?.startDate).toBe("2026-09-06");
  });
});
