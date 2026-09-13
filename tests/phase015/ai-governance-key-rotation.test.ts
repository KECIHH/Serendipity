// @vitest-environment node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createAdminApiKeysService } from "@/server/admin/api-keys";
import { createProviderKeyCandidateClient } from "@/server/ai/key-candidate-client";
import { ProviderConfigKeyReferenceAdapter } from "@/server/ai/provider-key-reference-adapter";
import { callGuardedAi } from "@/server/ai/guarded-client";
import { activatePromptModelTuple } from "@/server/services/prompt-service";
import probes from "@/server/ai/bootstrap-probes.json";
import {
  makeApiKeyRequest,
  registerCanary,
  type FixtureSession,
} from "../phase013/api-key-fixture";
import {
  phase015Client,
  phase015Config,
  resetGovernance,
  ensurePhase015Enabled,
  createDeployment,
  activateFixture,
  syntheticOwner,
  promptInput,
  setAiEnabled,
} from "./fixture";
import { startHttpFixture, sendCompletion } from "./http-fixture";

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
function secret() {
  const value = `phase015_rotation_${randomBytes(24).toString("hex")}`;
  registerCanary({ plainKey: value });
  return value;
}
async function issueSession(): Promise<FixtureSession> {
  const user = await db!.user.findUniqueOrThrow({
    where: { email: "phase015-admin@serendipity.invalid" },
  });
  const [{ now }] = await db!.$queryRaw<Array<{ now: Date }>>`SELECT public.auth_now() AS now`;
  const opaqueToken = randomBytes(32).toString("base64url"),
    expiresAt = new Date(now.getTime() + 43200000);
  registerCanary({ opaqueToken });
  await db!.authSession.create({
    data: {
      userId: user.id,
      tokenHash: createHash("sha256").update(opaqueToken).digest("hex"),
      audience: "ADMIN",
      sessionVersion: user.sessionVersion,
      issuedAt: now,
      createdAt: now,
      expiresAt,
    },
  });
  return { userId: user.id, opaqueToken, audience: "ADMIN", expiresAt: expiresAt.toISOString() };
}
async function setup(overrides: Parameters<typeof createDeployment>[1] = {}) {
  const session = await issueSession(),
    accepted = secret();
  let failedSecond = false,
    count = 0,
    hold: Promise<void> | undefined;
  const http = await startHttpFixture(async (row, response) => {
    count++;
    if (count === 1 && hold) await hold;
    if (row.headers.authorization !== `Bearer ${accepted}` || (failedSecond && count >= 2)) {
      response.writeHead(503);
      response.end();
      return;
    }
    const body = JSON.parse(row.body);
    let result: unknown = probes["nlu.extract"].output;
    try {
      result = JSON.parse(body.messages[1].content);
    } catch {}
    sendCompletion(response, result);
  });
  const service = createAdminApiKeysService({
    databaseUrl: phase015Config().appUrl,
    candidateClient: createProviderKeyCandidateClient(db!, http),
  });
  const previous = await service.create(
    await makeApiKeyRequest({
      method: "POST",
      session,
      idempotencyKey: randomUUID(),
      body: { name: "synthetic provider rotation", provider: "deepseek", plainKey: secret() },
    }),
  );
  const first = await createDeployment(db!, {
    mode: "LIVE",
    secretRef: previous.key.id,
    maxOutputTokens: 64,
    ...overrides,
  });
  const second = await createDeployment(db!, { mode: "LIVE", secretRef: previous.key.id });
  await activateFixture(db!, "nlu.extract", first);
  await activateFixture(db!, "planner.score", second);
  const disabled = await createDeployment(db!, { mode: "LIVE", secretRef: previous.key.id });
  await db!.$transaction((tx) =>
    activatePromptModelTuple(tx, {
      definitionId: "prompt-export-markdown",
      promptVersionId: "prompt-export-markdown-v1",
      ...disabled,
      status: "DISABLED",
    }),
  );
  const initial = await db!.promptModelActivation.findMany({
    where: { definitionId: { in: ["prompt-nlu-extract", "prompt-planner-score"] } },
    orderBy: { definitionId: "asc" },
  });
  const request = {
    method: "POST" as const,
    session,
    idempotencyKey: randomUUID(),
    body: {
      name: "synthetic replacement",
      provider: "deepseek",
      plainKey: accepted,
      expectedVersion: previous.key.revision,
    },
  };
  return {
    session,
    service,
    http,
    first,
    second,
    initial,
    previous,
    request,
    accepted,
    rotate: async () => service.rotate(await makeApiKeyRequest(request), previous.key.id),
    failSecond() {
      failedSecond = true;
    },
    holdFirst() {
      let release!: () => void;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    async close() {
      await service.disconnect();
      await http.close();
    },
  };
}

describe.skipIf(!enabled)("Phase015 real Provider key rotation", () => {
  it("[kill-switch] rotates two real provider/model references atomically and preserves disabled references", async () => {
    const test = await setup();
    try {
      const references = await new ProviderConfigKeyReferenceAdapter().listActiveReferences(
        db!,
        test.previous.key.id,
      );
      expect(references).toHaveLength(2);
      const result = await test.rotate();
      expect(result.stage).toBe("ACTIVATED");
      expect(result.affectedConfigCount).toBe(2);
      expect(result.key.status).toBe("ACTIVE");
      expect(
        (await db!.apiKeyConfig.findUniqueOrThrow({ where: { id: test.previous.key.id } })).status,
      ).toBe("REVOKED");
      const active = await db!.promptModelActivation.findMany({
        where: { definitionId: { in: references.map((r) => r.referenceId) } },
        include: { deployment: true, provider: true },
        orderBy: { definitionId: "asc" },
      });
      for (let i = 0; i < 2; i++) {
        expect(active[i].provider.secretRef).toBe(result.key.id);
        expect(active[i].revision).toBe(test.initial[i].revision + 1);
        expect(active[i].providerConfigVersion).toBe(2);
        expect(active[i].deploymentConfigVersion).toBe(2);
        expect(active[i].deployment.providerConfigVersion).toBe(active[i].providerConfigVersion);
        expect(active[i].providerId).toBe(test.initial[i].providerId);
      }
      expect(
        (
          await db!.promptModelActivation.findUniqueOrThrow({
            where: { definitionId: "prompt-export-markdown" },
            include: { provider: true },
          })
        ).provider.secretRef,
      ).toBe(test.previous.key.id);
      expect(
        (
          await db!.promptModelActivation.findUniqueOrThrow({
            where: { definitionId: "prompt-export-markdown" },
          })
        ).status,
      ).toBe("DISABLED");
      expect(test.http.requests).toHaveLength(2);
      expect(JSON.parse(test.http.requests[0].body).max_tokens).toBe(64);
      const evidence = await db!.aiOutputRecord.findMany({
        where: { traceId: { startsWith: "key-candidate:" } },
      });
      expect(evidence).toHaveLength(2);
      expect(
        evidence.every(
          (row) =>
            row.status === "SUCCEEDED" &&
            row.deploymentConfigVersion === 2 &&
            row.providerConfigVersion === 2 &&
            row.rawOutput === null,
        ),
      ).toBe(true);
      const reservations = await db!.aiUsageReservation.findMany({
        where: { traceId: { in: evidence.map((row) => row.traceId) } },
      });
      expect(reservations).toHaveLength(2);
      expect(reservations.every((row) => row.status === "SETTLED")).toBe(true);
      expect(
        test.http.requests.every((r) => r.headers.authorization === `Bearer ${test.accepted}`),
      ).toBe(true);
      expect((await test.rotate()).replayed).toBe(true);
      expect(test.http.requests).toHaveLength(2);
      const run = await db!.keyRotationRun.findFirstOrThrow({
        where: { oldKeyId: test.previous.key.id },
      });
      expect(run.stage).toBe("ACTIVATED");
      expect(
        await db!.auditLog.count({
          where: { targetId: test.previous.key.id, action: "API_KEY_ROTATE" },
        }),
      ).toBe(1);
      expect(
        await callGuardedAi(
          {
            promptKey: "nlu.extract",
            variables: promptInput["nlu.extract"],
            userMessage: "after real rotation",
            traceId: randomUUID(),
          },
          { db: db!, owner: syntheticOwner(), ...test.http, liveEgressAllowed: true },
        ),
      ).toMatchObject({ ok: true });
    } finally {
      await test.close();
    }
  });
  it("[kill-switch] one failed real candidate leaves every active tuple and the old key unchanged", async () => {
    const test = await setup();
    test.failSecond();
    try {
      const result = await test.rotate();
      expect(result.stage).toBe("TESTING");
      expect(result.key.status).toBe("DISABLED");
      expect(result.errorCode).toBe("PROVIDER_UNAVAILABLE");
      expect(
        await db!.promptModelActivation.findMany({
          where: { definitionId: { in: test.initial.map((r) => r.definitionId) } },
          orderBy: { definitionId: "asc" },
        }),
      ).toEqual(test.initial);
      expect(
        (await db!.apiKeyConfig.findUniqueOrThrow({ where: { id: test.previous.key.id } })).status,
      ).toBe("ACTIVE");
      await expect(
        test.service.update(
          await makeApiKeyRequest({
            method: "PATCH",
            session: test.session,
            idempotencyKey: randomUUID(),
            body: { expectedVersion: 0, status: "ACTIVE" },
          }),
          result.key.id,
        ),
      ).rejects.toMatchObject({ publicCode: "VERSION_CONFLICT" });
      expect(test.http.requests).toHaveLength(3);
    } finally {
      await test.close();
    }
  });
  it("[kill-switch] candidate probes cannot bypass a closed global switch", async () => {
    const test = await setup();
    try {
      await setAiEnabled(db!, false);
      const before = await db!.aiUsageReservation.count();
      const result = await test.rotate();
      expect(result.stage).toBe("TESTING");
      expect(result.errorCode).toBe("CONFIG_ERROR");
      expect(test.http.requests).toHaveLength(0);
      expect(await db!.aiUsageReservation.count()).toBe(before);
    } finally {
      await test.close();
    }
  });
  it("[quota-cost] candidate probes enforce frozen token and Decimal cost budgets before transport", async () => {
    for (const kind of ["tokens", "cost"]) {
      const test = await setup(
        kind === "cost"
          ? {
              cost: "0.000001",
              pricing: {
                inputPerToken: "0.001",
                outputPerToken: "0.001",
                fixedPerRequest: "0",
                basis: "UTF8_BYTE_UPPER_BOUND_V1",
              },
            }
          : {},
      );
      try {
        if (kind === "tokens")
          await db!.aiUsageReservation.create({
            data: {
              bucketKey: `daily:${test.first.providerId}:${new Date().toISOString().slice(0, 10)}`,
              traceId: randomUUID(),
              attemptNo: 1,
              estimatedTokens: 100000,
              estimatedCost: "0",
              expiresAt: new Date(Date.now() + 60000),
            },
          });
        const result = await test.rotate();
        expect(result.stage).toBe("TESTING");
        expect(result.errorCode).toBe("CONFIG_ERROR");
        expect(test.http.requests).toHaveLength(0);
      } finally {
        await test.close();
      }
    }
  });
  it("[resolution] a competing activation invalidates the captured reference revisions without partial switch", async () => {
    const test = await setup(),
      release = test.holdFirst();
    try {
      const pending = test.rotate();
      await test.http.waitForRequests(1);
      await activateFixture(db!, "nlu.extract", test.first);
      release();
      await expect(pending).rejects.toMatchObject({ status: 409, publicCode: "VERSION_CONFLICT" });
      const run = await db!.keyRotationRun.findFirstOrThrow({
        where: { oldKeyId: test.previous.key.id },
      });
      expect(run.stage).toBe("ABORTED");
      expect(
        (await db!.apiKeyConfig.findUniqueOrThrow({ where: { id: run.newKeyId! } })).status,
      ).toBe("DISABLED");
      const refs = await new ProviderConfigKeyReferenceAdapter().listActiveReferences(
        db!,
        test.previous.key.id,
      );
      expect(refs).toHaveLength(2);
      expect(
        (await db!.apiKeyConfig.findUniqueOrThrow({ where: { id: test.previous.key.id } })).status,
      ).toBe("ACTIVE");
      expect(
        (
          await db!.promptModelActivation.findUniqueOrThrow({
            where: { definitionId: "prompt-planner-score" },
          })
        ).deploymentConfigVersion,
      ).toBe(1);
    } finally {
      release();
      await test.close();
    }
  });
  it("[kill-switch] emergency revoke during the candidate request prevents subsequent calls and activation", async () => {
    const test = await setup(),
      release = test.holdFirst();
    try {
      const pending = test.rotate();
      await test.http.waitForRequests(1);
      await test.service.update(
        await makeApiKeyRequest({
          method: "PATCH",
          session: test.session,
          idempotencyKey: randomUUID(),
          body: { expectedVersion: test.previous.key.revision, status: "REVOKED" },
        }),
        test.previous.key.id,
      );
      release();
      const result = await pending;
      expect(result.stage).not.toBe("ACTIVATED");
      expect(result.key.status).toBe("DISABLED");
      expect(test.http.requests).toHaveLength(1);
      const request = {
        promptKey: "nlu.extract",
        variables: promptInput["nlu.extract"],
        userMessage: "revoked real provider",
        traceId: randomUUID(),
      };
      expect(
        await callGuardedAi(request, {
          db: db!,
          owner: syntheticOwner(),
          ...test.http,
          liveEgressAllowed: true,
        }),
      ).toMatchObject({ ok: false, errorCode: "CONFIG_ERROR" });
      expect(await db!.aiUsageReservation.count({ where: { traceId: request.traceId } })).toBe(0);
      expect(test.http.requests).toHaveLength(1);
    } finally {
      release();
      await test.close();
    }
  });
});
