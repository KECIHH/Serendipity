// @vitest-environment node
import "../phase018/env";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { POST as debugTestPost } from "@/app/api/admin/ai-debug/test/route";
import { POST as debugStreamPost } from "@/app/api/admin/ai-debug/stream/route";
import { GET as debugRunGet } from "@/app/api/admin/ai-debug/runs/[id]/route";
import {
  parseAiDebugStatus,
  type AiDebugFailureProfile,
  type AiDebugStatusDto,
} from "@/lib/ai-debug";
import {
  cleanupDebug,
  client,
  initialize,
  issueSession,
  mockCallCount,
  observation,
  request,
  resetMockCalls,
  runDebugWorker,
  type FixtureSession,
} from "../phase018/fixture";

const PROMPT_KEY = "nlu.extract";
const variables = {
  userText: "这周末从深圳去武功山",
  locale: "zh-CN",
  serverDate: "2026-09-15",
  timezone: "Asia/Shanghai",
  stage: "CORE",
};
const FINAL_SUMMARY_KEY = "planner.final_summary";
const finalSummaryVariables = {
  summary: "已验证的行程摘要",
  dailyHighlights: ["按已验证顺序游览"],
  budgetSummary: null,
  riskSummaries: [],
  assumptionSummaries: [],
  limitations: ["费用仍有未知项"],
  locale: "zh-CN",
};
const TEST_ENDPOINT = "/api/admin/ai-debug/test";
const STREAM_ENDPOINT = "/api/admin/ai-debug/stream";
let db: PrismaClient;
let admin: FixtureSession;

function parseSseFrames(text: string) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const id = /^id: (.+)$/m.exec(frame)?.[1];
      const raw = /^data: (.+)$/m.exec(frame)?.[1];
      assert(raw, "SSE_DATA_FRAME_REQUIRED");
      return { event, id, data: JSON.parse(raw) as Record<string, unknown> };
    });
}

function envelope(value: unknown) {
  return value as {
    success: boolean;
    data?: unknown;
    error?: { code?: string };
    requestId: string;
  };
}
async function accept(
  profile: AiDebugFailureProfile,
  options: {
    idempotencyKey?: string;
    promptKey?: string;
    variables?: Record<string, unknown>;
  } = {},
) {
  const response = await debugTestPost(
    request(TEST_ENDPOINT, {
      session: admin,
      idempotencyKey: options.idempotencyKey,
      body: {
        promptKey: options.promptKey ?? PROMPT_KEY,
        variables: options.variables ?? variables,
        failureProfile: profile,
      },
    }),
    undefined,
  );
  expect(response.status).toBe(202);
  const receipt = envelope(await response.json()).data as {
    debugRunId: string;
    status: string;
    replayed: boolean;
  };
  return receipt.debugRunId;
}
async function statusOf(runId: string): Promise<AiDebugStatusDto> {
  const response = await debugRunGet(
    request(`/api/admin/ai-debug/runs/${runId}`, { method: "GET", session: admin }),
    { params: Promise.resolve({ id: runId }) },
  );
  expect(response.status).toBe(200);
  return parseAiDebugStatus(envelope(await response.json()).data);
}
async function formalWrites(): Promise<number> {
  const [row] = await db.$queryRawUnsafe<Array<{ n: number }>>(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('TravelPlanVersion','PlannerRun')",
  );
  return row!.n;
}
function runRow(runId: string) {
  return db.aiDebugRun.findUniqueOrThrow({ where: { id: runId } });
}

beforeAll(async () => {
  db = client();
  await initialize(db);
  admin = await issueSession(db, { role: "ADMIN" });
}, 120000);

beforeEach(async () => {
  await cleanupDebug();
  resetMockCalls();
});

afterAll(async () => {
  await db.$disconnect();
});

const fixtureTest = (name: string, run: () => Promise<void>) => it(name, run, 120000);
describe("phase018 M4 failure-injection matrix", () => {
  fixtureTest(
    "success: a Mock success reaches SUCCEEDED with one attempt and no formal plan write",
    async () => {
      const runId = await accept("success");
      expect(await runDebugWorker(db, runId), "FORMAL_PLAN_WRITE_BOUNDARY_REQUIRED").toBe(
        "COMPLETED",
      );
      const status = await statusOf(runId);
      expect(status.status).toBe("SUCCEEDED");
      expect(status.errorCode).toBeNull();
      expect(status.attemptIds).toHaveLength(1);
      expect(status.finalSummary?.schemaValidation.valid).toBe(true);
      expect(status.finalSummary?.parsedData).not.toBeNull();
      expect(status.finalSummary?.aiOutputRecordId).toBe(status.attemptIds[0]);
      const record = await db.aiOutputRecord.findUniqueOrThrow({
        where: { id: status.attemptIds[0]! },
      });
      expect(record.parsedOk).toBe(true);
      expect(record.status).toBe("SUCCEEDED");
      expect(record.travelRecordId).toBeNull();
      expect(record.commandId).toBeNull();
      expect(record.rawOutput).toBeNull();
      expect(await db.travelRecord.count(), "FORMAL_PLAN_WRITE_BOUNDARY_REQUIRED").toBe(0);
      expect(await formalWrites()).toBe(0);
      expect(await db.chatCommandEvent.count()).toBe(0);
      observation("success", {
        status: status.status,
        attempts: status.attemptIds.length,
        formalWrites: 0,
        persistedEvents: 0,
        mockCalls: mockCallCount(),
      });
    },
  );

  fixtureTest(
    "timeout: a Mock timeout fails the run with a structured error and no success event",
    async () => {
      const runId = await accept("timeout");
      expect(await runDebugWorker(db, runId)).toBe("COMPLETED");
      const status = await statusOf(runId);
      expect(status.status).toBe("FAILED");
      expect(status.errorCode).toBe("PROVIDER_TIMEOUT");
      expect(status.finalSummary).toBeNull();
      expect(status.attemptIds).toHaveLength(1);
      const record = await db.aiOutputRecord.findUniqueOrThrow({
        where: { id: status.attemptIds[0]! },
      });
      expect(record.status).toBe("FAILED");
      expect(record.errorCode).toBe("PROVIDER_TIMEOUT");
      expect(record.rawOutput).toBeNull();
      expect(await db.chatCommandEvent.count()).toBe(0);
      observation("timeout", {
        status: status.status,
        errorCode: status.errorCode,
        formalWrites: 0,
        persistedEvents: 0,
        mockCalls: mockCallCount(),
      });
    },
  );

  fixtureTest(
    "invalid-json: a malformed body is classified INVALID_JSON in the bounded diagnostic payload",
    async () => {
      const runId = await accept("invalid_json");
      expect(await runDebugWorker(db, runId)).toBe("COMPLETED");
      const status = await statusOf(runId);
      expect(status.status).toBe("FAILED");
      expect(status.errorCode).toBe("INVALID_JSON");
      expect(status.finalSummary).toBeNull();
      expect(status.attemptIds).toHaveLength(1);
      const record = await db.aiOutputRecord.findUniqueOrThrow({
        where: { id: status.attemptIds[0]! },
      });
      expect(record.parsedOk).toBe(false);
      expect(record.errorCode).toBe("INVALID_JSON");
      expect(record.rawOutput).toBeNull();
      // The bounded diagnostic payload is the only place the classification is exposed.
      const [captured] = await db.$queryRawUnsafe<Array<{ n: number }>>(
        'SELECT count(*)::int AS n FROM "AiOutputRecord" WHERE "rawOutput" IS NOT NULL',
      );
      expect(captured!.n).toBe(0);
      observation("invalid-json", {
        status: status.status,
        errorCode: status.errorCode,
        formalWrites: 0,
        persistedEvents: 0,
        mockCalls: mockCallCount(),
      });
    },
  );

  fixtureTest(
    "schema-mismatch: well-formed but non-conforming JSON is classified SCHEMA_MISMATCH",
    async () => {
      const runId = await accept("schema_mismatch", {
        promptKey: FINAL_SUMMARY_KEY,
        variables: finalSummaryVariables,
      });
      expect(await runDebugWorker(db, runId)).toBe("COMPLETED");
      const status = await statusOf(runId);
      expect(status.status, "SCHEMA_MISMATCH_REQUIRED").toBe("FAILED");
      expect(status.errorCode).toBe("SCHEMA_MISMATCH");
      expect(status.finalSummary).toBeNull();
      const record = await db.aiOutputRecord.findUniqueOrThrow({
        where: { id: status.attemptIds[0]! },
      });
      expect(record.parsedOk).toBe(false);
      expect(record.errorCode).toBe("SCHEMA_MISMATCH");
      observation("schema-mismatch", {
        status: status.status,
        errorCode: status.errorCode,
        formalWrites: 0,
        persistedEvents: 0,
        mockCalls: mockCallCount(),
      });
    },
  );

  fixtureTest(
    "repair: a broken body is repaired through the frozen repair Prompt and appends both attempts",
    async () => {
      const runId = await accept("repair");
      expect(await runDebugWorker(db, runId)).toBe("COMPLETED");
      const status = await statusOf(runId);
      expect(status.status).toBe("SUCCEEDED");
      expect(status.attemptIds.length).toBeGreaterThanOrEqual(2);
      expect(status.finalSummary?.schemaValidation.valid).toBe(true);
      const records = await db.aiOutputRecord.findMany({
        where: { traceId: (await runRow(runId)).traceId },
        orderBy: { attemptNo: "asc" },
      });
      expect(records.map((row) => row.attemptNo)).toEqual([1, 2]);
      expect(records[0]!.parsedOk).toBe(false);
      expect(records[0]!.errorCode).toBe("INVALID_JSON");
      expect(records[1]!.parsedOk).toBe(true);
      expect(records[1]!.status).toBe("SUCCEEDED");
      expect(await db.travelRecord.count()).toBe(0);
      observation("repair", {
        status: status.status,
        attempts: records.length,
        repairAttempt: records[1]!.attemptNo,
        formalWrites: 0,
        persistedEvents: 0,
        mockCalls: mockCallCount(),
      });
    },
  );

  fixtureTest(
    "stream-interruption: deltas stay transient, a lost first response resumes and GET recovers with zero calls",
    async () => {
      // Phase A: a complete stream proves deltas are transient and never persisted.
      const completed = await debugStreamPost(
        request(STREAM_ENDPOINT, {
          session: admin,
          body: { promptKey: PROMPT_KEY, variables, failureProfile: "success" },
        }),
        undefined,
      );
      expect(completed.status).toBe(200);
      expect(completed.headers.get("content-type")).toContain("text/event-stream");
      const whole = await completed.text();
      expect(whole).toContain("event: accepted");
      expect(whole).toContain("event: delta");
      expect(whole).toContain("event: final");
      const finalFrame = parseSseFrames(whole).at(-1);
      assert(finalFrame, "SSE_FINAL_FRAME_REQUIRED");
      expect(finalFrame.event).toBe("final");
      expect(Object.keys(finalFrame.data).sort()).toEqual(
        [
          "eventId",
          "sequence",
          "aggregateId",
          "traceId",
          "type",
          "status",
          "occurredAt",
          "payloadVersion",
          "payload",
        ].sort(),
      );
      expect(finalFrame.id, "SSE_ID_EQUALS_EVENT_ID").toBe(finalFrame.data.eventId);
      expect(await db.outbox.count(), "TRANSIENT_DELTA_REQUIRED").toBe(0);
      expect(await db.chatCommandEvent.count()).toBe(0);
      const completedRun = /"debugRunId":"([A-Za-z0-9_-]+)"/.exec(whole)?.[1];
      assert(completedRun, "STREAM_FINAL_FRAME");
      expect((await statusOf(completedRun)).status).toBe("SUCCEEDED");

      // Phase B: the first response never reaches the client and the worker restarts.
      const controller = new AbortController();
      const response = await debugStreamPost(
        request(STREAM_ENDPOINT, {
          session: admin,
          signal: controller.signal,
          body: { promptKey: PROMPT_KEY, variables, failureProfile: "success" },
        }),
        undefined,
      );
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const first = decoder.decode((await reader.read()).value ?? new Uint8Array());
      expect(first).toContain("event: accepted");
      const runId = /"debugRunId":"([A-Za-z0-9_-]+)"/.exec(first)?.[1];
      assert(runId, "STREAM_ACCEPTED_FRAME");
      controller.abort();
      await reader.cancel().catch(() => undefined);

      let restarted = "NOT_CLAIMED";
      for (let attempt = 0; attempt < 24 && restarted !== "COMPLETED"; attempt += 1) {
        restarted = await runDebugWorker(db, runId);
        if (restarted !== "COMPLETED") await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(restarted).toBe("COMPLETED");
      const before = mockCallCount();
      const status = await statusOf(runId);
      expect(status.status).toBe("SUCCEEDED");
      expect(status.attemptIds.length).toBeGreaterThanOrEqual(1);
      expect(status.finalSummary).not.toBeNull();
      expect(await statusOf(runId)).toEqual(status);
      expect(mockCallCount()).toBe(before);
      expect(await db.outbox.count()).toBe(0);
      expect(await db.chatCommandEvent.count()).toBe(0);
      observation("stream-interruption", {
        status: status.status,
        attempts: status.attemptIds.length,
        providerCallsDuringGet: mockCallCount() - before,
        persistedDeltas: 0,
        formalWrites: 0,
        persistedEvents: 0,
        mockCalls: mockCallCount(),
      });
    },
  );

  fixtureTest(
    "cost: an exhausted shared budget fails the run with COST_LIMIT and zero egress",
    async () => {
      const runId = await accept("cost");
      expect(await runDebugWorker(db, runId)).toBe("COMPLETED");
      const status = await statusOf(runId);
      expect(status.status).toBe("FAILED");
      expect(status.errorCode).toBe("COST_LIMIT");
      expect(status.attemptIds).toHaveLength(0);
      expect(status.finalSummary).toBeNull();
      expect(mockCallCount()).toBe(0);
      expect(await db.chatCommandEvent.count()).toBe(0);
      expect(await db.travelRecord.count()).toBe(0);
      observation("cost", {
        status: status.status,
        errorCode: status.errorCode,
        formalWrites: 0,
        persistedEvents: 0,
        mockCalls: 0,
      });
    },
  );

  fixtureTest(
    "authorization: non-admin callers are refused with zero writes and zero egress",
    async () => {
      const userSession = await issueSession(db, { role: "USER", audience: "USER" });
      const expiredSession = await issueSession(db, {
        role: "ADMIN",
        email: "phase018-expired@serendipity.invalid",
        ttlMs: 1_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const payload = { promptKey: PROMPT_KEY, variables, failureProfile: "success" };
      const tasksBefore = await db.durableTask.count({ where: { kind: "AI_DEBUG" } });
      const payloadsBefore = await db.taskPayload.count();
      const anonymous = await debugTestPost(
        request(TEST_ENDPOINT, { session: null, body: payload }),
        undefined,
      );
      expect(anonymous.status).toBe(401);
      const user = await debugTestPost(
        request(TEST_ENDPOINT, { session: userSession, body: payload }),
        undefined,
      );
      expect(user.status).toBe(403);
      const expired = await debugTestPost(
        request(TEST_ENDPOINT, { session: expiredSession, body: payload }),
        undefined,
      );
      expect(expired.status, "EXPIRED_AUTH_REQUIRED").toBe(401);
      expect(envelope(await expired.json()).error?.code, "EXPIRED_AUTH_REQUIRED").toBe(
        "AUTH_REQUIRED",
      );
      const streamed = await debugStreamPost(
        request(STREAM_ENDPOINT, { session: userSession, body: payload }),
        undefined,
      );
      expect(streamed.status).toBe(403);
      expect(
        [anonymous.status, user.status, expired.status, streamed.status],
        "ADMIN_GUARD_REQUIRED",
      ).toEqual([401, 403, 401, 403]);
      expect(await db.aiDebugRun.count()).toBe(0);
      expect(await db.durableTask.count({ where: { kind: "AI_DEBUG" } })).toBe(tasksBefore);
      expect(await db.taskPayload.count()).toBe(payloadsBefore);
      expect(mockCallCount()).toBe(0);
      expect(randomUUID().length).toBe(36);
      observation("authorization", {
        anonymous: 401,
        user: 403,
        expired: 401,
        writes: 0,
        formalWrites: 0,
        persistedEvents: 0,
        mockCalls: 0,
      });
    },
  );
});
