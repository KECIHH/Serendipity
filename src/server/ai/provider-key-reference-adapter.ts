import "server-only";
import type { Prisma, ModelDeployment, ProviderConfigVersion } from "@prisma/client";
import { canonicalHash } from "@/lib/ai/schemas";
import type {
  KeyConnectionTarget,
  KeyReference,
  KeyReferenceAdapter,
  KeyReferenceCandidate,
} from "@/server/admin/key-reference";
import { activatePromptModelTuple } from "@/server/services/prompt-service";
import { validateProviderUrlShape } from "@/server/ai/url-guard";

export const PROVIDER_KEY_REFERENCE_ADAPTER_ID = "provider-config-v1";
const modelHash = (row: ModelDeployment) =>
  canonicalHash({
    id: row.id,
    configVersion: row.configVersion,
    providerId: row.providerId,
    providerConfigVersion: row.providerConfigVersion,
    providerModelName: row.providerModelName,
    params: row.paramsJson,
    capabilities: row.capabilitiesJson,
    contextWindowTokens: row.contextWindowTokens,
  });
const providerHash = (row: ProviderConfigVersion) =>
  canonicalHash({
    mode: row.mode,
    baseUrl: row.baseUrl,
    capabilities: row.capabilities,
    timeoutMs: row.timeoutMs,
    maxRetries: row.maxRetries,
    quotaTokensPerDay: row.quotaTokensPerDay,
    costLimitPerDay: row.costLimitPerDay.toString(),
    region: row.region,
    locale: row.locale,
    credentialRequirement: row.credentialRequirement,
    secretRef: row.secretRef,
  });
const candidateId = (model: ModelDeployment, referenceId: string) =>
  `candidate_${canonicalHash({ id: model.id, version: model.configVersion, providerId: model.providerId, providerVersion: model.providerConfigVersion, referenceId })}`;
const candidateHash = (
  model: ModelDeployment,
  provider: ProviderConfigVersion,
  referenceId: string,
) =>
  canonicalHash({ modelHash: model.contentHash, providerHash: provider.contentHash, referenceId });
export class ProviderConfigKeyReferenceAdapter implements KeyReferenceAdapter {
  readonly id = PROVIDER_KEY_REFERENCE_ADAPTER_ID;
  async listActiveReferences(
    tx: Prisma.TransactionClient,
    keyId: string,
  ): Promise<readonly KeyReference[]> {
    const rows = await tx.promptModelActivation.findMany({
      where: { status: "ACTIVE", provider: { secretRef: keyId } },
      include: { provider: true },
      orderBy: { definitionId: "asc" },
    });
    return rows.map((row) => ({
      adapterId: this.id,
      referenceId: row.definitionId,
      revision: row.revision,
      configVersion: row.providerConfigVersion,
      contentHash: row.provider.contentHash,
    }));
  }
  async prepareCandidates(
    tx: Prisma.TransactionClient,
    references: readonly KeyReference[],
    newKeyId: string,
  ): Promise<readonly KeyReferenceCandidate[]> {
    const candidates: KeyReferenceCandidate[] = [];
    const newProviders = new Map<string, ProviderConfigVersion>(),
      newModels = new Map<string, ModelDeployment>();
    for (const reference of references) {
      const activation = await tx.promptModelActivation.findUnique({
        where: { definitionId: reference.referenceId },
        include: { provider: true, deployment: true },
      });
      if (
        !activation ||
        activation.status !== "ACTIVE" ||
        activation.revision !== reference.revision ||
        activation.providerConfigVersion !== reference.configVersion ||
        activation.provider.contentHash !== reference.contentHash ||
        activation.provider.credentialRequirement !== "REQUIRED"
      )
        throw new Error("CONFIG_ERROR");
      const source = activation.provider;
      validateProviderUrlShape(source.baseUrl);
      const providerIdentity = `${source.providerId}:${source.configVersion}`;
      let provider = newProviders.get(providerIdentity);
      if (!provider) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-version:${source.providerId}`},0::bigint))`;
        const latest = await tx.providerConfigVersion.findFirstOrThrow({
          where: { providerId: source.providerId },
          orderBy: { configVersion: "desc" },
        });
        const data = {
          ...source,
          configVersion: latest.configVersion + 1,
          secretRef: newKeyId,
          createdAt: new Date(),
        };
        data.contentHash = providerHash(data);
        provider = await tx.providerConfigVersion.create({
          data: { ...data, capabilities: data.capabilities as Prisma.InputJsonValue },
        });
        newProviders.set(providerIdentity, provider);
      }
      const oldModel = activation.deployment,
        modelIdentity = `${oldModel.id}:${oldModel.configVersion}:${provider.configVersion}`;
      let model = newModels.get(modelIdentity);
      if (!model) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`model-version:${oldModel.id}`},0::bigint))`;
        const latest = await tx.modelDeployment.findFirstOrThrow({
          where: { id: oldModel.id },
          orderBy: { configVersion: "desc" },
        });
        const data = {
          ...oldModel,
          configVersion: latest.configVersion + 1,
          providerConfigVersion: provider.configVersion,
          createdAt: new Date(),
        };
        data.contentHash = modelHash(data);
        model = await tx.modelDeployment.create({
          data: {
            ...data,
            paramsJson: data.paramsJson as Prisma.InputJsonValue,
            capabilitiesJson: data.capabilitiesJson as Prisma.InputJsonValue,
          },
        });
        newModels.set(modelIdentity, model);
      }
      candidates.push({
        adapterId: this.id,
        referenceId: reference.referenceId,
        candidateId: candidateId(model, reference.referenceId),
        configVersion: provider.configVersion,
        referenceRevision: reference.revision,
        contentHash: candidateHash(model, provider, reference.referenceId),
      });
    }
    return candidates;
  }
  async resolveCandidate(
    tx: Prisma.TransactionClient,
    candidate: KeyReferenceCandidate,
    newKeyId: string,
  ) {
    const activation = await tx.promptModelActivation.findUnique({
      where: { definitionId: candidate.referenceId },
    });
    if (
      !activation ||
      activation.status !== "ACTIVE" ||
      activation.revision !== candidate.referenceRevision ||
      candidate.adapterId !== this.id
    )
      throw new Error("CONFIG_ERROR");
    const provider = await tx.providerConfigVersion.findUnique({
      where: {
        providerId_configVersion: {
          providerId: activation.providerId,
          configVersion: candidate.configVersion,
        },
      },
    });
    if (
      !provider ||
      provider.secretRef !== newKeyId ||
      providerHash(provider) !== provider.contentHash
    )
      throw new Error("CONFIG_ERROR");
    const models = await tx.modelDeployment.findMany({
      where: {
        id: activation.deploymentId,
        providerId: provider.providerId,
        providerConfigVersion: provider.configVersion,
      },
    });
    const matches = models.filter(
      (model) =>
        candidateId(model, candidate.referenceId) === candidate.candidateId &&
        candidateHash(model, provider, candidate.referenceId) === candidate.contentHash &&
        modelHash(model) === model.contentHash,
    );
    if (matches.length !== 1) throw new Error("CONFIG_ERROR");
    return { activation, provider, model: matches[0] };
  }
  async connectionTarget(
    tx: Prisma.TransactionClient,
    candidate: KeyReferenceCandidate,
    newKeyId: string,
  ): Promise<KeyConnectionTarget> {
    const { provider } = await this.resolveCandidate(tx, candidate, newKeyId);
    return { url: provider.baseUrl, keyId: newKeyId, candidate };
  }
  async activate(
    tx: Prisma.TransactionClient,
    reference: KeyReference,
    candidate: KeyReferenceCandidate,
    newKeyId: string,
  ): Promise<void> {
    if (
      reference.referenceId !== candidate.referenceId ||
      reference.revision !== candidate.referenceRevision
    )
      throw new Error("CONFIG_ERROR");
    const { activation, provider, model } = await this.resolveCandidate(tx, candidate, newKeyId);
    await activatePromptModelTuple(tx, {
      definitionId: activation.definitionId,
      promptVersionId: activation.promptVersionId,
      deploymentId: model.id,
      deploymentConfigVersion: model.configVersion,
      providerId: provider.providerId,
      providerConfigVersion: provider.configVersion,
      expectedRevision: reference.revision,
    });
  }
}
