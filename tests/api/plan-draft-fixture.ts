import "../phase018/env";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { POST as anonymousPost } from "@/app/api/session/anonymous/route";
import { POST as draftPost } from "@/app/api/plan/draft/route";
import { withDraftOverrides, type DraftOverrides } from "@/server/plan/draft-service";
import { client, initialize, mockCallCount, resetMockCalls } from "../phase018/fixture";

export const origin = "http://127.0.0.1:3000";

export function mockExtract(
  candidates: readonly { field: string; text: string; confidence: number }[] = [],
) {
  return JSON.stringify({ schemaVersion: 1, candidates });
}

export function summaryOutput(title: string) {
  return JSON.stringify({
    schemaVersion: 1,
    title,
    description: "先核验交通和开放信息，再确定每日安排。",
    bestFor: ["想先看范围的人"],
    overallRecommendation: "先核验交通和开放信息，再确定每日安排。",
    recommendedReason: "目的地已经明确，其余安排仍需核验。",
  });
}

export function draftBody(
  overrides: Partial<{
    content: string;
    planningMode: "quick" | "precise";
    clientRequestId: string;
  }> = {},
) {
  return {
    content: overrides.content ?? "想出去玩",
    planningMode: overrides.planningMode ?? "precise",
    clientRequestId: overrides.clientRequestId ?? randomUUID(),
    locale: "zh-CN",
    timezone: "Asia/Shanghai",
  };
}

export function idempotencyKey() {
  return `draft-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export async function openDb() {
  const db = client();
  await initialize(db);
  for (const [key, valueJson, description] of [
    ["planner.quick.defaultDurationDays", 3, "默认快速规划天数"],
    ["planner.quick.defaultTravelerCount", 1, "默认快速规划人数"],
    ["planner.quick.defaultPace", "moderate", "默认快速规划节奏"],
  ] as const) {
    await db.systemConfig.upsert({
      where: { key },
      create: { key, valueJson, description, group: "GENERAL", isPublic: false },
      update: { valueJson },
    });
  }
  return db;
}

export async function businessCounts(db: PrismaClient) {
  const [travelRecords, messages, commands, idempotency] = await Promise.all([
    db.travelRecord.count(),
    db.chatMessage.count(),
    db.chatCommand.count(),
    db.commandIdempotency.count(),
  ]);
  const [planner] = await db.$queryRaw<Array<{ name: string | null }>>`
    SELECT to_regclass('public."PlannerRun"')::text AS name`;
  return { travelRecords, messages, commands, idempotency, plannerRuns: planner.name };
}

export async function bootstrap(cookie?: string) {
  const headers = new Headers({ origin });
  if (cookie) headers.set("cookie", cookie);
  return anonymousPost(
    new Request(`${origin}/api/session/anonymous`, { method: "POST", headers, body: "{}" }),
  );
}

export function cookiePair(setCookie: string) {
  return setCookie.split(";")[0] ?? "";
}

export async function postDraft(
  cookie: string | undefined,
  body: ReturnType<typeof draftBody>,
  key: string,
  overrides?: DraftOverrides,
) {
  const headers = new Headers({
    origin,
    "content-type": "application/json",
    "idempotency-key": key,
  });
  if (cookie) headers.set("cookie", cookie);
  const request = new Request(`${origin}/api/plan/draft`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  resetMockCalls();
  const response = overrides
    ? await withDraftOverrides(overrides, () => draftPost(request))
    : await draftPost(request);
  return { response, providerCalls: mockCallCount() };
}

export const emptyStages = {
  CORE: mockExtract(),
  PARAMETERS: mockExtract(),
  CONSTRAINTS: mockExtract(),
};
