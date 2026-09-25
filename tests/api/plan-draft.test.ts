// @vitest-environment node
import "./plan-draft-fixture";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  bootstrap,
  businessCounts,
  cookiePair,
  draftBody,
  emptyStages,
  idempotencyKey,
  openDb,
  postDraft,
} from "./plan-draft-fixture";

let db: PrismaClient;

beforeAll(async () => {
  db = await openDb();
}, 120_000);

afterAll(async () => {
  await db.$disconnect();
});

async function anonymousCookie() {
  const response = await bootstrap();
  return cookiePair(response.headers.get("set-cookie") ?? "");
}

describe("plan draft", () => {
  it("anonymous bootstrap 只下发安全 Cookie 且不写业务表", async () => {
    const before = await businessCounts(db);
    const response = await bootstrap();
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ anonymousSessionReady: true });
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(await businessCounts(db)).toEqual(before);
  });

  it("missing-cookie guard 返回 bootstrap 动作且零写入", async () => {
    const before = await businessCounts(db);
    const { response, providerCalls } = await postDraft(undefined, draftBody(), idempotencyKey());
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("AUTH_REQUIRED");
    expect(body.error.details).toEqual({ action: "BOOTSTRAP_ANONYMOUS_SESSION" });
    expect(providerCalls).toBe(0);
    expect(await businessCounts(db)).toEqual(before);
  });

  it("匿名首稿在一个事务里留下 NEEDS_INFO 且没有 PlannerRun", async () => {
    const cookie = await anonymousCookie();
    const before = await businessCounts(db);
    const body = draftBody({ content: "想出去玩", planningMode: "precise" });
    const { response, providerCalls } = await postDraft(cookie, body, idempotencyKey(), {
      stageOutputs: emptyStages,
    });
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(providerCalls).toBeGreaterThan(0);
    expect(payload.data.commandStatus).toBe("COMPLETED");
    expect(payload.data.travelRecordStatus).toBe("NEEDS_INFO");
    expect(payload.data.handoffStage).toBe("REQUIREMENT_SUMMARY");
    expect(payload.data.plannerRunId).toBeNull();
    expect(payload.data.workspaceAvailable).toBe(false);
    expect(payload.data.requirementState.confirmationStatus).toBe("NEEDS_INFORMATION");
    expect(payload.data.readiness).toEqual({ status: "BLOCKED" });
    expect(payload.data.replayed).toBe(false);
    expect(payload.data.summary).toBeNull();
    const after = await businessCounts(db);
    expect(after.travelRecords).toBe(before.travelRecords + 1);
    expect(after.commands).toBe(before.commands + 1);
    expect(after.messages).toBe(before.messages + 2);
    expect(after.plannerRuns).toBeNull();
    const record = await db.travelRecord.findUniqueOrThrow({
      where: { id: payload.data.travelRecordId },
    });
    expect(record.anonTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.userId).toBeNull();
    expect(record.version).toBe(0);
    expect(record.status).toBe("NEEDS_INFO");
    const user = await db.chatMessage.findFirstOrThrow({
      where: { travelRecordId: record.id, role: "USER" },
    });
    expect(user.sequence).toBe(1);
    expect(user.clientMessageId).toBe(body.clientRequestId);
  });

  it("同 key 同 payload 重放原 id 且第二次零写入", async () => {
    const cookie = await anonymousCookie();
    const body = draftBody();
    const key = idempotencyKey();
    const first = await postDraft(cookie, body, key, { stageOutputs: emptyStages });
    const created = await first.response.json();
    const before = await businessCounts(db);
    const second = await postDraft(cookie, body, key, { stageOutputs: emptyStages });
    const replayed = await second.response.json();
    expect(second.response.status).toBe(200);
    expect(second.providerCalls).toBe(0);
    expect(replayed.data.replayed).toBe(true);
    expect(replayed.data.travelRecordId).toBe(created.data.travelRecordId);
    expect(replayed.data.commandId).toBe(created.data.commandId);
    expect(await businessCounts(db)).toEqual(before);
  });

  it("同 key 异 payload 返回 409 且零写入", async () => {
    const cookie = await anonymousCookie();
    const key = idempotencyKey();
    const firstBody = draftBody({ content: "想出去玩" });
    await postDraft(cookie, firstBody, key, { stageOutputs: emptyStages });
    const before = await businessCounts(db);
    const second = await postDraft(
      cookie,
      draftBody({ content: "改去北京", clientRequestId: firstBody.clientRequestId }),
      key,
      { stageOutputs: emptyStages },
    );
    const body = await second.response.json();
    expect(second.response.status).toBe(409);
    expect(body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(second.providerCalls).toBe(0);
    expect(await businessCounts(db)).toEqual(before);
  });
});
