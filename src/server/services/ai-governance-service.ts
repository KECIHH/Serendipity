import "server-only";

import type { Prisma } from "@prisma/client";
import { PROMPT_KEY_CONTRACTS, canonicalHash } from "@/lib/ai/schemas";
import bootstrapTemplates from "@/server/ai/bootstrap-templates.json";
import bootstrapPolicy from "@/server/ai/planning-policy-bootstrap.json";
import { parsePlanningPolicy } from "@/server/ai/planning-policy";

export const MOCK_PROVIDER_ID = "mock-provider";
export const MOCK_DEPLOYMENT_ID = "mock-model";
export const PLANNING_POLICY_VERSION_ID = "planning-policy-v1";

export const PLANNING_POLICY_CONTENT = bootstrapPolicy;

const promptId = (key: string) => `prompt-${key.replaceAll(".", "-")}`;
const promptVersionId = (key: string) => `${promptId(key)}-v1`;

function promptContent(key: string): string {
  const content = bootstrapTemplates[key as keyof typeof bootstrapTemplates];
  if (!content) throw new Error("CONFIG_ERROR");
  return content;
}

function providerContentHash(input: {
  mode: string;
  baseUrl: string;
  capabilities: string[];
  timeoutMs: number;
  maxRetries: number;
  quotaTokensPerDay: number;
  costLimitPerDay: string;
  region: string;
  locale: string;
  credentialRequirement: string;
  secretRef: string | null;
}): string {
  return canonicalHash(input);
}

function modelContentHash(input: {
  id: string;
  configVersion: number;
  providerId: string;
  providerConfigVersion: number;
  providerModelName: string;
  params: Record<string, unknown>;
  capabilities: string[];
  contextWindowTokens: number;
}): string {
  return canonicalHash(input);
}

export interface AiGovernanceBootstrapResult {
  readonly promptDefinitionsCreated: number;
  readonly promptVersionsCreated: number;
  readonly promptActivationsCreated: number;
  readonly promptModelActivationsCreated: number;
  readonly providerConfigsCreated: number;
  readonly modelDeploymentsCreated: number;
  readonly planningPolicyVersionsCreated: number;
  readonly planningPolicyActivationsCreated: number;
  readonly systemConfigsCreated: number;
  readonly aiCallsEnabled: boolean;
}

type MutableBootstrapResult = {
  -readonly [key in keyof AiGovernanceBootstrapResult]: AiGovernanceBootstrapResult[key];
};

export async function bootstrapAiGovernance(
  client: Prisma.TransactionClient,
): Promise<AiGovernanceBootstrapResult> {
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('serendipity:ai-bootstrap:v1',0::bigint))`;
  let result: MutableBootstrapResult = {
    promptDefinitionsCreated: 0,
    promptVersionsCreated: 0,
    promptActivationsCreated: 0,
    promptModelActivationsCreated: 0,
    providerConfigsCreated: 0,
    modelDeploymentsCreated: 0,
    planningPolicyVersionsCreated: 0,
    planningPolicyActivationsCreated: 0,
    systemConfigsCreated: 0,
    aiCallsEnabled: false,
  };
  const providerConfig = {
    mode: "MOCK",
    baseUrl: "https://mock.invalid",
    capabilities: PROMPT_KEY_CONTRACTS.map((item) => item.key),
    timeoutMs: 60000,
    maxRetries: 1,
    quotaTokensPerDay: 100000,
    costLimitPerDay: "5",
    region: "global",
    locale: "zh-CN",
    credentialRequirement: "NONE",
    secretRef: null,
  };
  const existingProvider = await client.providerConfigVersion.findUnique({
    where: { providerId_configVersion: { providerId: MOCK_PROVIDER_ID, configVersion: 1 } },
  });
  if (
    existingProvider &&
    (existingProvider.contentHash !== providerContentHash(providerConfig) ||
      canonicalHash({
        mode: existingProvider.mode,
        baseUrl: existingProvider.baseUrl,
        capabilities: existingProvider.capabilities,
        timeoutMs: existingProvider.timeoutMs,
        maxRetries: existingProvider.maxRetries,
        quotaTokensPerDay: existingProvider.quotaTokensPerDay,
        costLimitPerDay: existingProvider.costLimitPerDay.toString(),
        region: existingProvider.region,
        locale: existingProvider.locale,
        credentialRequirement: existingProvider.credentialRequirement,
        secretRef: existingProvider.secretRef,
      }) !== existingProvider.contentHash)
  )
    throw new Error("CONFIG_ERROR");
  if (!existingProvider) {
    await client.providerConfigVersion.create({
      data: {
        providerId: MOCK_PROVIDER_ID,
        configVersion: 1,
        mode: "MOCK",
        baseUrl: providerConfig.baseUrl,
        capabilities: providerConfig.capabilities,
        timeoutMs: providerConfig.timeoutMs,
        maxRetries: providerConfig.maxRetries,
        quotaTokensPerDay: providerConfig.quotaTokensPerDay,
        costLimitPerDay: providerConfig.costLimitPerDay,
        region: providerConfig.region,
        locale: providerConfig.locale,
        credentialRequirement: "NONE",
        secretRef: null,
        contentHash: providerContentHash(providerConfig),
      },
    });
    result.providerConfigsCreated = 1;
  }
  const modelConfig = {
    id: MOCK_DEPLOYMENT_ID,
    configVersion: 1,
    providerId: MOCK_PROVIDER_ID,
    providerConfigVersion: 1,
    providerModelName: "synthetic-mock-v1",
    params: {
      temperature: 0,
      maxOutputTokens: 2048,
      pricing: {
        inputPerToken: "0",
        outputPerToken: "0",
        fixedPerRequest: "0",
        basis: "UTF8_BYTE_UPPER_BOUND_V1",
      },
    },
    capabilities: PROMPT_KEY_CONTRACTS.map((item) => item.key),
    contextWindowTokens: 32768,
  };
  const existingModel = await client.modelDeployment.findUnique({
    where: { id_configVersion: { id: MOCK_DEPLOYMENT_ID, configVersion: 1 } },
  });
  if (
    existingModel &&
    (existingModel.contentHash !== modelContentHash(modelConfig) ||
      canonicalHash({
        id: existingModel.id,
        configVersion: existingModel.configVersion,
        providerId: existingModel.providerId,
        providerConfigVersion: existingModel.providerConfigVersion,
        providerModelName: existingModel.providerModelName,
        params: existingModel.paramsJson,
        capabilities: existingModel.capabilitiesJson,
        contextWindowTokens: existingModel.contextWindowTokens,
      }) !== existingModel.contentHash)
  )
    throw new Error("CONFIG_ERROR");
  if (!existingModel) {
    await client.modelDeployment.create({
      data: {
        id: modelConfig.id,
        configVersion: modelConfig.configVersion,
        providerId: modelConfig.providerId,
        providerConfigVersion: modelConfig.providerConfigVersion,
        providerModelName: modelConfig.providerModelName,
        paramsJson: modelConfig.params,
        capabilitiesJson: modelConfig.capabilities,
        contextWindowTokens: modelConfig.contextWindowTokens,
        contentHash: modelContentHash(modelConfig),
      },
    });
    result.modelDeploymentsCreated = 1;
  }
  for (const contract of PROMPT_KEY_CONTRACTS) {
    const content = promptContent(contract.key);
    const existingDefinition = await client.promptDefinition.findUnique({
      where: { key: contract.key },
    });
    if (
      existingDefinition &&
      (existingDefinition.id !== promptId(contract.key) ||
        existingDefinition.purpose !== contract.purpose)
    )
      throw new Error("CONFIG_ERROR");
    if (!existingDefinition) {
      await client.promptDefinition.create({
        data: { id: promptId(contract.key), key: contract.key, purpose: contract.purpose },
      });
      result.promptDefinitionsCreated += 1;
    }
    const definitionId = promptId(contract.key);
    const existingVersion = await client.promptVersion.findUnique({
      where: { id: promptVersionId(contract.key) },
    });
    if (
      existingVersion &&
      (existingVersion.definitionId !== definitionId ||
        existingVersion.version !== 1 ||
        existingVersion.content !== content ||
        existingVersion.contentHash !== canonicalHash(content) ||
        canonicalHash(existingVersion.variablesJson) !== canonicalHash(contract.variables) ||
        existingVersion.responseSchemaVersion !== contract.responseSchemaVersion)
    )
      throw new Error("CONFIG_ERROR");
    if (!existingVersion) {
      await client.promptVersion.create({
        data: {
          id: promptVersionId(contract.key),
          definitionId,
          version: 1,
          content,
          contentHash: canonicalHash(content),
          variablesJson: contract.variables as unknown as Prisma.InputJsonValue,
          responseSchemaVersion: contract.responseSchemaVersion,
        },
      });
      result.promptVersionsCreated += 1;
    }
    const existingPromptActivation = await client.promptActivation.findUnique({
      where: { definitionId },
    });
    if (!existingPromptActivation) {
      await client.promptActivation.create({
        data: { definitionId, championVersionId: promptVersionId(contract.key), revision: 0 },
      });
      result.promptActivationsCreated += 1;
    }
    const existingModelActivation = await client.promptModelActivation.findUnique({
      where: { definitionId },
    });
    if (!existingModelActivation) {
      await client.promptModelActivation.create({
        data: {
          definitionId,
          promptVersionId: promptVersionId(contract.key),
          deploymentId: MOCK_DEPLOYMENT_ID,
          deploymentConfigVersion: 1,
          providerId: MOCK_PROVIDER_ID,
          providerConfigVersion: 1,
          status: "DISABLED",
          revision: 0,
        },
      });
      result.promptModelActivationsCreated += 1;
    }
  }
  const existingPolicy = await client.planningPolicyVersion.findUnique({
    where: { id: PLANNING_POLICY_VERSION_ID },
  });
  parsePlanningPolicy(PLANNING_POLICY_CONTENT);
  if (
    existingPolicy &&
    (existingPolicy.version !== 1 ||
      canonicalHash(existingPolicy.contentJson) !== canonicalHash(PLANNING_POLICY_CONTENT) ||
      existingPolicy.contentHash !== canonicalHash(PLANNING_POLICY_CONTENT))
  )
    throw new Error("CONFIG_ERROR");
  if (!existingPolicy) {
    await client.planningPolicyVersion.create({
      data: {
        id: PLANNING_POLICY_VERSION_ID,
        version: 1,
        contentJson: PLANNING_POLICY_CONTENT,
        contentHash: canonicalHash(PLANNING_POLICY_CONTENT),
      },
    });
    result.planningPolicyVersionsCreated = 1;
  }
  const existingPolicyActivation = await client.planningPolicyActivation.findUnique({
    where: { policyKey: "default" },
  });
  if (!existingPolicyActivation) {
    await client.planningPolicyActivation.create({
      data: {
        policyKey: "default",
        activeVersionId: PLANNING_POLICY_VERSION_ID,
        revision: 0,
      },
    });
    result.planningPolicyActivationsCreated = 1;
  }
  const existingCallsConfig = await client.systemConfig.findUnique({
    where: { key: "ai.calls.enabled" },
  });
  if (!existingCallsConfig) {
    await client.systemConfig.create({
      data: {
        key: "ai.calls.enabled",
        valueJson: false,
        description: "Global AI call kill switch; false means zero reservations and egress.",
        group: "AI",
        isPublic: false,
      },
    });
    result.systemConfigsCreated = 1;
  } else {
    result = { ...result, aiCallsEnabled: existingCallsConfig.valueJson === true };
  }
  return result;
}

export { enableMockAi } from "@/server/ai/enable-mock";
