import "server-only";

import type { Prisma } from "@prisma/client";
import { canonicalHash, parsePromptVariables, promptKeyContract } from "@/lib/ai/schemas";
import { resolveModelSnapshot } from "@/server/services/model-resolution-service";
import { parsePlanningPolicy } from "@/server/ai/planning-policy";

export interface PromptModelSnapshot {
  readonly definitionId: string;
  readonly promptKey: string;
  readonly promptVersionId: string;
  readonly promptVersion: number;
  readonly promptContentHash: string;
  readonly system: string;
  readonly activationRevision: number;
  readonly planningPolicyVersionId: string;
  readonly variables: Record<string, unknown>;
  readonly planningPolicy: { scope: string; contentHash: string };
  readonly model: Awaited<ReturnType<typeof resolveModelSnapshot>>;
  readonly provider: {
    readonly providerId: string;
    readonly configVersion: number;
    readonly mode: "MOCK" | "LIVE";
    readonly baseUrl: string;
    readonly timeoutMs: number;
    readonly credentialRequirement: "NONE" | "REQUIRED";
    readonly secretRef: string | null;
    readonly maxRetries: number;
    readonly quotaTokensPerDay: number;
    readonly costLimitPerDay: string;
    readonly region: string;
    readonly locale: string;
  };
}

function requireValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("CONFIG_ERROR");
  return value;
}

export async function resolvePromptSnapshot(
  tx: Prisma.TransactionClient,
  promptKey: string,
  input: Readonly<Record<string, unknown>>,
): Promise<PromptModelSnapshot> {
  const variables = parsePromptVariables(promptKey, input);
  const contract = promptKeyContract(promptKey);
  const identity = requireValue(
    await tx.promptDefinition.findUnique({ where: { key: promptKey }, select: { id: true } }),
  );
  await tx.$queryRaw`SELECT "definitionId" FROM "PromptActivation" WHERE "definitionId"=${identity.id} FOR SHARE`;
  await tx.$queryRaw`SELECT "definitionId" FROM "PromptModelActivation" WHERE "definitionId"=${identity.id} FOR SHARE`;
  const definition = await tx.promptDefinition.findUnique({
    where: { key: promptKey },
    include: {
      activation: { include: { championVersion: true } },
      modelActivation: { include: { promptVersion: true, deployment: true, provider: true } },
    },
  });
  const activation = requireValue(definition?.activation);
  const modelActivation = requireValue(definition?.modelActivation);
  const promptVersion = requireValue(activation.championVersion);
  const modelPromptVersion = requireValue(modelActivation.promptVersion);
  if (
    modelActivation.status !== "ACTIVE" ||
    activation.revision !== modelActivation.revision ||
    activation.championVersionId !== modelActivation.promptVersionId ||
    promptVersion.id !== modelPromptVersion.id
  ) {
    throw new Error("CONFIG_ERROR");
  }
  if (
    promptVersion.definitionId !== definition?.id ||
    promptVersion.version < 1 ||
    promptVersion.responseSchemaVersion !== contract.responseSchemaVersion ||
    canonicalHash(promptVersion.content) !== promptVersion.contentHash
  ) {
    throw new Error("CONFIG_ERROR");
  }
  if (canonicalHash(promptVersion.variablesJson) !== canonicalHash(contract.variables))
    throw new Error("CONFIG_ERROR");
  const model = await resolveModelSnapshot(tx, definition.id);
  if (!model.capabilities.includes(promptKey) || model.contextWindowTokens <= 0) {
    throw new Error("CONFIG_ERROR");
  }
  const policy = await tx.planningPolicyActivation.findUnique({
    where: { policyKey: "default" },
    include: { activeVersion: true },
  });
  const provider = modelActivation.provider;
  if (
    model.providerId !== provider.providerId ||
    model.providerConfigVersion !== provider.configVersion ||
    model.deploymentConfigVersion !== modelActivation.deploymentConfigVersion ||
    !Array.isArray(provider.capabilities) ||
    !provider.capabilities.includes(promptKey) ||
    (variables.locale !== provider.locale && provider.locale !== "*")
  )
    throw new Error("CONFIG_ERROR");
  if (
    canonicalHash({
      mode: provider.mode,
      baseUrl: provider.baseUrl,
      capabilities: provider.capabilities,
      timeoutMs: provider.timeoutMs,
      maxRetries: provider.maxRetries,
      quotaTokensPerDay: provider.quotaTokensPerDay,
      costLimitPerDay: provider.costLimitPerDay.toString(),
      region: provider.region,
      locale: provider.locale,
      credentialRequirement: provider.credentialRequirement,
      secretRef: provider.secretRef,
    }) !== provider.contentHash
  ) {
    throw new Error("CONFIG_ERROR");
  }
  if (!policy?.activeVersion) throw new Error("CONFIG_ERROR");
  const policyContent = parsePlanningPolicy(policy.activeVersion.contentJson);
  if (
    !policy?.activeVersion ||
    canonicalHash(policy.activeVersion.contentJson) !== policy.activeVersion.contentHash
  ) {
    throw new Error("CONFIG_ERROR");
  }
  return {
    definitionId: definition.id,
    promptKey,
    promptVersionId: promptVersion.id,
    promptVersion: promptVersion.version,
    promptContentHash: promptVersion.contentHash,
    system: promptVersion.content,
    activationRevision: activation.revision,
    planningPolicyVersionId: policy.activeVersion.id,
    planningPolicy: {
      scope: String(policyContent.scope),
      contentHash: policy.activeVersion.contentHash,
    },
    variables,
    model,
    provider: {
      providerId: modelActivation.providerId,
      configVersion: modelActivation.providerConfigVersion,
      mode: modelActivation.provider.mode,
      baseUrl: modelActivation.provider.baseUrl,
      timeoutMs: modelActivation.provider.timeoutMs,
      credentialRequirement: modelActivation.provider.credentialRequirement,
      secretRef: modelActivation.provider.secretRef,
      maxRetries: provider.maxRetries,
      quotaTokensPerDay: provider.quotaTokensPerDay,
      costLimitPerDay: provider.costLimitPerDay.toString(),
      region: provider.region,
      locale: provider.locale,
    },
  };
}

export interface ActivatePromptModelInput {
  readonly definitionId: string;
  readonly promptVersionId: string;
  readonly deploymentId: string;
  readonly deploymentConfigVersion: number;
  readonly providerId: string;
  readonly providerConfigVersion: number;
  readonly updatedById?: string;
  readonly expectedRevision?: number;
  readonly status?: "ACTIVE" | "DISABLED";
}

export async function activatePromptModelTuple(
  tx: Prisma.TransactionClient,
  input: ActivatePromptModelInput,
): Promise<void> {
  const [promptLock] = await tx.$queryRaw<{ revision: number }[]>`
    SELECT revision FROM "PromptActivation" WHERE "definitionId" = ${input.definitionId} FOR UPDATE
  `;
  const [modelLock] = await tx.$queryRaw<{ revision: number }[]>`
    SELECT revision FROM "PromptModelActivation" WHERE "definitionId" = ${input.definitionId} FOR UPDATE
  `;
  if (
    !promptLock ||
    !modelLock ||
    promptLock.revision !== modelLock.revision ||
    (input.expectedRevision !== undefined && input.expectedRevision !== promptLock.revision)
  ) {
    throw new Error("CONFIG_ERROR");
  }
  const version = await tx.promptVersion.findUnique({
    where: { id: input.promptVersionId },
  });
  if (!version || version.definitionId !== input.definitionId) throw new Error("CONFIG_ERROR");
  const deployment = await tx.modelDeployment.findUnique({
    where: {
      id_configVersion: {
        id: input.deploymentId,
        configVersion: input.deploymentConfigVersion,
      },
    },
  });
  const definition = await tx.promptDefinition.findUnique({ where: { id: input.definitionId } });
  if (!definition) throw new Error("CONFIG_ERROR");
  if (
    !deployment ||
    deployment.providerId !== input.providerId ||
    deployment.providerConfigVersion !== input.providerConfigVersion
  ) {
    throw new Error("CONFIG_ERROR");
  }
  const capabilities = deployment.capabilitiesJson;
  if (!Array.isArray(capabilities) || !capabilities.includes(definition.key)) {
    throw new Error("CONFIG_ERROR");
  }
  const revision = promptLock.revision + 1;
  await tx.promptActivation.update({
    where: { definitionId: input.definitionId, revision: promptLock.revision },
    data: {
      championVersionId: input.promptVersionId,
      revision,
      updatedById: input.updatedById ?? null,
      updatedAt: new Date(),
    },
  });
  await tx.promptModelActivation.update({
    where: { definitionId: input.definitionId, revision: modelLock.revision },
    data: {
      promptVersionId: input.promptVersionId,
      deploymentId: input.deploymentId,
      deploymentConfigVersion: input.deploymentConfigVersion,
      providerId: input.providerId,
      providerConfigVersion: input.providerConfigVersion,
      status: input.status ?? "ACTIVE",
      revision,
      updatedById: input.updatedById ?? null,
      updatedAt: new Date(),
    },
  });
}
