// @vitest-environment node
import "../phase018/env";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { POST as debugTestPost } from "@/app/api/admin/ai-debug/test/route";
import { GET as debugRunGet } from "@/app/api/admin/ai-debug/runs/[id]/route";
import { parseAiDebugRequest, parseAiDebugStatus } from "@/lib/ai-debug";
import { activatePromptModelTuple } from "@/server/services/prompt-service";
import {
  cleanupDebug,
  client,
  config,
  initialize,
  issueSession,
  mockCallCount,
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
const ENDPOINT = "/api/admin/ai-debug/test";
let db: PrismaClient;
let admin: FixtureSession;

function body(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}
function envelope(value: Record<string, unknown>) {
  assert.equal(typeof value.requestId, "string");
  return value as {
    success: boolean;
    data?: unknown;
    error?: { code?: string };
    requestId: string;
  };
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

const fixtureTest = (name: string, run: () => void | Promise<void>) => it(name, run, 60000);
describe("administrator AI debug API", () => {
  fixtureTest(
    "ai-debug-api: the request DTO cannot select a deployment, provider, secret or Prompt body",
    () => {
      const base = { promptKey: PROMPT_KEY, variables, failureProfile: "success" };
      assert.equal(parseAiDebugRequest(base).promptKey, PROMPT_KEY);
      for (const extra of [
        { ...base, deployment: "synthetic-model" },
        { ...base, provider: "mock-provider" },
        { ...base, baseUrl: "https://example.invalid" },
        { ...base, secretRef: "key_1" },
        { ...base, system: "you are a helpful assistant" },
      ])
        assert.throws(() => parseAiDebugRequest(extra), /VALIDATION_ERROR/);
      assert.throws(
        () => parseAiDebugRequest({ ...base, failureProfile: "arbitrary" }),
        /VALIDATION_ERROR/,
      );
      assert.throws(
        () => parseAiDebugRequest({ ...base, promptKey: "nlu.unknown" }),
        /VALIDATION_ERROR/,
      );
      assert.throws(
        () => parseAiDebugRequest({ ...base, variables: { authorization: "Bearer synthetic" } }),
        /VALIDATION_ERROR/,
      );
      assert.throws(
        () =>
          parseAiDebugRequest({ ...base, variables: { userText: "x", apiKey: "sk-live-1234" } }),
        /VALIDATION_ERROR/,
      );
    },
  );

  fixtureTest(
    "ai-debug-api: an accepted debug call persists one run and never writes a formal plan",
    async () => {
      const response = await debugTestPost(
        request(ENDPOINT, {
          session: admin,
          body: { promptKey: PROMPT_KEY, variables, failureProfile: "success" },
        }),
        undefined,
      );
      expect(response.status).toBe(202);
      expect(response.headers.get("idempotency-replayed")).toBe("false");
      const parsed = envelope(await body(response));
      expect(parsed.success).toBe(true);
      const receipt = parsed.data as { debugRunId: string; status: string; replayed: boolean };
      expect(receipt.replayed).toBe(false);
      expect(receipt.status).toBe("PENDING");
      const run = await db.aiDebugRun.findUniqueOrThrow({ where: { id: receipt.debugRunId } });
      expect(run.adminUserId).toBe(admin.userId);
      expect(run.status).toBe("PENDING");
      expect(await db.aiOutputRecord.count({ where: { traceId: run.traceId } })).toBe(0);
      expect(await db.travelRecord.count()).toBe(0);
      const tables = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('TravelPlanVersion','PlannerRun')",
      );
      expect(Number(tables[0]!.n)).toBe(0);
    },
  );

  fixtureTest(
    "ai-debug-api: the same key replays one run and a different payload is a conflict",
    async () => {
      const idempotencyKey = randomUUID();
      const first = await debugTestPost(
        request(ENDPOINT, {
          session: admin,
          idempotencyKey,
          body: { promptKey: PROMPT_KEY, variables, failureProfile: "success" },
        }),
        undefined,
      );
      const second = await debugTestPost(
        request(ENDPOINT, {
          session: admin,
          idempotencyKey,
          body: { promptKey: PROMPT_KEY, variables, failureProfile: "success" },
        }),
        undefined,
      );
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(second.headers.get("idempotency-replayed")).toBe("true");
      const a = (envelope(await body(first)).data as { debugRunId: string }).debugRunId;
      const b = envelope(await body(second)).data as { debugRunId: string; replayed: boolean };
      expect(b.debugRunId).toBe(a);
      expect(b.replayed).toBe(true);
      expect(await db.aiDebugRun.count()).toBe(1);
      const conflict = await debugTestPost(
        request(ENDPOINT, {
          session: admin,
          idempotencyKey,
          body: {
            promptKey: PROMPT_KEY,
            variables: { ...variables, userText: "下周从深圳去武功山" },
            failureProfile: "success",
          },
        }),
        undefined,
      );
      expect(conflict.status).toBe(409);
      expect(envelope(await body(conflict)).error?.code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(await db.aiDebugRun.count()).toBe(1);
    },
  );

  fixtureTest(
    "ai-debug-api: anonymous, non-admin, disabled and invalidated sessions write nothing",
    async () => {
      const userSession = await issueSession(db, { role: "USER", audience: "USER" });
      const disabled = await issueSession(db, {
        role: "ADMIN",
        status: "DISABLED",
        email: "phase018-disabled@serendipity.invalid",
      });
      const revoked = await issueSession(db, {
        role: "ADMIN",
        email: "phase018-revoked@serendipity.invalid",
      });
      const [{ revokedAt }] = await db.$queryRaw<Array<{ revokedAt: Date }>>`
      SELECT public.auth_now() AS "revokedAt"
    `;
      await db.authSession.updateMany({
        where: { tokenHash: createHash("sha256").update(revoked.opaqueToken).digest("hex") },
        data: { status: "REVOKED", revokedAt },
      });
      const stale = await issueSession(db, {
        role: "ADMIN",
        sessionVersion: 9,
        email: "phase018-stale@serendipity.invalid",
      });
      const payload = { promptKey: PROMPT_KEY, variables, failureProfile: "success" };
      const receiptsBefore = await db.adminCommandReceipt.count({
        where: { operationId: "post.admin.ai-debug.test" },
      });
      const tasksBefore = await db.durableTask.count({ where: { kind: "AI_DEBUG" } });
      const cases: Array<[string, FixtureSession | null, number, string]> = [
        ["anonymous", null, 401, "AUTH_REQUIRED"],
        ["user", userSession, 403, "FORBIDDEN"],
        ["disabled", disabled, 401, "AUTH_REQUIRED"],
        ["revoked", revoked, 401, "AUTH_REQUIRED"],
        ["stale-version", stale, 401, "AUTH_REQUIRED"],
      ];
      for (const [label, session, status, code] of cases) {
        const response = await debugTestPost(
          request(ENDPOINT, { session, body: payload }),
          undefined,
        );
        expect(response.status, `ADMIN_GUARD_REQUIRED:${label}`).toBe(status);
        expect(envelope(await body(response)).error?.code, `ADMIN_GUARD_REQUIRED:${label}`).toBe(
          code,
        );
      }
      expect(await db.aiDebugRun.count(), "ADMIN_GUARD_REQUIRED").toBe(0);
      expect(
        await db.adminCommandReceipt.count({ where: { operationId: "post.admin.ai-debug.test" } }),
      ).toBe(receiptsBefore);
      expect(await db.durableTask.count({ where: { kind: "AI_DEBUG" } })).toBe(tasksBefore);
      expect(mockCallCount()).toBe(0);
    },
  );

  fixtureTest(
    "ai-debug-api: missing CSRF, a mismatched token or a foreign origin is refused",
    async () => {
      const payload = { promptKey: PROMPT_KEY, variables, failureProfile: "success" };
      const noCsrf = await debugTestPost(
        request(ENDPOINT, { session: admin, csrf: null, body: payload }),
        undefined,
      );
      expect(noCsrf.status).toBe(403);
      const wrongCsrf = await debugTestPost(
        request(ENDPOINT, { session: admin, csrf: "0".repeat(64), body: payload }),
        undefined,
      );
      expect(wrongCsrf.status).toBe(403);
      const foreignOrigin = await debugTestPost(
        request(ENDPOINT, { session: admin, origin: "http://127.0.0.1:3999", body: payload }),
        undefined,
      );
      expect(foreignOrigin.status).toBe(403);
      expect(await db.aiDebugRun.count()).toBe(0);
      expect(mockCallCount()).toBe(0);
    },
  );

  fixtureTest(
    "ai-debug-api: GET returns safe aggregates only and performs zero provider calls",
    async () => {
      const accepted = await debugTestPost(
        request(ENDPOINT, {
          session: admin,
          body: { promptKey: PROMPT_KEY, variables, failureProfile: "success" },
        }),
        undefined,
      );
      const runId = (envelope(await body(accepted)).data as { debugRunId: string }).debugRunId;
      expect(await runDebugWorker(db, runId)).toBe("COMPLETED");
      const callsAfterRun = mockCallCount();
      expect(callsAfterRun).toBeGreaterThan(0);
      const first = await debugRunGet(
        request(`/api/admin/ai-debug/runs/${runId}`, { method: "GET", session: admin }),
        {
          params: Promise.resolve({ id: runId }),
        },
      );
      const second = await debugRunGet(
        request(`/api/admin/ai-debug/runs/${runId}`, { method: "GET", session: admin }),
        {
          params: Promise.resolve({ id: runId }),
        },
      );
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const status = parseAiDebugStatus(envelope(await body(first)).data);
      expect(status.status).toBe("SUCCEEDED");
      expect(status.attemptIds).toHaveLength(1);
      expect(status.finalSummary?.schemaValidation.valid).toBe(true);
      expect(status.finalSummary?.promptHash).toMatch(/^[a-f0-9]{64}$/);
      const serialized = JSON.stringify(status);
      for (const forbidden of [
        "baseUrl",
        "secretRef",
        "encryptedKey",
        "ciphertext",
        "ENCRYPTION_KEY",
        "mock.invalid",
        "api.deepseek.com",
      ])
        expect(serialized, forbidden).not.toContain(forbidden);
      expect(mockCallCount()).toBe(callsAfterRun);
    },
  );

  fixtureTest(
    "ai-debug-api: another administrator cannot read the run and errors stay safe",
    async () => {
      const other = await issueSession(db, {
        role: "ADMIN",
        email: "phase018-other-admin@serendipity.invalid",
      });
      const accepted = await debugTestPost(
        request(ENDPOINT, {
          session: admin,
          body: { promptKey: PROMPT_KEY, variables, failureProfile: "success" },
        }),
        undefined,
      );
      const runId = (envelope(await body(accepted)).data as { debugRunId: string }).debugRunId;
      const hidden = await debugRunGet(
        request(`/api/admin/ai-debug/runs/${runId}`, { method: "GET", session: other }),
        { params: Promise.resolve({ id: runId }) },
      );
      expect(hidden.status).toBe(404);
      expect(envelope(await body(hidden)).error?.code).toBe("NOT_FOUND");
      const invalid = await debugTestPost(
        request(ENDPOINT, { session: admin, body: { promptKey: PROMPT_KEY } }),
        undefined,
      );
      expect(invalid.status).toBe(400);
      const failure = envelope(await body(invalid));
      expect(failure.error?.code).toBe("VALIDATION_ERROR");
      expect(failure.requestId).toMatch(/^[0-9a-f-]{36}$/);
      const serialized = JSON.stringify(failure);
      for (const forbidden of ["baseUrl", "secretRef", "encryptedKey", "stack", "synthetic system"])
        expect(serialized, forbidden).not.toContain(forbidden);
    },
  );

  fixtureTest(
    "ai-debug-api: a missing Prompt activation fails the run with CONFIG_ERROR and no egress",
    async () => {
      const definitionId = `prompt-${PROMPT_KEY.replaceAll(".", "-")}`;
      const active = await db.promptModelActivation.findUniqueOrThrow({ where: { definitionId } });
      const tuple = {
        definitionId,
        promptVersionId: active.promptVersionId,
        deploymentId: active.deploymentId,
        deploymentConfigVersion: active.deploymentConfigVersion,
        providerId: active.providerId,
        providerConfigVersion: active.providerConfigVersion,
      };
      await db.$transaction((tx) => activatePromptModelTuple(tx, { ...tuple, status: "DISABLED" }));
      try {
        const accepted = await debugTestPost(
          request(ENDPOINT, {
            session: admin,
            body: { promptKey: PROMPT_KEY, variables, failureProfile: "success" },
          }),
          undefined,
        );
        const runId = (envelope(await body(accepted)).data as { debugRunId: string }).debugRunId;
        await runDebugWorker(db, runId);
        const status = parseAiDebugStatus(
          envelope(
            await body(
              await debugRunGet(
                request(`/api/admin/ai-debug/runs/${runId}`, { method: "GET", session: admin }),
                { params: Promise.resolve({ id: runId }) },
              ),
            ),
          ).data,
        );
        expect(status.status).toBe("FAILED");
        expect(status.errorCode).toBe("CONFIG_ERROR");
        expect(status.attemptIds).toHaveLength(0);
        expect(mockCallCount()).toBe(0);
        const stored = await db.aiDebugRun.findUniqueOrThrow({ where: { id: runId } });
        expect(stored.completedAt).not.toBeNull();
        expect(config().database).toMatch(/^phase018_disposable_/);
      } finally {
        await db.$transaction((tx) => activatePromptModelTuple(tx, { ...tuple, status: "ACTIVE" }));
      }
    },
  );
});
