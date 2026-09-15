import "server-only";

import type { ModelDeployment, Prisma } from "@prisma/client";
import { canonicalHash } from "@/server/ai/canonical-hash";

export interface ResolvedModelSnapshot {
  readonly deploymentId: string;
  readonly deploymentConfigVersion: number;
  readonly providerId: string;
  readonly providerConfigVersion: number;
  readonly providerModelName: string;
  readonly contextWindowTokens: number;
  readonly capabilities: readonly string[];
  readonly maxOutputTokens: number;
  readonly temperature: number;
  readonly pricing: { inputPerToken: string; outputPerToken: string; fixedPerRequest: string };
}

export function parseCapabilities(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("CONFIG_ERROR");
  }
  return value;
}

export async function resolveModelSnapshot(
  tx: Prisma.TransactionClient,
  definitionId: string,
): Promise<ResolvedModelSnapshot> {
  const activation = await tx.promptModelActivation.findUnique({
    where: { definitionId },
    include: { deployment: true },
  });
  if (!activation || activation.status !== "ACTIVE") throw new Error("CONFIG_ERROR");
  const deployment = activation.deployment;
  if (deployment.configVersion !== activation.deploymentConfigVersion)
    throw new Error("CONFIG_ERROR");
  return parseModelDeployment(deployment);
}

export function parseModelDeployment(deployment: ModelDeployment): ResolvedModelSnapshot {
  const capabilities = parseCapabilities(deployment.capabilitiesJson);
  if (
    canonicalHash({
      id: deployment.id,
      configVersion: deployment.configVersion,
      providerId: deployment.providerId,
      providerConfigVersion: deployment.providerConfigVersion,
      providerModelName: deployment.providerModelName,
      params: deployment.paramsJson,
      capabilities: deployment.capabilitiesJson,
      contextWindowTokens: deployment.contextWindowTokens,
    }) !== deployment.contentHash
  ) {
    throw new Error("CONFIG_ERROR");
  }
  const params = deployment.paramsJson as Record<string, unknown>;
  const pricing = params.pricing as Record<string, unknown> | undefined;
  if (
    !Number.isSafeInteger(params.maxOutputTokens) ||
    Number(params.maxOutputTokens) < 1 ||
    Number(params.maxOutputTokens) >= deployment.contextWindowTokens ||
    typeof params.temperature !== "number" ||
    params.temperature < 0 ||
    params.temperature > 2 ||
    !pricing ||
    pricing.basis !== "UTF8_BYTE_UPPER_BOUND_V1" ||
    ["inputPerToken", "outputPerToken", "fixedPerRequest"].some(
      (key) =>
        typeof pricing[key] !== "string" ||
        !/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(String(pricing[key])),
    )
  )
    throw new Error("CONFIG_ERROR");
  return {
    deploymentId: deployment.id,
    deploymentConfigVersion: deployment.configVersion,
    providerId: deployment.providerId,
    providerConfigVersion: deployment.providerConfigVersion,
    providerModelName: deployment.providerModelName,
    contextWindowTokens: deployment.contextWindowTokens,
    capabilities,
    maxOutputTokens: Number(params.maxOutputTokens),
    temperature: params.temperature,
    pricing: {
      inputPerToken: String(pricing.inputPerToken),
      outputPerToken: String(pricing.outputPerToken),
      fixedPerRequest: String(pricing.fixedPerRequest),
    },
  };
}
