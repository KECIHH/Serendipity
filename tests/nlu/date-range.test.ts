// @vitest-environment node
import "../phase018/env";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNluContext } from "@/server/ai/nlu-context";
import { nluBudgetSnapshot } from "@/server/ai/nlu-context";
import { extractCoreEntities } from "@/server/services/nlu/extract-core-entities";
import { parseRelativeDate } from "@/server/services/nlu/date-parser";
import { client, config, initialize } from "../phase018/fixture";
import { entities } from "./fixtures";

let db: PrismaClient;
const fixedNow = Date.parse("2026-09-03T01:00:00Z");

function guardedContext() {
  return createNluContext(
    {
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      planningMode: "quick",
      ownerContext: { kind: "SYNTHETIC", runId: config().database },
      traceId: `trace_phase019_core_${randomUUID()}`,
      requestId: `request_phase019_core_${randomUUID()}`,
      signal: new AbortController().signal,
      deadlineAt: fixedNow + 30_000,
      tokenBudget: 1_000_000,
      costBudget: "5",
    },
    () => fixedNow,
  );
}

beforeAll(async () => {
  db = client();
  await initialize(db);
}, 120_000);

afterAll(async () => {
  await db.$disconnect();
});

describe("core date range extraction", () => {
  it("将这周末锚定到 serverDate 所在周", () => {
    const value = entities("这周末从深圳去武功山", [
      { field: "dateRange", text: "这周末", confidence: 1 },
      { field: "origin", text: "深圳", confidence: 1 },
      { field: "destinations", text: "武功山", confidence: 1 },
    ]);
    expect(value.dateRange?.startDate, "WEEKEND_CONVERSION_REQUIRED").toBe("2026-09-05");
    expect(value.dateRange?.endDate).toBe("2026-09-06");
  });
  it("国庆七天使用确定性时长", () => {
    const value = entities("国庆去日本玩七天", [
      { field: "dateRange", text: "国庆", confidence: 1 },
    ]);
    expect(value.dateRange?.startDate).toBe("2026-10-01");
    expect(value.dateRange?.endDate).toBe("2026-10-07");
  });
  it("下个月返回完整月份范围", () => {
    const value = entities("下个月带爸妈去云南", [
      { field: "dateRange", text: "下个月", confidence: 1 },
    ]);
    expect(value.dateRange?.startDate).toBe("2026-10-01");
    expect(value.dateRange?.endDate).toBe("2026-10-31");
    expect(value.dateRange?.isFlexible).toBe(true);
  });
  it("时间未定保持 null", () => {
    expect(entities("时间未定", []).dateRange).toBeNull();
  });
  it("周日规划从当天开始，周一才滚动到下一周", () => {
    const sunday = parseRelativeDate("这周末", {
      serverDate: "2026-09-06",
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
    });
    expect(sunday?.startDate).toBe("2026-09-06");
    expect(sunday?.endDate).toBe("2026-09-06");
    const monday = parseRelativeDate("这周末", {
      serverDate: "2026-09-07",
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
    });
    expect(monday?.startDate).toBe("2026-09-12");
    expect(monday?.endDate).toBe("2026-09-13");
  });
  it("周六和周日规划当日开始的周末", () => {
    expect(
      parseRelativeDate("这周末", {
        serverDate: "2026-09-05",
        timezone: "Asia/Shanghai",
        locale: "zh-CN",
      })?.startDate,
    ).toBe("2026-09-05");
    expect(
      parseRelativeDate("这周末", {
        serverDate: "2026-09-06",
        timezone: "Asia/Shanghai",
        locale: "zh-CN",
      })?.startDate,
    ).toBe("2026-09-06");
  });
  it("guarded call: 这周末从深圳去武功山", async () => {
    const ctx = guardedContext();
    const value = await extractCoreEntities("这周末从深圳去武功山", ctx, { db });
    expect(value.origin?.city).toBe("深圳");
    expect(value.destinations[0]?.name).toBe("武功山");
    expect(value.dateRange?.startDate).toBe("2026-09-05");
    expect(value.dateRange?.endDate).toBe("2026-09-06");
    expect(nluBudgetSnapshot(ctx).tokensUsedOrReserved).toBeGreaterThan(0);
  });
  it("guarded call: 国庆去日本玩七天", async () => {
    const value = await extractCoreEntities("国庆去日本玩七天", guardedContext(), {
      db,
      mockProfileVerified: true,
      mockOutput: JSON.stringify({
        schemaVersion: 1,
        candidates: [
          { field: "dateRange", text: "国庆", confidence: 1 },
          { field: "destinations", text: "日本", confidence: 0.9 },
        ],
      }),
    });
    expect(value.dateRange?.startDate).toBe("2026-10-01");
    expect(value.dateRange?.endDate).toBe("2026-10-07");
    expect(value.destinations[0]?.name).toBe("日本");
  });
  it("guarded call: malformed provider output fails without partial entities", async () => {
    await expect(
      extractCoreEntities("这周末从深圳去武功山", guardedContext(), {
        db,
        mockProfileVerified: true,
        mockFailureMode: "invalid_json",
      }),
    ).rejects.toThrow("PROVIDER_UNAVAILABLE");
  });
  it("guarded call: timeout rejects without partial entities", async () => {
    await expect(
      extractCoreEntities("这周末从深圳去武功山", guardedContext(), {
        db,
        mockProfileVerified: true,
        mockFailureMode: "timeout",
      }),
    ).rejects.toThrow("PROVIDER_TIMEOUT");
  });
  it("guarded call: cancelled context never resets request limits", async () => {
    const ctx = guardedContext();
    const cancelled = createNluContext(
      {
        timezone: ctx.timezone,
        locale: ctx.locale,
        planningMode: ctx.planningMode,
        ownerContext: ctx.ownerContext,
        traceId: ctx.traceId,
        requestId: ctx.requestId,
        signal: AbortSignal.abort(),
        deadlineAt: fixedNow + 1,
        tokenBudget: 1,
        costBudget: "0",
      },
      () => fixedNow,
    );
    await expect(extractCoreEntities("这周末", cancelled, { db })).rejects.toThrow("CANCELLED");
  });
  it("具体日期范围校验 ISO 日期并保留结束日", () => {
    expect(
      entities("2026-09-10到2026-09-12", [
        { field: "dateRange", text: "2026-09-10到2026-09-12", confidence: 1 },
      ]).dateRange,
    ).toMatchObject({ startDate: "2026-09-10", endDate: "2026-09-12" });
    expect(
      entities("2026-02-30", [{ field: "dateRange", text: "2026-02-30", confidence: 1 }]).dateRange,
    ).toBeNull();
    expect(
      entities("2026-09-12到2026-09-10", [
        { field: "dateRange", text: "2026-09-12到2026-09-10", confidence: 1 },
      ]).dateRange,
    ).toBeNull();
  });
  it("日期候选不被无关历史日期覆盖", () => {
    expect(
      entities("我2025-01-01去过日本，这周末去武功山", [
        { field: "dateRange", text: "这周末", confidence: 1 },
      ]).dateRange?.startDate,
    ).toBe("2026-09-05");
  });
  it("单独时长不补造出发日期", () => {
    expect(
      entities("想去日本玩7天，时间未定", [{ field: "dateRange", text: "玩7天", confidence: 1 }])
        .dateRange,
    ).toBeNull();
  });
  it("国庆在九月仍属当年，节后才滚动下一年", () => {
    expect(
      entities("国庆玩三天", [{ field: "dateRange", text: "国庆", confidence: 1 }], "2026-09-21")
        .dateRange,
    ).toMatchObject({ startDate: "2026-10-01", endDate: "2026-10-03" });
    expect(
      entities("国庆", [{ field: "dateRange", text: "国庆", confidence: 1 }], "2026-10-08")
        .dateRange?.startDate,
    ).toBe("2027-10-01");
  });
  it("国庆时长不跨标点借用过去旅行天数", () => {
    expect(
      entities("国庆去日本,去年玩5天", [{ field: "dateRange", text: "国庆", confidence: 1 }])
        .dateRange?.endDate,
    ).toBe("2026-10-07");
  });
  it("跨年下月和闰年月份按服务端日历计算", () => {
    expect(
      entities("下个月", [{ field: "dateRange", text: "下个月", confidence: 1 }], "2026-12-20")
        .dateRange,
    ).toMatchObject({ startDate: "2027-01-01", endDate: "2027-01-31" });
    expect(
      entities("下个月", [{ field: "dateRange", text: "下个月", confidence: 1 }], "2028-01-20")
        .dateRange?.endDate,
    ).toBe("2028-02-29");
  });
});
