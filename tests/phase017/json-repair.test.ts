// @vitest-environment node
import { randomBytes } from "node:crypto";
import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { safeParseAiJson } from "@/lib/ai/json-parser";
import { NluExtractOutputSchema, TravelRequirementSchema } from "@/lib/ai/schemas";
import { preservesJsonFacts } from "@/lib/ai/syntax-proof";
import { guardedJsonChat, type GuardedAiClientOptions } from "@/server/ai/guarded-client";
import {
  repairJsonWithAi,
  publicAiOutputFailure,
  type JsonRepairContext,
} from "@/server/ai/json-repair";
import { nluBudgetSnapshot, reserveNluBudget, type NluContext } from "@/server/ai/nlu-context";
import { captureAiOutput } from "@/server/ai/capture-policy";
import { canonicalHash } from "@/server/ai/canonical-hash";
import { createTravelRecord } from "@/server/repositories/travel-record";
import { getChatHistory } from "@/server/chat/history";
import { client, context, initialize, httpProvider, variables, observation } from "./fixture";
import fixtures from "./fixtures.json";

const enabled = !!process.env.PHASE017_FIXTURE_CONFIG;
const db = enabled ? client() : undefined;
afterAll(async () => {
  await db?.$disconnect();
});
const empty = '{"schemaVersion":1,"candidates":[]}';
const repaired = (text: string) => JSON.stringify({ schemaVersion: 1, repairedText: text });
const request = (ctx: NluContext) => ({
  promptKey: "nlu.extract" as const,
  variables: {
    ...variables,
    serverDate: ctx.serverDate,
    timezone: ctx.timezone,
    locale: ctx.locale,
  },
  userMessage: variables.userText,
  context: ctx,
});
async function begin(
  raw: string,
  ctx: NluContext,
  options: Omit<GuardedAiClientOptions, "owner" | "nluContext">,
) {
  const result = await guardedJsonChat(request(ctx), options);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("EXPECTED_PARSE_FAILURE");
  const failure = safeParseAiJson(raw, NluExtractOutputSchema);
  if (failure.ok) throw new Error("EXPECTED_INVALID_FIXTURE");
  expect(result.attemptNo).toBe(1);
  const repairContext: JsonRepairContext<import("@/lib/ai/schemas").NluExtractOutput> = {
    nluContext: ctx,
    targetSchema: NluExtractOutputSchema,
    originalAttemptNo: result.attemptNo!,
    originalPromptKey: "nlu.extract",
    originalVariables: request(ctx).variables,
    clientOptions: options,
  };
  return { failure, repairContext };
}
async function audit(ctx: NluContext, count: number, label: string) {
  const rows = await db!.aiOutputRecord.findMany({
    where: { traceId: ctx.traceId },
    orderBy: { attemptNo: "asc" },
  });
  expect(rows.length).toBe(count);
  expect(rows.map((row) => row.attemptNo)).toEqual(
    Array.from({ length: count }, (_, index) => index + 1),
  );
  expect(rows.every((row) => row.rawOutput === null)).toBe(true);
  for (const row of rows) {
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    expect(row.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.outputHash).toMatch(/^[a-f0-9]{64}$/);
    const prompt = await db!.promptVersion.findUniqueOrThrow({
      where: { id: row.promptVersionId },
    });
    const deployment = await db!.modelDeployment.findUniqueOrThrow({
      where: {
        id_configVersion: { id: row.deploymentId, configVersion: row.deploymentConfigVersion },
      },
    });
    expect(prompt.version).toBe(1);
    expect(row.providerId).toBe(deployment.providerId);
    expect(row.providerConfigVersion).toBe(deployment.providerConfigVersion);
  }
  observation(label, {
    attempts: rows.length,
    rawOutputHits: 0,
    unvalidatedPlanWrites: 0,
    recordsHash: canonicalHash(
      rows.map(({ id, createdAt, ...row }) => ({
        ...row,
        idPresent: !!id,
        timestampPresent: !!createdAt,
      })),
    ),
    statuses: rows.map((row) => row.status),
    errorCodes: rows.map((row) => row.errorCode),
    inputTokens: rows.map((row) => row.inputTokens),
    outputTokens: rows.map((row) => row.outputTokens),
  });
  return rows;
}

describe("syntax proof", () => {
  it("repair-success: punctuation and provable quoted keys preserve scalar types and values", () => {
    for (const [before, after] of [
      [empty.slice(0, -1), empty],
      ["{schemaVersion:1,candidates:[]}", empty],
      ["{'schemaVersion':1,'candidates':[]}", empty],
    ])
      expect(preservesJsonFacts(before, after)).toBe(true);
    for (const [before, after] of [
      ['{"schemaVersion":"1","candidates":[]}', empty],
      [empty, '{"schemaVersion":"1","candidates":[]}'],
      ['{"value":word}', '{"value":"word"}'],
    ])
      expect(preservesJsonFacts(before, after)).toBe(false);
  });
  it("repair-failure: new facts changed bindings and ambiguous tokens are rejected", () => {
    expect(
      preservesJsonFacts(
        '{"schemaVersion":1,"candidates":[{"field","origin":"text","深圳":"confidence":1}]}',
        '{"schemaVersion":1,"candidates":[{"field":"origin","text":"深圳","confidence":1}]}',
      ),
    ).toBe(false);
    for (const [before, after] of [
      ['{"lat":1,"lng":2}', '{"lat":2,"lng":1}'],
      ['{"date":"2026-09-15"}', '{"date":"2026-09-16"}'],
      ['{"price":"12.5"}', '{"price":"0"}'],
      ['{"id":"old"}', '{"id":"new"}'],
      ['{"route":["a","b"]}', '{"route":["b","a"]}'],
      ['{"source":null}', '{"source":"invented"}'],
      ['{"a":1}', '{"a":1,"b":2}'],
      ['{"a":"unterminated}', '{"a":"unterminated"}'],
    ])
      expect(preservesJsonFacts(before, after)).toBe(false);
  });
  it("repair-failure: ordinary API projection maps technical failures safely", () => {
    for (const [errorCode, status] of [
      ["VALIDATION_ERROR", 400],
      ["COST_LIMIT", 429],
      ["RATE_LIMITED", 429],
      ["CANCELLED", 409],
      ["FEATURE_DISABLED", 503],
      ["CONFIG_ERROR", 503],
      ["PROVIDER_TIMEOUT", 503],
      ["PROVIDER_UNAVAILABLE", 503],
    ] as const)
      expect(publicAiOutputFailure({ ok: false, errorCode, repairAttempts: 0 })).toEqual({
        status,
        errorCode,
      });
    for (const internalCode of ["INVALID_JSON", "SCHEMA_MISMATCH"] as const)
      expect(
        publicAiOutputFailure({
          ok: false,
          errorCode: "PROVIDER_UNAVAILABLE",
          internalCode,
          repairAttempts: 2,
        }),
      ).toEqual({ status: 503, errorCode: "PROVIDER_UNAVAILABLE" });
  });
});

describe.runIf(enabled)("guarded JSON repair integration", () => {
  beforeEach(async () => {
    await initialize(db!);
  });
  it("parse: code-fenced output is parsed without any formal-plan write", async () => {
    const ctx = context(),
      before = await db!.travelRecord.count();
    const result = await guardedJsonChat(request(ctx), {
      db: db!,
      mockOutput: `\`\`\`json\n${empty}\n\`\`\``,
    });
    expect(result.ok).toBe(true);
    expect(await db!.travelRecord.count()).toBe(before);
    expect((await audit(ctx, 1, "parse"))[0].parsedOk).toBe(true);
  });
  it("repair-success: a real guarded repair appends the original and repair with exact version bindings", async () => {
    const raw = empty.slice(0, -1),
      ctx = context(),
      server = await httpProvider(db!, [raw, repaired(empty)]),
      before = await db!.travelRecord.count();
    try {
      const { failure, repairContext } = await begin(raw, ctx, server.options);
      const result = await repairJsonWithAi(raw, failure, repairContext);
      expect(result).toEqual({ ok: true, data: JSON.parse(empty), repairAttempts: 1 });
      expect(server.calls()).toBe(2);
      expect(await db!.travelRecord.count()).toBe(before);
      const rows = await audit(ctx, 2, "repair-success");
      expect(rows.map((row) => row.parsedOk)).toEqual([false, true]);
      expect(rows[0].errorCode).toBe("INVALID_JSON");
      expect(rows[1].promptVersionId).toBe("prompt-planner-repair_json-v1");
      const payload = JSON.parse(server.requests[1].body) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(
        payload.messages.filter((m) => m.role === "system").some((m) => m.content.includes(raw)),
      ).toBe(false);
      expect(payload.messages.some((m) => m.role === "user" && m.content.includes("rawText"))).toBe(
        true,
      );
    } finally {
      await server.close();
    }
  });
  it("repair-success: syntax repair with missing usage retains truthful accounting", async () => {
    const raw = empty.slice(0, -1),
      ctx = context(),
      server = await httpProvider(db!, [raw, repaired(empty)], { usage: false });
    try {
      const { failure, repairContext } = await begin(raw, ctx, server.options);
      expect((await repairJsonWithAi(raw, failure, repairContext)).ok).toBe(true);
      const rows = await audit(ctx, 2, "repair-success");
      expect(rows.every((row) => row.inputTokens === null && row.outputTokens === null)).toBe(true);
      const reservations = await db!.aiUsageReservation.findMany({
        where: { traceId: ctx.traceId },
      });
      expect(reservations.every((row) => row.status === "RECONCILING")).toBe(true);
      expect(nluBudgetSnapshot(ctx).tokensUsedOrReserved).toBe(
        reservations.reduce((n, row) => n + row.estimatedTokens, 0),
      );
    } finally {
      await server.close();
    }
  });
  it("repair-failure: scalar type coercion is rejected even if the repaired schema passes", async () => {
    const raw = '{"schemaVersion":"1","candidates":[]}',
      ctx = context(),
      server = await httpProvider(db!, [raw, repaired(empty)]);
    try {
      const { failure, repairContext } = await begin(raw, ctx, server.options);
      expect(await repairJsonWithAi(raw, failure, repairContext)).toMatchObject({
        ok: false,
        errorCode: "VALIDATION_ERROR",
        repairAttempts: 1,
      });
      expect(server.calls()).toBe(2);
      await audit(ctx, 2, "repair-failure");
    } finally {
      await server.close();
    }
  });
  it("repair-failure: two unsuccessful repairs stop without a third call or partial write", async () => {
    const raw = '{"schemaVersion":1}',
      ctx = context(),
      server = await httpProvider(db!, [raw, repaired(raw)]),
      before = await db!.travelRecord.count();
    try {
      const { failure, repairContext } = await begin(raw, ctx, server.options);
      const result = await repairJsonWithAi(raw, failure, repairContext);
      expect(result).toMatchObject({
        ok: false,
        errorCode: "PROVIDER_UNAVAILABLE",
        internalCode: "SCHEMA_MISMATCH",
      });
      expect(server.calls(), "REPAIR_LIMIT_REQUIRED").toBe(3);
      expect(result.repairAttempts, "REPAIR_LIMIT_REQUIRED").toBe(2);
      expect(await db!.travelRecord.count()).toBe(before);
      expect(
        (await audit(ctx, 3, "repair-failure")).every(
          (row) => !row.parsedOk && row.status === "FAILED",
        ),
      ).toBe(true);
      const repeat = await repairJsonWithAi(raw, failure, repairContext);
      expect(repeat.ok).toBe(false);
      expect(server.calls()).toBe(3);
    } finally {
      await server.close();
    }
  });
  it("repair-failure: altered facts fail even when both schema and original input references allow them", async () => {
    const raw = '{"schemaVersion":1,"candidates":[{"field":"origin","text":"深圳","confidence":1}]';
    const changed =
      '{"schemaVersion":1,"candidates":[{"field":"origin","text":"北京","confidence":1}]}';
    const ctx = context(),
      server = await httpProvider(db!, [raw, repaired(changed)]);
    try {
      const { failure, repairContext } = await begin(raw, ctx, server.options);
      const result = await repairJsonWithAi(raw, failure, repairContext);
      expect(result.ok, "FACT_PRESERVATION_REQUIRED").toBe(false);
      expect(result).toMatchObject({ errorCode: "VALIDATION_ERROR", repairAttempts: 1 });
      const rows = await audit(ctx, 2, "repair-failure");
      expect(rows[1].errorCode).toBe("VALIDATION_ERROR");
    } finally {
      await server.close();
    }
  });
  it("repair-failure: missing original attempts and changed raw bytes never call the provider", async () => {
    const raw = empty.slice(0, -1),
      ctx = context(),
      server = await httpProvider(db!, [raw, repaired(empty)]);
    try {
      const { failure, repairContext } = await begin(raw, ctx, server.options);
      expect((await repairJsonWithAi(raw + " ", failure, repairContext)).ok).toBe(false);
      expect(
        (await repairJsonWithAi(raw, failure, { ...repairContext, originalAttemptNo: 20 })).ok,
      ).toBe(false);
      expect(server.calls()).toBe(1);
    } finally {
      await server.close();
    }
  });
  it("repair-failure: a replacement context or altered variables cannot claim the original attempt", async () => {
    const raw = empty.slice(0, -1),
      controller = new AbortController(),
      ctx = context({ signal: controller.signal }),
      server = await httpProvider(db!, [raw, repaired(empty)]);
    try {
      const { failure, repairContext } = await begin(raw, ctx, server.options);
      const replacement = context({ traceId: ctx.traceId, requestId: ctx.requestId });
      expect(
        await repairJsonWithAi(raw, failure, { ...repairContext, nluContext: replacement }),
      ).toMatchObject({ ok: false, errorCode: "CONFIG_ERROR", repairAttempts: 0 });
      expect(
        await repairJsonWithAi(raw, failure, {
          ...repairContext,
          originalVariables: { ...request(ctx).variables, userText: "changed" },
        }),
      ).toMatchObject({ ok: false, errorCode: "CONFIG_ERROR", repairAttempts: 0 });
      controller.abort();
      expect(await repairJsonWithAi(raw, failure, repairContext)).toMatchObject({
        ok: false,
        errorCode: "CANCELLED",
        repairAttempts: 0,
      });
      expect(server.calls()).toBe(1);
      await audit(ctx, 1, "repair-failure");
    } finally {
      await server.close();
    }
  });
  it("repair-failure: caller mutation cannot change the original reference snapshot during repair", async () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      candidates: [{ field: "origin", text: "北京", confidence: 1 }],
    });
    const raw = text.slice(0, -1),
      ctx = context(),
      server = await httpProvider(db!, [raw, repaired(text)]);
    const originalVariables = { ...request(ctx).variables, userText: "深圳" };
    try {
      const first = await guardedJsonChat(
        { ...request(ctx), variables: originalVariables },
        server.options,
      );
      expect(first.ok).toBe(false);
      const failure = safeParseAiJson(raw, NluExtractOutputSchema);
      if (failure.ok || first.ok) throw new Error("EXPECTED_PARSE_FAILURE");
      const pending = repairJsonWithAi(raw, failure, {
        nluContext: ctx,
        originalAttemptNo: first.attemptNo!,
        originalPromptKey: "nlu.extract",
        originalVariables,
        targetSchema: NluExtractOutputSchema,
        clientOptions: server.options,
      });
      originalVariables.userText = "深圳北京";
      expect(await pending).toMatchObject({
        ok: false,
        errorCode: "VALIDATION_ERROR",
        repairAttempts: 1,
      });
      expect(server.calls()).toBe(2);
      await audit(ctx, 2, "repair-failure");
    } finally {
      await server.close();
    }
  });
  it("repair-failure: repair transport rate limits are returned without nested retry", async () => {
    const raw = empty.slice(0, -1),
      ctx = context(),
      server = await httpProvider(db!, [raw, { status: 429 }]);
    try {
      const { failure, repairContext } = await begin(raw, ctx, server.options);
      const result = await repairJsonWithAi(raw, failure, repairContext);
      expect(result).toMatchObject({ ok: false, errorCode: "RATE_LIMITED", repairAttempts: 1 });
      expect(server.calls()).toBe(2);
      await audit(ctx, 2, "repair-failure");
    } finally {
      await server.close();
    }
  });
  it("repair-failure: cancellation deadline and token exhaustion share the original context", async () => {
    for (const mode of ["cancel", "deadline", "tokens"] as const) {
      const control = new AbortController();
      let now = Date.now();
      const raw = empty.slice(0, -1),
        ctx = context({ signal: control.signal, deadlineAt: now + 30000 }, () => now),
        server = await httpProvider(db!, [raw, repaired(empty)]);
      try {
        const { failure, repairContext } = await begin(raw, ctx, server.options);
        if (mode === "cancel") control.abort();
        if (mode === "deadline") now += 30001;
        if (mode === "tokens")
          reserveNluBudget(
            ctx,
            ctx.tokenBudget - nluBudgetSnapshot(ctx).tokensUsedOrReserved,
            new Prisma.Decimal(0),
          );
        const result = await repairJsonWithAi(raw, failure, repairContext);
        expect(result).toMatchObject({
          ok: false,
          errorCode:
            mode === "cancel"
              ? "CANCELLED"
              : mode === "deadline"
                ? "PROVIDER_TIMEOUT"
                : "COST_LIMIT",
          repairAttempts: 0,
        });
        expect(server.calls()).toBe(1);
      } finally {
        await server.close();
      }
    }
  });
  it("repair-failure: cost from the original request cannot be reset for repair", async () => {
    const raw = empty.slice(0, -1),
      ctx = context({ costBudget: "1.5" }),
      server = await httpProvider(db!, [raw, repaired(empty)], { fixedCost: "1" });
    try {
      const { failure, repairContext } = await begin(raw, ctx, server.options);
      expect(await repairJsonWithAi(raw, failure, repairContext)).toMatchObject({
        ok: false,
        errorCode: "COST_LIMIT",
        repairAttempts: 0,
      });
      expect(server.calls()).toBe(1);
      expect(nluBudgetSnapshot(ctx).costUsedOrReserved).toBe("1");
    } finally {
      await server.close();
    }
  });
  it("repair-failure: production persistence policy keeps successful failed and twice repaired output raw text absent", async () => {
    const canary = "private_" + randomBytes(24).toString("hex");
    const successRaw = JSON.stringify({
      schemaVersion: 1,
      candidates: [{ field: "origin", text: canary, confidence: 1 }],
    });
    const raw = JSON.stringify({
      schemaVersion: 1,
      candidates: [{ field: "origin", text: canary }],
    });
    const server = await httpProvider(db!, [successRaw, raw, repaired(raw)]);
    const logs: unknown[][] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...values) => logs.push(values));
    const warn = vi.spyOn(console, "warn").mockImplementation((...values) => logs.push(values));
    const error = vi.spyOn(console, "error").mockImplementation((...values) => logs.push(values));
    try {
      const first = context(),
        second = context();
      expect(
        (
          await guardedJsonChat(
            {
              ...request(first),
              variables: { ...request(first).variables, userText: canary },
              userMessage: canary,
            },
            { ...server.options, capturePolicy: { mode: "SYNTHETIC_DEBUG", maxChars: 100 } },
          )
        ).ok,
      ).toBe(true);
      const started = await guardedJsonChat(
        {
          ...request(second),
          variables: { ...request(second).variables, userText: canary },
          userMessage: canary,
        },
        server.options,
      );
      expect(started.ok).toBe(false);
      const failure = safeParseAiJson(raw, NluExtractOutputSchema);
      if (failure.ok) throw new Error("FIXTURE_INVALID");
      await repairJsonWithAi(raw, failure, {
        nluContext: second,
        targetSchema: NluExtractOutputSchema,
        originalAttemptNo: 1,
        originalPromptKey: "nlu.extract",
        originalVariables: { ...request(second).variables, userText: canary },
        clientOptions: {
          ...server.options,
          capturePolicy: { mode: "SYNTHETIC_DEBUG", maxChars: 100 },
        },
      });
      const rows = [
        ...(await audit(first, 1, "parse")),
        ...(await audit(second, 3, "repair-failure")),
      ];
      expect(JSON.stringify(rows).includes(canary)).toBe(false);
      expect(JSON.stringify(logs).includes(canary)).toBe(false);
      observation("repair-failure", {
        productionPersistencePolicy: true,
        isolatedProvider: true,
        dbRawHits: 0,
        logRawHits: 0,
        evidenceRawHits: 0,
        observedAttempts: 4,
      });
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      await server.close();
    }
  });
  it("repair-success: explicit synthetic mock capture is cropped and remains opt in", async () => {
    const ctx = context(),
      captured: string[] = [];
    expect(
      (
        await guardedJsonChat(request(ctx), {
          db: db!,
          mockOutput: empty,
          capturePolicy: { mode: "SYNTHETIC_DEBUG", maxChars: 12 },
          onDebugCapture: (text) => captured.push(text),
        })
      ).ok,
    ).toBe(true);
    const row = await db!.aiOutputRecord.findFirstOrThrow({ where: { traceId: ctx.traceId } });
    expect(row.rawOutput).toBeNull();
    expect(captured).toEqual([empty.slice(0, 12)]);
    expect(captureAiOutput(empty, undefined, true)).toBeNull();
    expect(
      captureAiOutput("authorization: synthetic", { mode: "SYNTHETIC_DEBUG", maxChars: 12 }, true),
    ).toBe("[REDACTED]");
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    try {
      const { captureAiOutput: productionCapture } = await import("@/server/ai/capture-policy");
      expect(productionCapture(empty, { mode: "SYNTHETIC_DEBUG", maxChars: 12 }, true)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
  it("repair-success: throwing optional debug capture cannot erase an attempted call", async () => {
    const ctx = context();
    const result = await guardedJsonChat(request(ctx), {
      db: db!,
      mockOutput: empty,
      capturePolicy: { mode: "SYNTHETIC_DEBUG", maxChars: 20 },
      onDebugCapture() {
        throw new Error("synthetic debug sink unavailable");
      },
    });
    expect(result.ok).toBe(true);
    expect((await audit(ctx, 1, "repair-success"))[0].parsedOk).toBe(true);
  });
  it("schema: only validated requirement snapshots can be persisted and history checks ownership", async () => {
    const user = await db!.user.create({
      data: {
        email: `fixture_${randomBytes(8).toString("hex")}@serendipity.invalid`,
        passwordHash: "synthetic",
      },
    });
    const before = await db!.travelRecord.count();
    await expect(
      createTravelRecord(
        {
          owner: { userId: user.id },
          title: "合成需求",
          requirementJson: { schemaVersion: 1 } as never,
        },
        db!,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await db!.travelRecord.count()).toBe(before);
    const row = await createTravelRecord(
      {
        owner: { userId: user.id },
        title: "合成需求",
        requirementJson: TravelRequirementSchema.parse(fixtures.requirement),
      },
      db!,
    );
    expect(row.requirementJson).toEqual(fixtures.requirement);
    expect(row.version).toBe(0);
    expect(row.status).toBe("DRAFT");
    await db!.chatMessage.createMany({
      data: [
        { travelRecordId: row.id, role: "SYSTEM", kind: "TEXT", content: "规则", sequence: 1 },
        { travelRecordId: row.id, role: "USER", kind: "TEXT", content: "最近", sequence: 2 },
      ],
    });
    const history = await getChatHistory(
      { owner: { userId: user.id }, travelRecordId: row.id, maxMessages: 1 },
      db!,
    );
    expect(history.map((message) => message.sequence)).toEqual([1, 2]);
    await expect(
      getChatHistory({ owner: { userId: "other_user" }, travelRecordId: row.id }, db!),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
