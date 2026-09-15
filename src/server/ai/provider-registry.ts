import "server-only";
import type { Prisma } from "@prisma/client";
import type { lookup } from "node:dns/promises";
import { env } from "@/lib/env";
import { canonicalHash } from "@/server/ai/canonical-hash";
import { promptKeyContract } from "@/lib/ai/schemas";
import type { ProviderAdapter } from "@/lib/ai/provider";
import {
  DeepSeekProvider,
  isIsolatedHttpTransport,
  type HttpTransport,
  type SecretRecord,
} from "@/server/ai/deepseek-provider";
import { MockAiProvider, type MockProviderEvent } from "@/server/ai/mock-provider";
import {
  loadGuardedKeyCandidate,
  type GuardedKeyCandidate,
} from "@/server/ai/key-candidate-context";

export interface ProviderResolution {
  readonly providerId: string;
  readonly configVersion: number;
  readonly mode: "MOCK" | "LIVE";
  readonly adapter: ProviderAdapter;
}
export interface ProviderRegistryOptions {
  readonly liveEgressAllowed?: boolean;
  readonly transport?: HttpTransport;
  readonly dnsLookup?: typeof lookup;
  readonly mockEvents?: readonly MockProviderEvent[];
  readonly mockClock?: () => number;
  readonly mockOutput?: string;
  readonly mockDelayMs?: number;
  readonly mockUsage?: { inputTokens: number; outputTokens: number } | null;
  readonly resolveSecret?: (record: SecretRecord) => string;
}
export async function resolveProviderAdapter(
  tx: Prisma.TransactionClient,
  provider: {
    providerId: string;
    providerConfigVersion: number;
    deploymentId: string;
    deploymentConfigVersion: number;
    promptKey: string;
  },
  options: ProviderRegistryOptions = {},
  candidate?: GuardedKeyCandidate,
): Promise<ProviderResolution> {
  const config = await tx.providerConfigVersion.findUnique({
    where: {
      providerId_configVersion: {
        providerId: provider.providerId,
        configVersion: provider.providerConfigVersion,
      },
    },
  });
  const deployment = await tx.modelDeployment.findUnique({
    where: {
      id_configVersion: {
        id: provider.deploymentId,
        configVersion: provider.deploymentConfigVersion,
      },
    },
  });
  if (
    !config ||
    !deployment ||
    deployment.providerId !== config.providerId ||
    deployment.providerConfigVersion !== config.configVersion
  )
    throw new Error("CONFIG_ERROR");
  if (
    canonicalHash({
      mode: config.mode,
      baseUrl: config.baseUrl,
      capabilities: config.capabilities,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      quotaTokensPerDay: config.quotaTokensPerDay,
      costLimitPerDay: config.costLimitPerDay.toString(),
      region: config.region,
      locale: config.locale,
      credentialRequirement: config.credentialRequirement,
      secretRef: config.secretRef,
    }) !== config.contentHash
  )
    throw new Error("CONFIG_ERROR");
  if (config.mode === "MOCK") {
    if (config.credentialRequirement !== "NONE" || config.secretRef !== null)
      throw new Error("CONFIG_ERROR");
    if (
      process.env.NODE_ENV !== "test" &&
      (options.mockEvents ||
        options.mockClock ||
        options.mockOutput ||
        options.mockDelayMs ||
        options.mockUsage !== undefined)
    )
      throw new Error("CONFIG_ERROR");
    return {
      providerId: config.providerId,
      configVersion: config.configVersion,
      mode: "MOCK",
      adapter: new MockAiProvider({
        events: options.mockEvents,
        clock: options.mockClock,
        output:
          options.mockOutput ?? JSON.stringify(promptKeyContract(provider.promptKey).fixtureOutput),
        delayMs: options.mockDelayMs,
        usage: options.mockUsage,
      }),
    };
  }
  const isolated = isIsolatedHttpTransport(options.transport);
  if (
    options.liveEgressAllowed !== true ||
    (!isolated && env.AI_MOCK !== false) ||
    (options.transport && !isolated)
  )
    throw new Error("CONFIG_ERROR");
  let secretRecord: SecretRecord | undefined;
  if (config.credentialRequirement === "REQUIRED") {
    if (!config.secretRef) throw new Error("CONFIG_ERROR");
    const key = candidate
      ? { ...(await loadGuardedKeyCandidate(tx, candidate)).key, newRotationRuns: [] }
      : await tx.apiKeyConfig.findUnique({
          where: { id: config.secretRef },
          include: {
            newRotationRuns: {
              where: { stage: { not: "ACTIVATED" } },
              select: { id: true },
              take: 1,
            },
          },
        });
    if (
      !key ||
      key.id !== config.secretRef ||
      (candidate
        ? key.id !== candidate.target.keyId || key.status !== "DISABLED"
        : key.status !== "ACTIVE") ||
      key.provider !== "deepseek" ||
      (!candidate && key.newRotationRuns.length)
    )
      throw new Error("CONFIG_ERROR");
    secretRecord = {
      id: key.id,
      provider: key.provider,
      encryptedKey: key.encryptedKey,
      encryptionKeyId: key.encryptionKeyId,
      envelopeVersion: key.envelopeVersion,
      keyFingerprint: key.keyFingerprint,
    };
  } else if (config.secretRef !== null) throw new Error("CONFIG_ERROR");
  return {
    providerId: config.providerId,
    configVersion: config.configVersion,
    mode: "LIVE",
    adapter: new DeepSeekProvider({
      baseUrl: config.baseUrl,
      model: deployment.providerModelName,
      secretRecord,
      keyResolver: candidate?.resolver,
      resolveSecret: options.resolveSecret,
      transport: options.transport,
      dnsLookup: options.dnsLookup,
    }),
  };
}
