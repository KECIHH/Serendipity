// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalHash, promptKeyContract } from "@/lib/ai/schemas";
import { callGuardedAi } from "@/server/ai/guarded-client";
import { resolvePromptSnapshot } from "@/server/services/prompt-service";
import {
  estimateUsage,
  reserveUsage,
  reconcileReservation,
  releaseUnsentReservation,
} from "@/server/ai/usage-reservations";
import { encryptSecret } from "@/server/security/secret-envelope";
import { resolveDeepSeekSecret } from "@/server/ai/deepseek-provider";
import { registerCanary } from "../phase013/api-key-fixture";
import {
  ensurePhase015Enabled,
  phase015Client,
  phase015OwnerClient,
  promptInput,
  resetGovernance,
  syntheticOwner,
  createDeployment,
  activateFixture,
  setAiEnabled,
} from "./fixture";
import { startHttpFixture, sendCompletion, publicDns } from "./http-fixture";

const enabled = Boolean(process.env.PHASE015_FIXTURE_CONFIG);
const db = enabled ? phase015Client() : undefined;
beforeEach(async () => {
  if (db) {
    await resetGovernance(db);
    await ensurePhase015Enabled(db);
  }
});
afterAll(async () => {
  await db?.$disconnect();
});
const key = "export.markdown";
const output = promptKeyContract(key).fixtureOutput;
const input = (traceId = randomUUID(), userMessage = "synthetic user input") => ({
  promptKey: key,
  variables: promptInput[key],
  userMessage,
  traceId,
});
const options = () => ({ db: db!, owner: syntheticOwner() });
async function activeKey(
  status: "ACTIVE" | "DISABLED" | "REVOKED" = "ACTIVE",
  fingerprint?: string,
) {
  const id = `synthetic-key-${randomUUID()}`,
    plainKey = `phase015_${randomBytes(24).toString("hex")}`;
  registerCanary({ plainKey });
  await db!.apiKeyConfig.create({
    data: {
      id,
      provider: "deepseek",
      name: "synthetic test key",
      status,
      ...encryptSecret({ id, provider: "deepseek", plainKey }),
      ...(fingerprint ? { keyFingerprint: fingerprint } : {}),
      ...(status === "REVOKED" ? { revokedAt: new Date() } : {}),
    },
  });
  return { id, plainKey };
}
async function live(options: Parameters<typeof createDeployment>[1] = {}) {
  const tuple = await createDeployment(db!, { mode: "LIVE", ...options });
  await activateFixture(db!, key, tuple);
  return tuple;
}
const snapshot = () => db!.$transaction((tx) => resolvePromptSnapshot(tx, key, promptInput[key]));
const reserve = (resolved: Awaited<ReturnType<typeof snapshot>>, now = Date.now(), costCap = "1") =>
  reserveUsage(db!, resolved, {
    traceId: randomUUID(),
    attemptNo: 1,
    requestBytes: 100,
    now,
    costCap,
    signal: new AbortController().signal,
  });

describe.skipIf(!enabled)("Phase015 guarded client", () => {
  it("[kill-switch] NONE dispatches without credentials and ACTIVE REQUIRED resolves only inside the adapter", async () => {
    const fixture = await startHttpFixture((_row, response) => sendCompletion(response, output));
    try {
      await live();
      const noSecret = vi.fn(() => {
        throw new Error("NONE must not decrypt");
      });
      expect(
        await callGuardedAi(input(), {
          ...options(),
          ...fixture,
          liveEgressAllowed: true,
          resolveSecret: noSecret,
        }),
      ).toMatchObject({ ok: true });
      expect(noSecret).not.toHaveBeenCalled();
      expect(fixture.requests[0].headers.authorization === undefined).toBe(true);
      const secret = await activeKey();
      await live({ secretRef: secret.id });
      const resolver = vi.fn(resolveDeepSeekSecret);
      expect(
        await callGuardedAi(input(), {
          ...options(),
          ...fixture,
          liveEgressAllowed: true,
          resolveSecret: resolver,
        }),
      ).toMatchObject({ ok: true });
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(fixture.requests[1].headers.authorization === `Bearer ${secret.plainKey}`).toBe(true);
      const records = JSON.stringify(await db!.aiOutputRecord.findMany());
      expect(records.includes(secret.plainKey)).toBe(false);
      expect(records.includes('"rawOutput":null')).toBe(true);
    } finally {
      await fixture.close();
    }
  });
  it("[kill-switch] a valid envelope with a mismatched fingerprint is refused before transport", async () => {
    const fixture = await startHttpFixture((_row, response) => sendCompletion(response, output));
    try {
      const secret = await activeKey("ACTIVE", canonicalHash(randomUUID()));
      await live({ secretRef: secret.id });
      const request = input();
      expect(
        await callGuardedAi(request, { ...options(), ...fixture, liveEgressAllowed: true }),
      ).toMatchObject({ ok: false, errorCode: "CONFIG_ERROR" });
      expect(fixture.requests).toHaveLength(0);
      expect(await db!.aiUsageReservation.count({ where: { traceId: request.traceId } })).toBe(0);
    } finally {
      await fixture.close();
    }
  });
  it("[kill-switch] absent LIVE admission and inactive required keys create no reservations or requests", async () => {
    const fixture = await startHttpFixture((_row, response) => sendCompletion(response, output));
    try {
      await live();
      const blocked = input();
      expect(await callGuardedAi(blocked, { ...options(), ...fixture })).toMatchObject({
        ok: false,
        errorCode: "CONFIG_ERROR",
      });
      expect(await db!.aiUsageReservation.count({ where: { traceId: blocked.traceId } })).toBe(0);
      for (const status of ["DISABLED", "REVOKED"] as const) {
        const secret = await activeKey(status);
        await live({ secretRef: secret.id });
        const request = input();
        expect(
          await callGuardedAi(request, { ...options(), ...fixture, liveEgressAllowed: true }),
        ).toMatchObject({ ok: false, errorCode: "CONFIG_ERROR" });
        expect(await db!.aiUsageReservation.count({ where: { traceId: request.traceId } })).toBe(0);
      }
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });
  it("[timeout-cancel-retry] real before-byte HTTP retries at most once with separate durable reservations", async () => {
    let count = 0;
    const fixture = await startHttpFixture((_row, response) => {
      if (++count === 1) {
        response.writeHead(429, { "retry-after": "0.03" });
        response.end();
      } else sendCompletion(response, output);
    });
    try {
      await live();
      const request = input();
      const start = Date.now();
      expect(
        await callGuardedAi(request, {
          ...options(),
          ...fixture,
          liveEgressAllowed: true,
          jitter: () => 1,
        }),
      ).toMatchObject({ ok: true, attemptNo: 2 });
      expect(Date.now() - start).toBeGreaterThanOrEqual(30);
      expect(count).toBe(2);
      const reservations = await db!.aiUsageReservation.findMany({
        where: { traceId: request.traceId },
        orderBy: { attemptNo: "asc" },
      });
      expect(reservations.map((x) => [x.attemptNo, x.status])).toEqual([
        [1, "RECONCILING"],
        [2, "SETTLED"],
      ]);
      expect(await db!.aiOutputRecord.count({ where: { traceId: request.traceId } })).toBe(2);
      count = 0;
      const always = await startHttpFixture((_row, response) => {
        response.writeHead(503);
        response.end();
      });
      try {
        const failed = input();
        expect(
          await callGuardedAi(failed, { ...options(), ...always, liveEgressAllowed: true }),
        ).toMatchObject({ ok: false, errorCode: "PROVIDER_UNAVAILABLE" });
        expect(always.requests).toHaveLength(2);
      } finally {
        await always.close();
      }
    } finally {
      await fixture.close();
    }
  });
  it("[timeout-cancel-retry] first byte, invalid JSON and schema mismatches never retry and are traced", async () => {
    let mode = "body";
    const fixture = await startHttpFixture((_row, response) => {
      if (mode === "schema") return sendCompletion(response, { unexpected: true });
      response.writeHead(mode === "body" ? 500 : 200, { "content-type": "application/json" });
      response.end("{");
    });
    try {
      await live();
      for (mode of ["body", "json", "schema"]) {
        const request = input(),
          before = fixture.requests.length;
        expect(
          await callGuardedAi(request, { ...options(), ...fixture, liveEgressAllowed: true }),
        ).toMatchObject({ ok: false, errorCode: "PROVIDER_UNAVAILABLE" });
        expect(fixture.requests.length - before).toBe(1);
        const record = await db!.aiOutputRecord.findUniqueOrThrow({
          where: { traceId_attemptNo: { traceId: request.traceId, attemptNo: 1 } },
        });
        expect(record.parsedOk).toBe(false);
        expect(record.rawOutput).toBeNull();
        if (mode !== "body")
          expect(record.errorCode).toBe(mode === "json" ? "INVALID_JSON" : "SCHEMA_MISMATCH");
      }
    } finally {
      await fixture.close();
    }
  });
  it("[timeout-cancel-retry] a shared total deadline includes Retry-After and terminates blocked HTTP", async () => {
    let retry = false;
    const fixture = await startHttpFixture((_row, response) => {
      if (retry) {
        response.writeHead(429, { "retry-after": "2" });
        response.end();
      } else {
        response.writeHead(200);
        response.write("{");
      }
    });
    try {
      await live({ timeout: 1000 });
      const request = input(),
        started = Date.now();
      expect(
        await callGuardedAi(request, { ...options(), ...fixture, liveEgressAllowed: true }),
      ).toMatchObject({ ok: false, errorCode: "PROVIDER_TIMEOUT" });
      expect(Date.now() - started).toBeLessThan(1800);
      expect(fixture.requests).toHaveLength(1);
      expect(
        (await db!.aiUsageReservation.findFirstOrThrow({ where: { traceId: request.traceId } }))
          .status,
      ).toBe("RECONCILING");
      retry = true;
      const second = input();
      expect(
        await callGuardedAi(second, { ...options(), ...fixture, liveEgressAllowed: true }),
      ).toMatchObject({ ok: false, errorCode: "PROVIDER_TIMEOUT" });
      expect(await db!.aiUsageReservation.count({ where: { traceId: second.traceId } })).toBe(1);
    } finally {
      await fixture.close();
    }
  });
  it("[timeout-cancel-retry] external AbortSignal cancels an in-flight request and never retries", async () => {
    const fixture = await startHttpFixture((_row, response) => {
      response.writeHead(200);
      response.write("{");
    });
    try {
      await live();
      const controller = new AbortController(),
        request = input();
      const started = Date.now();
      const pending = callGuardedAi(
        { ...request, signal: controller.signal },
        { ...options(), ...fixture, liveEgressAllowed: true },
      );
      await fixture.waitForRequests(1);
      controller.abort();
      expect(await pending).toMatchObject({ ok: false, errorCode: "CANCELLED" });
      expect(fixture.requests).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(1200);
      const reservation = await db!.aiUsageReservation.findFirstOrThrow({
        where: { traceId: request.traceId },
      });
      expect(reservation).toMatchObject({
        status: "RECONCILING",
        submissionState: "MAY_HAVE_BEEN_SENT",
      });
      expect(
        (await db!.aiOutputRecord.findFirstOrThrow({ where: { traceId: request.traceId } })).status,
      ).toBe("CANCELLED");
      const pre = input();
      expect(
        await callGuardedAi(
          { ...pre, signal: controller.signal },
          { ...options(), ...fixture, liveEgressAllowed: true },
        ),
      ).toMatchObject({ ok: false, errorCode: "CANCELLED" });
      expect(await db!.aiUsageReservation.count({ where: { traceId: pre.traceId } })).toBe(0);
    } finally {
      await fixture.close();
    }
  });
  it("[quota-cost] concurrent Decimal reservations never exceed the frozen token or cost cap", async () => {
    const tuple = await createDeployment(db!, {
      quota: 1000,
      cost: "1",
      maxOutputTokens: 128,
      pricing: {
        inputPerToken: "0.001",
        outputPerToken: "0.001",
        fixedPerRequest: "0.1",
        basis: "UTF8_BYTE_UPPER_BOUND_V1",
      },
    });
    await activateFixture(db!, key, tuple);
    const resolved = await snapshot();
    expect(estimateUsage(resolved, 100).estimatedCost.toString()).toBe("0.456");
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => reserve(resolved)));
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(2);
    expect(
      results
        .filter((x) => x.status === "rejected")
        .every(
          (x) =>
            x.status === "rejected" && ["COST_LIMIT", "RATE_LIMITED"].includes(x.reason.message),
        ),
    ).toBe(true);
    const rows = await db!.aiUsageReservation.findMany({
      where: { bucketKey: { startsWith: `daily:${tuple.providerId}:` } },
    });
    expect(rows.reduce((sum, r) => sum + r.estimatedTokens, 0)).toBe(712);
    expect(rows[0].estimatedCost.add(rows[1].estimatedCost).toString()).toBe("0.912");
    for (const row of rows) await releaseUnsentReservation(db!, row.id);
    await expect(reserve(resolved, Date.now(), "0.1")).rejects.toThrow("COST_LIMIT");
  });
  it("[quota-cost] NOT_SENT release and unknown upper-bound reconciliation are idempotent", async () => {
    const resolved = await snapshot();
    const unsent = await reserve(resolved);
    await releaseUnsentReservation(db!, unsent.id);
    await releaseUnsentReservation(db!, unsent.id);
    expect(
      (await db!.aiUsageReservation.findUniqueOrThrow({ where: { id: unsent.id } })).status,
    ).toBe("RELEASED");
    const unknown = await reserve(resolved);
    await db!.aiUsageReservation.update({
      where: { id: unknown.id },
      data: { status: "RECONCILING", submissionState: "MAY_HAVE_BEEN_SENT" },
    });
    await expect(releaseUnsentReservation(db!, unknown.id)).rejects.toThrow("CONFIG_ERROR");
    await expect(
      db!.aiUsageReservation.update({
        where: { id: unknown.id },
        data: { status: "RELEASED", submissionState: "NOT_SENT", settledAt: new Date() },
      }),
    ).rejects.toThrow();
    await expect(
      reconcileReservation(db!, unknown.id, { mode: "UPPER_BOUND", now: new Date() }),
    ).rejects.toThrow("CONFIG_ERROR");
    const now = new Date(unknown.expiresAt.getTime() + 1);
    await reconcileReservation(db!, unknown.id, { mode: "UPPER_BOUND", now });
    await reconcileReservation(db!, unknown.id, { mode: "UPPER_BOUND", now });
    const settled = await db!.aiUsageReservation.findUniqueOrThrow({ where: { id: unknown.id } });
    expect(settled.status).toBe("SETTLED");
    expect(settled.actualTokens).toBe(unknown.estimatedTokens);
    expect(settled.actualCost?.equals(unknown.estimatedCost)).toBe(true);
    await expect(
      db!.aiUsageReservation.update({
        where: { id: unknown.id },
        data: { status: "RESERVED", settledAt: null },
      }),
    ).rejects.toThrow();
  });
  it("[quota-cost] a lost response remains charged across days and provider proof settles only once", async () => {
    const tuple = await createDeployment(db!, {
      quota: 1000,
      cost: "0.5",
      maxOutputTokens: 128,
      pricing: {
        inputPerToken: "0.001",
        outputPerToken: "0.001",
        fixedPerRequest: "0.1",
        basis: "UTF8_BYTE_UPPER_BOUND_V1",
      },
    });
    await activateFixture(db!, key, tuple);
    const resolved = await snapshot();
    const yesterday = Date.UTC(2026, 8, 12, 23, 59),
      today = yesterday + 120000;
    const row = await reserve(resolved, yesterday);
    await db!.aiUsageReservation.update({
      where: { id: row.id },
      data: { status: "RECONCILING", submissionState: "ACCEPTED", providerRequestId: "proof_1" },
    });
    await expect(reserve(resolved, today)).rejects.toThrow("COST_LIMIT");
    await expect(
      reconcileReservation(db!, row.id, {
        mode: "PROVIDER_PROOF",
        now: new Date(today),
        providerRequestId: "wrong",
        actualTokens: 1,
        actualCost: "0",
      }),
    ).rejects.toThrow("CONFIG_ERROR");
    const proof = {
      mode: "PROVIDER_PROOF" as const,
      now: new Date(today),
      providerRequestId: "proof_1",
      actualTokens: 10,
      actualCost: "0.1",
    };
    await reconcileReservation(db!, row.id, proof);
    await reconcileReservation(db!, row.id, proof);
    await expect(reconcileReservation(db!, row.id, { ...proof, actualCost: "0" })).rejects.toThrow(
      "CONFIG_ERROR",
    );
    expect(
      (
        await db!.aiUsageReservation.findUniqueOrThrow({ where: { id: row.id } })
      ).actualCost?.toString(),
    ).toBe("0.1");
    await expect(reserve(resolved, today)).resolves.toMatchObject({ status: "RESERVED" });
  });
  it("[kill-switch] an emergency kill or revoke during preparation stops the dispatch", async () => {
    const fixture = await startHttpFixture((_row, response) => sendCompletion(response, output));
    try {
      const secret = await activeKey();
      await live({ secretRef: secret.id });
      const killed = input();
      const killDns = (async () => {
        await setAiEnabled(db!, false);
        return await publicDns("api.deepseek.com", { all: true });
      }) as unknown as typeof publicDns;
      expect(
        await callGuardedAi(killed, {
          ...options(),
          ...fixture,
          liveEgressAllowed: true,
          dnsLookup: killDns,
        }),
      ).toMatchObject({ ok: false, errorCode: "FEATURE_DISABLED" });
      expect(await db!.aiUsageReservation.count({ where: { traceId: killed.traceId } })).toBe(0);
      await setAiEnabled(db!, true);
      const revoked = input();
      const revokeDns = (async () => {
        await db!.apiKeyConfig.update({
          where: { id: secret.id },
          data: { status: "REVOKED", revision: 1, revokedAt: new Date() },
        });
        return await publicDns("api.deepseek.com", { all: true });
      }) as unknown as typeof publicDns;
      expect(
        await callGuardedAi(revoked, {
          ...options(),
          ...fixture,
          liveEgressAllowed: true,
          dnsLookup: revokeDns,
        }),
      ).toMatchObject({ ok: false, errorCode: "CONFIG_ERROR" });
      expect(fixture.requests).toHaveLength(0);
      expect(
        (await db!.aiUsageReservation.findFirstOrThrow({ where: { traceId: revoked.traceId } }))
          .status,
      ).toBe("RELEASED");
    } finally {
      await fixture.close();
    }
  });
  it("[version-evidence] request content, policy, revisions and exact model configuration bind every attempt", async () => {
    const fixture = await startHttpFixture((_row, response) => sendCompletion(response, output));
    try {
      const tuple = await live({ deploymentVersion: 2, providerVersion: 3, maxOutputTokens: 128 });
      const requests = [
        input(undefined, "synthetic message A"),
        input(undefined, "synthetic message B"),
      ];
      for (const request of requests)
        expect(
          await callGuardedAi(request, { ...options(), ...fixture, liveEgressAllowed: true }),
        ).toMatchObject({ ok: true });
      const records = await db!.aiOutputRecord.findMany({
        where: { traceId: { in: requests.map((r) => r.traceId) } },
        orderBy: { createdAt: "asc" },
      });
      expect(records).toHaveLength(2);
      expect(records[0].inputHash).not.toBe(records[1].inputHash);
      for (let index = 0; index < 2; index++) {
        const record = records[index],
          body = JSON.parse(fixture.requests[index].body);
        expect(record).toMatchObject({
          deploymentId: tuple.deploymentId,
          deploymentConfigVersion: 2,
          providerId: tuple.providerId,
          providerConfigVersion: 3,
          planningPolicyVersionId: "planning-policy-v1",
          status: "SUCCEEDED",
          inputTokens: 10,
          outputTokens: 10,
          rawOutput: null,
        });
        expect(body.max_tokens).toBe(128);
        expect(body.messages[1].content).toBe(requests[index].userMessage);
        expect(JSON.parse(body.messages[2].content)).toMatchObject({
          publicTextBlocks: promptInput[key].publicTextBlocks,
        });
        const expected = {
          system: body.messages[0].content,
          userMessage: body.messages[1].content,
          userData: body.messages[2].content,
          maxOutputTokens: body.max_tokens,
          temperature: body.temperature,
          responseFormat: "json",
        };
        expect(record.inputHash).toBe(
          canonicalHash({
            request: expected,
            planningPolicyVersionId: record.planningPolicyVersionId,
            activationRevision: record.activationRevision,
          }),
        );
        expect(record.outputHash).toMatch(/^[a-f0-9]{64}$/);
        expect(record.durationMs).toBeGreaterThanOrEqual(0);
      }
      expect(JSON.stringify(records).includes("synthetic message")).toBe(false);
    } finally {
      await fixture.close();
    }
  });
  it("[version-evidence] failed evidence persistence cannot return a successful AI result", async () => {
    const owner = phase015OwnerClient();
    try {
      await owner.$executeRawUnsafe(
        `CREATE FUNCTION public.phase015_fail_output() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic evidence failure'; END; $$`,
      );
      await owner.$executeRawUnsafe(
        `CREATE TRIGGER phase015_fail_output BEFORE INSERT ON "AiOutputRecord" FOR EACH ROW EXECUTE FUNCTION public.phase015_fail_output()`,
      );
      const request = input();
      expect(await callGuardedAi(request, options())).toMatchObject({
        ok: false,
        errorCode: "PROVIDER_UNAVAILABLE",
      });
      expect(await db!.aiOutputRecord.count({ where: { traceId: request.traceId } })).toBe(0);
      expect(
        (await db!.aiUsageReservation.findFirstOrThrow({ where: { traceId: request.traceId } }))
          .status,
      ).toBe("RECONCILING");
    } finally {
      await owner.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS phase015_fail_output ON "AiOutputRecord"',
      );
      await owner.$executeRawUnsafe("DROP FUNCTION IF EXISTS public.phase015_fail_output()");
      await owner.$disconnect();
    }
  });
  it("[resolution] owner, synthetic policy and privacy violations fail before any reservation", async () => {
    for (const owner of [
      undefined,
      { kind: "SYNTHETIC" as const, runId: "phase015_disposable_000000000000" },
      { kind: "USER" as const, userId: "missing", privateInputAllowed: true },
    ]) {
      const request = input();
      expect(await callGuardedAi(request, { db: db!, owner })).toMatchObject({
        ok: false,
        errorCode: "CONFIG_ERROR",
      });
      expect(await db!.aiUsageReservation.count({ where: { traceId: request.traceId } })).toBe(0);
    }
    const privateRequest = input(undefined, `authorization: Bearer ${"x".repeat(32)}`);
    expect(await callGuardedAi(privateRequest, options())).toMatchObject({
      ok: false,
      errorCode: "CONFIG_ERROR",
    });
    expect(await db!.aiUsageReservation.count({ where: { traceId: privateRequest.traceId } })).toBe(
      0,
    );
  });
});
