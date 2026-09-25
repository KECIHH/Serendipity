// @vitest-environment node
import "./plan-draft-fixture";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  bootstrap,
  cookiePair,
  draftBody,
  idempotencyKey,
  mockExtract,
  openDb,
  postDraft,
  summaryOutput,
} from "./plan-draft-fixture";

let db: PrismaClient;

beforeAll(async () => {
  db = await openDb();
}, 120_000);

afterAll(async () => {
  await db.$disconnect();
});

describe("plan draft handoff", () => {
  it("precise 缺失信息返回 NEEDS_INFORMATION 且不写正式版本", async () => {
    const cookie = cookiePair((await bootstrap()).headers.get("set-cookie") ?? "");
    const { response } = await postDraft(
      cookie,
      draftBody({ content: "去武功山", planningMode: "precise" }),
      idempotencyKey(),
      {
        stageOutputs: {
          CORE: mockExtract([{ field: "destinations", text: "武功山", confidence: 1 }]),
          PARAMETERS: mockExtract(),
          CONSTRAINTS: mockExtract(),
        },
      },
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.requirementState.confirmationStatus).toBe("NEEDS_INFORMATION");
    expect(body.data.commandStatus).toBe("COMPLETED");
    expect(body.data.travelRecordStatus).toBe("NEEDS_INFO");
    expect(body.data.summary).toBeNull();
    expect(body.data.plannerRunId).toBeNull();
    const record = await db.travelRecord.findUniqueOrThrow({
      where: { id: body.data.travelRecordId },
    });
    expect(record.version).toBe(0);
  });

  it("完整输入把摘要写入助手消息并完成命令", async () => {
    const cookie = cookiePair((await bootstrap()).headers.get("set-cookie") ?? "");
    const { response } = await postDraft(
      cookie,
      draftBody({ content: "这周末从深圳去武功山", planningMode: "quick" }),
      idempotencyKey(),
      {
        stageOutputs: {
          CORE: mockExtract([
            { field: "origin", text: "深圳", confidence: 1 },
            { field: "destinations", text: "武功山", confidence: 1 },
            { field: "dateRange", text: "这周末", confidence: 1 },
          ]),
          PARAMETERS: mockExtract(),
          CONSTRAINTS: mockExtract(),
        },
        summaryOutput: summaryOutput("武功山行程概要"),
      },
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.commandStatus).toBe("COMPLETED");
    expect(body.data.travelRecordStatus).toBe("DRAFT");
    expect(body.data.summary?.title).toContain("武功山");
    expect(body.data.requirementState.confirmationStatus).toBe("READY_FOR_PLANNING");
    expect(body.data.readiness).toEqual({ status: "READY" });
    const assistant = await db.chatMessage.findFirstOrThrow({
      where: { travelRecordId: body.data.travelRecordId, role: "ASSISTANT" },
    });
    expect(JSON.stringify(assistant.contentJson)).toContain("武功山");
    const event = await db.chatCommandEvent.findFirstOrThrow({
      where: { aggregateId: body.data.commandId, type: "assistant.completed" },
    });
    expect(event.status).toBe("COMPLETED");
  });
});
