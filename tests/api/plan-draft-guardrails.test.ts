// @vitest-environment node
import "./plan-draft-fixture";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ownerClient } from "../phase018/fixture";
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

async function cookie() {
  return cookiePair((await bootstrap()).headers.get("set-cookie") ?? "");
}

async function expectFailed(mode: "timeout" | "rate_limit" | "invalid_json", status: number, code: string) {
  const before = await businessCounts(db);
  const { response, providerCalls } = await postDraft(await cookie(), draftBody(), idempotencyKey(), {
    stageOutputs: emptyStages,
    mockFailureMode: mode,
  });
  const body = await response.json();
  expect(response.status).toBe(status);
  expect(body.error.code).toBe(code);
  const after = await businessCounts(db);
  expect(after.commands).toBe(before.commands + 1);
  const command = await db.chatCommand.findFirstOrThrow({
    where: { kind: "PLAN_DRAFT" },
    orderBy: { createdAt: "desc" },
  });
  expect(command.status).toBe("FAILED");
  expect(command.errorCode).toBe(code);
  return providerCalls;
}

describe("plan draft guardrails", () => {
  it("timeout、invalid JSON 与 cost 映射为失败命令", async () => {
    const timeoutCalls = await expectFailed("timeout", 503, "PROVIDER_TIMEOUT");
    expect(timeoutCalls).toBeGreaterThan(0);
    await expectFailed("invalid_json", 503, "PROVIDER_UNAVAILABLE");

    const beforeCalls = await postDraft(await cookie(), draftBody(), idempotencyKey(), {
      stageOutputs: emptyStages,
      tokenBudget: 1,
    });
    const body = await beforeCalls.response.json();
    expect(beforeCalls.response.status).toBe(429);
    expect(body.error.code).toBe("COST_LIMIT");
    expect(beforeCalls.providerCalls).toBe(0);
    const command = await db.chatCommand.findFirstOrThrow({
      where: { kind: "PLAN_DRAFT", errorCode: "COST_LIMIT" },
      orderBy: { createdAt: "desc" },
    });
    expect(command.status).toBe("FAILED");
  });

  it("第 6 次额度请求在调用模型前返回 429", async () => {
    const session = await cookie();
    const probe = await postDraft(session, draftBody(), idempotencyKey(), { stageOutputs: emptyStages });
    expect(probe.response.status).toBe(200);
    const sample = await db.aiUsageReservation.findFirstOrThrow();
    const provider = await db.providerConfigVersion.findFirstOrThrow({
      where: { providerId: "mock-provider" },
    });
    const owner = ownerClient();
    try {
      await owner.aiUsageReservation.deleteMany();
      const slice = Math.ceil(provider.quotaTokensPerDay / 5);
      for (let index = 0; index < 5; index += 1) {
        await owner.aiUsageReservation.create({
          data: {
            bucketKey: sample.bucketKey,
            traceId: `trace_quota_${index}`,
            attemptNo: 1,
            estimatedTokens: slice,
            estimatedCost: 0,
            status: "RESERVED",
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
      }
      const limited = await postDraft(session, draftBody(), idempotencyKey(), {
        stageOutputs: emptyStages,
      });
      const body = await limited.response.json();
      expect(limited.response.status).toBe(429);
      expect(body.error.code).toBe("RATE_LIMITED");
      expect(limited.providerCalls).toBe(0);
      const command = await db.chatCommand.findFirstOrThrow({
        orderBy: { createdAt: "desc" },
      });
      expect(command.status).toBe("FAILED");
      expect(command.errorCode).toBe("RATE_LIMITED");
    } finally {
      await owner.aiUsageReservation.deleteMany();
      await owner.$disconnect();
    }
  });
});
