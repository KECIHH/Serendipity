import "server-only";
import type { ApiKeyConfig, Prisma } from "@prisma/client";
import { canonicalHash } from "@/lib/ai/schemas";
import type { KeyCandidateAuthorization } from "@/server/admin/key-candidate-client";
import { assertAdminCommandClaim } from "@/server/admin/command-receipt";
import { parseReferenceCandidates, type KeyConnectionTarget } from "@/server/admin/key-reference";
import type { KeyResolver } from "@/server/security/secret-envelope";
import { parseModelDeployment } from "@/server/services/model-resolution-service";
import type { PromptModelSnapshot } from "@/server/services/prompt-service";
import { ProviderConfigKeyReferenceAdapter } from "./provider-key-reference-adapter";

export interface GuardedKeyCandidate {
  readonly target: KeyConnectionTarget;
  readonly record: ApiKeyConfig;
  readonly resolver: KeyResolver;
  readonly authorization: KeyCandidateAuthorization;
}

/** The sole key-state exception is the exact candidate owned by the current ADMIN command lease. */
export async function loadGuardedKeyCandidate(
  tx: Prisma.TransactionClient,
  context: GuardedKeyCandidate,
) {
  const actor = await context.authorization.authorize(tx);
  await assertAdminCommandClaim(tx, context.authorization.claim);
  const { target, record } = context;
  const tuple = await new ProviderConfigKeyReferenceAdapter().resolveCandidate(
    tx,
    target.candidate,
    target.keyId,
  );
  const key = await tx.apiKeyConfig.findUnique({ where: { id: target.keyId } });
  const run = await tx.keyRotationRun.findUnique({
    where: { id: context.authorization.runId },
    include: { oldKey: true, receipt: true },
  });
  if (
    !key ||
    key.status !== "DISABLED" ||
    key.revision !== 0 ||
    key.id !== record.id ||
    key.encryptedKey !== record.encryptedKey ||
    key.keyFingerprint !== record.keyFingerprint ||
    key.provider !== "deepseek" ||
    !run ||
    !["TESTING", "READY"].includes(run.stage) ||
    run.newKeyId !== key.id ||
    run.oldKey.status !== "ACTIVE" ||
    run.receiptId !== context.authorization.claim.receiptId ||
    run.receipt.ownerUserId !== actor.id ||
    run.receipt.operationId !== "post.admin.api-keys.id.rotate" ||
    target.url !== tuple.provider.baseUrl ||
    tuple.provider.mode !== "LIVE" ||
    !parseReferenceCandidates(run.candidateIdsJson).some(
      (c) => canonicalHash(c) === canonicalHash(target.candidate),
    )
  )
    throw new Error("CONFIG_ERROR");
  return { ...tuple, key };
}

export async function bindGuardedKeyCandidate(
  tx: Prisma.TransactionClient,
  snapshot: PromptModelSnapshot,
  context: GuardedKeyCandidate,
): Promise<PromptModelSnapshot> {
  const { activation, provider, model } = await loadGuardedKeyCandidate(tx, context);
  const resolvedModel = parseModelDeployment(model);
  if (
    snapshot.definitionId !== activation.definitionId ||
    snapshot.activationRevision !== activation.revision ||
    snapshot.promptVersionId !== activation.promptVersionId ||
    !resolvedModel.capabilities.includes(snapshot.promptKey) ||
    !Array.isArray(provider.capabilities) ||
    !provider.capabilities.includes(snapshot.promptKey) ||
    (snapshot.variables.locale !== provider.locale && provider.locale !== "*")
  )
    throw new Error("CONFIG_ERROR");
  return {
    ...snapshot,
    model: resolvedModel,
    provider: {
      providerId: provider.providerId,
      configVersion: provider.configVersion,
      mode: provider.mode,
      baseUrl: provider.baseUrl,
      timeoutMs: provider.timeoutMs,
      credentialRequirement: provider.credentialRequirement,
      secretRef: provider.secretRef,
      maxRetries: provider.maxRetries,
      quotaTokensPerDay: provider.quotaTokensPerDay,
      costLimitPerDay: provider.costLimitPerDay.toString(),
      region: provider.region,
      locale: provider.locale,
    },
  };
}
