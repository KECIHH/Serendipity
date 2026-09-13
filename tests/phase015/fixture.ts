import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import probes from "@/server/ai/bootstrap-probes.json";
import { randomBytes } from "node:crypto";
import { canonicalHash, PROMPT_KEY_CONTRACTS } from "@/lib/ai/schemas";
import { activatePromptModelTuple } from "@/server/services/prompt-service";
import { PrismaClient } from "@prisma/client";
import { bootstrapAiGovernance, enableMockAi } from "@/server/services/ai-governance-service";

export interface Phase015FixtureConfig {
  readonly database: string;
  readonly url: string;
  readonly encryptionKey: string;
  readonly appUrl: string;
}

export function phase015Config(): Phase015FixtureConfig {
  const file = process.env.PHASE015_FIXTURE_CONFIG;
  assert(file, "Phase015 requires PHASE015_FIXTURE_CONFIG");
  const config = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as Phase015FixtureConfig;
  assert.match(config.database, /^phase015_disposable_[a-f0-9]{12}$/);
  const url = new URL(config.url);
  assert.equal(url.protocol, "postgresql:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, `/${config.database}`);
  const appUrl = new URL(config.appUrl);
  assert.equal(appUrl.hostname, "127.0.0.1");
  assert.equal(appUrl.pathname, `/${config.database}`);
  assert.equal(Buffer.from(config.encryptionKey, "base64").byteLength, 32);
  return config;
}

export function phase015Client(): PrismaClient {
  return new PrismaClient({ datasourceUrl: phase015Config().appUrl, log: [] });
}

export function phase015OwnerClient(): PrismaClient {
  return new PrismaClient({ datasourceUrl: phase015Config().url, log: [] });
}

/** Only the exact marked task database is reset; application assertions use its restricted role. */
export async function resetGovernance(client: PrismaClient, bootstrap = true): Promise<void> {
  const config = phase015Config();
  const owner = phase015OwnerClient();
  try {
    const [row] = await owner.$queryRaw<Array<{ name: string; marker: string | null }>>`
      SELECT current_database() AS name,shobj_description(oid,'pg_database') AS marker
      FROM pg_database WHERE datname=current_database()`;
    assert.equal(row.name, config.database);
    assert.equal(row.marker, `serendipity-phase015-disposable:${config.database.slice(-12)}`);
    await owner.$executeRawUnsafe(
      'TRUNCATE "AiOutputRecord","AiUsageReservation","PromptActivation","PromptModelActivation","PromptVersion","PromptDefinition","ModelDeployment","ProviderConfigVersion","PlanningPolicyActivation","PlanningPolicyVersion" CASCADE',
    );
    await owner.systemConfig.deleteMany({ where: { key: "ai.calls.enabled" } });
  } finally {
    await owner.$disconnect();
  }
  if (bootstrap) await client.$transaction((tx) => bootstrapAiGovernance(tx), { timeout: 15000 });
}

export async function setAiEnabled(client: PrismaClient, enabled: boolean): Promise<void> {
  const row = await client.systemConfig.findUniqueOrThrow({ where: { key: "ai.calls.enabled" } });
  await client.systemConfig.update({
    where: { id: row.id, revision: row.revision },
    data: { valueJson: enabled, revision: row.revision + 1, updatedAt: new Date() },
  });
}

export async function ensurePhase015Enabled(client: PrismaClient): Promise<void> {
  await client.$transaction((tx) => bootstrapAiGovernance(tx));
  const config = await client.systemConfig.findUniqueOrThrow({
    where: { key: "ai.calls.enabled" },
  });
  if (config.valueJson === true) return;
  let actor = await client.user.findUnique({
    where: { email: "phase015-admin@serendipity.invalid" },
  });
  if (!actor) {
    actor = await client.user.create({
      data: {
        email: "phase015-admin@serendipity.invalid",
        passwordHash: "synthetic",
        role: "ADMIN",
      },
    });
  }
  await enableMockAi(client, {
    actorId: actor.id,
    runId: phase015Config().database,
    databaseUrl: phase015Config().appUrl,
  });
}

export const promptInput = Object.fromEntries(
  Object.entries(probes).map(([key, value]) => [key, value.input]),
) as Record<string, Record<string, unknown>>;
export const syntheticOwner = () => ({
  kind: "SYNTHETIC" as const,
  runId: phase015Config().database,
});

export async function createDeployment(
  client: PrismaClient,
  options: {
    providerId?: string;
    providerVersion?: number;
    deploymentId?: string;
    deploymentVersion?: number;
    mode?: "MOCK" | "LIVE";
    secretRef?: string | null;
    quota?: number;
    cost?: string;
    retries?: number;
    timeout?: number;
    capabilities?: string[];
    locale?: string;
    maxOutputTokens?: number;
    contextWindowTokens?: number;
    pricing?: {
      inputPerToken: string;
      outputPerToken: string;
      fixedPerRequest: string;
      basis: string;
    };
  } = {},
) {
  const suffix = randomBytes(6).toString("hex");
  const providerId = options.providerId ?? `synthetic-provider-${suffix}`,
    configVersion = options.providerVersion ?? 1;
  const provider = {
    mode: options.mode ?? "MOCK",
    baseUrl: options.mode === "LIVE" ? "https://api.deepseek.com/v1" : "https://mock.invalid",
    capabilities: options.capabilities ?? PROMPT_KEY_CONTRACTS.map((x) => x.key),
    timeoutMs: options.timeout ?? 2000,
    maxRetries: options.retries ?? 1,
    quotaTokensPerDay: options.quota ?? 100000,
    costLimitPerDay: options.cost ?? "5",
    region: "global",
    locale: options.locale ?? "zh-CN",
    credentialRequirement: options.secretRef ? ("REQUIRED" as const) : ("NONE" as const),
    secretRef: options.secretRef ?? null,
  };
  await client.providerConfigVersion.create({
    data: { providerId, configVersion, ...provider, contentHash: canonicalHash(provider) },
  });
  const model = {
    id: options.deploymentId ?? `synthetic-model-${suffix}`,
    configVersion: options.deploymentVersion ?? 1,
    providerId,
    providerConfigVersion: configVersion,
    providerModelName: "synthetic-model",
    params: {
      temperature: 0,
      maxOutputTokens: options.maxOutputTokens ?? 2048,
      pricing: options.pricing ?? {
        inputPerToken: "0",
        outputPerToken: "0",
        fixedPerRequest: "0",
        basis: "UTF8_BYTE_UPPER_BOUND_V1",
      },
    },
    capabilities: provider.capabilities,
    contextWindowTokens: options.contextWindowTokens ?? 65536,
  };
  await client.modelDeployment.create({
    data: {
      id: model.id,
      configVersion: model.configVersion,
      providerId,
      providerConfigVersion: configVersion,
      providerModelName: model.providerModelName,
      paramsJson: model.params,
      capabilitiesJson: model.capabilities,
      contextWindowTokens: model.contextWindowTokens,
      contentHash: canonicalHash(model),
    },
  });
  return {
    deploymentId: model.id,
    deploymentConfigVersion: model.configVersion,
    providerId,
    providerConfigVersion: configVersion,
  };
}
export async function activateFixture(
  client: PrismaClient,
  key: string,
  tuple: Awaited<ReturnType<typeof createDeployment>>,
) {
  const definitionId = `prompt-${key.replaceAll(".", "-")}`;
  await client.$transaction((tx) =>
    activatePromptModelTuple(tx, { definitionId, promptVersionId: `${definitionId}-v1`, ...tuple }),
  );
}
