import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";
import { parsePromptVariables, parsePromptResponse, PROMPT_KEY_CONTRACTS } from "@/lib/ai/schemas";
import { authCookieSettings, encodeAuthCookie } from "@/server/auth/cookie";
import { createSessionService } from "@/server/auth/session-service";
import { createAdminSettingsService } from "@/server/admin/settings";
import { activatePromptModelTuple } from "@/server/services/prompt-service";
import { callGuardedAi } from "@/server/ai/guarded-client";
import { MockAiProvider } from "@/server/ai/mock-provider";
import probes from "@/server/ai/bootstrap-probes.json";

export interface EnableMockAiOptions {
  actorId: string;
  runId: string;
  databaseUrl: string;
  probe?: (key: string) => Promise<boolean>;
}
export async function enableMockAi(
  client: PrismaClient,
  options: EnableMockAiOptions,
): Promise<{ activated: number; enabled: boolean }> {
  const url = new URL(options.databaseUrl);
  const [database] = await client.$queryRaw<
    Array<{ name: string; marker: string | null }>
  >`SELECT current_database() AS name,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()`;
  if (
    env.AI_MOCK !== true ||
    !/^phase\d{3}_disposable_[a-f0-9]{12}$/.test(options.runId) ||
    database.name !== options.runId ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== `/${options.runId}` ||
    database.marker !==
      `serendipity-phase${options.runId.slice(5, 8)}-disposable:${options.runId.slice(-12)}`
  )
    throw new Error("CONFIG_ERROR");
  const actor = await client.user.findUnique({ where: { id: options.actorId } });
  if (
    !actor ||
    actor.role !== "ADMIN" ||
    actor.status !== "ACTIVE" ||
    actor.email !== "phase015-admin@serendipity.invalid"
  )
    throw new Error("CONFIG_ERROR");
  for (const contract of PROMPT_KEY_CONTRACTS) {
    const probe = probes[contract.key];
    parsePromptVariables(contract.key, probe.input);
    const result = await new MockAiProvider({ output: JSON.stringify(probe.output) }).complete(
      {
        system: "Synthetic fixture contract probe",
        userMessage: JSON.stringify(probe.input),
        maxOutputTokens: 2048,
        responseFormat: "json",
      },
      { signal: new AbortController().signal, deadlineAt: Date.now() + 1000 },
    );
    if (!result.ok) throw new Error("CONFIG_ERROR");
    parsePromptResponse(contract.key, result.output);
    if (options.probe && (process.env.NODE_ENV !== "test" || !(await options.probe(contract.key))))
      throw new Error("CONFIG_ERROR");
  }
  const provider = await client.providerConfigVersion.findUnique({
    where: { providerId_configVersion: { providerId: "mock-provider", configVersion: 1 } },
  });
  if (provider?.mode !== "MOCK" || provider.secretRef !== null) throw new Error("CONFIG_ERROR");
  const opaqueToken = randomBytes(32).toString("base64url"),
    csrf = randomBytes(32).toString("hex");
  const [{ now }] = await client.$queryRaw<Array<{ now: Date }>>`SELECT public.auth_now() AS now`;
  const expiresAt = new Date(now.getTime() + 43200000);
  await client.authSession.create({
    data: {
      userId: actor.id,
      tokenHash: createHash("sha256").update(opaqueToken).digest("hex"),
      audience: "ADMIN",
      sessionVersion: actor.sessionVersion,
      issuedAt: now,
      createdAt: now,
      expiresAt,
    },
  });
  const cookies = authCookieSettings();
  const encrypted = await encodeAuthCookie({
    token: { opaqueToken, absoluteExpiresAt: expiresAt.getTime() },
    secret: env.AUTH_SECRET,
    salt: cookies.sessionToken.name,
  });
  const settings = createAdminSettingsService({ databaseUrl: options.databaseUrl });
  const sessions = createSessionService({ databaseUrl: options.databaseUrl });
  const patch = async (value: boolean) => {
    const row = await client.systemConfig.findUniqueOrThrow({ where: { key: "ai.calls.enabled" } });
    if (row.valueJson === value) return;
    const request = new Request(new URL("/api/admin/settings/ai.calls.enabled", env.AUTH_URL), {
      method: "PATCH",
      headers: {
        origin: env.AUTH_URL,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "x-csrf-token": csrf,
        cookie: `${cookies.sessionToken.name}=${encrypted}; ${cookies.csrfToken.name}=${csrf}%7C${createHash("sha256").update(`${csrf}${env.AUTH_SECRET}`).digest("hex")}`,
      },
      body: JSON.stringify({ expectedVersion: row.revision, valueJson: value }),
    });
    await settings.update(request, "ai.calls.enabled");
  };
  let enabled = false;
  try {
    await client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${actor.id} FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: actor.id } });
      if (
        current?.role !== "ADMIN" ||
        current.status !== "ACTIVE" ||
        current.sessionVersion !== actor.sessionVersion
      )
        throw new Error("CONFIG_ERROR");
      for (const contract of PROMPT_KEY_CONTRACTS) {
        const definitionId = `prompt-${contract.key.replaceAll(".", "-")}`;
        await activatePromptModelTuple(tx, {
          definitionId,
          promptVersionId: `${definitionId}-v1`,
          deploymentId: "mock-model",
          deploymentConfigVersion: 1,
          providerId: "mock-provider",
          providerConfigVersion: 1,
          updatedById: actor.id,
        });
      }
    });
    await patch(true);
    enabled = true;
    for (const contract of PROMPT_KEY_CONTRACTS) {
      const result = await callGuardedAi(
        {
          promptKey: contract.key,
          variables: probes[contract.key].input,
          userMessage: JSON.stringify(probes[contract.key].input),
          traceId: `enable-mock-${randomUUID()}`,
        },
        { db: client, owner: { kind: "SYNTHETIC", runId: options.runId } },
      );
      if (!result.ok) throw new Error("CONFIG_ERROR");
    }
    return { activated: 8, enabled: true };
  } catch (error) {
    if (enabled) await patch(false);
    await client.$transaction(async (tx) => {
      for (const contract of PROMPT_KEY_CONTRACTS) {
        const definitionId = `prompt-${contract.key.replaceAll(".", "-")}`;
        await activatePromptModelTuple(tx, {
          definitionId,
          promptVersionId: `${definitionId}-v1`,
          deploymentId: "mock-model",
          deploymentConfigVersion: 1,
          providerId: "mock-provider",
          providerConfigVersion: 1,
          status: "DISABLED",
          updatedById: actor.id,
        });
      }
    });
    throw error;
  } finally {
    await sessions.revokeSession(opaqueToken);
    await Promise.all([settings.disconnect(), sessions.disconnect()]);
  }
}
