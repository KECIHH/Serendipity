import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Prisma, type KeyRotationRun, type PrismaClient } from "@prisma/client";
import {
  parseKeyRotationReceipt,
  type ApiKeyRotateRequest,
  type KeyRotationReceipt,
} from "@/lib/admin-api-keys";
import { stableStringify } from "@/lib/json";
import {
  AdminCommandError,
  assertAdminCommandClaim,
  claimAdminCommand,
  findAdminCommandReceipt,
  finishKeyRotationCommand,
  prepareKeyRotationRun,
  readTerminalRotationReceipt,
  releaseKeyRotationCommand,
  reserveAdminCommand,
  saveKeyRotationCheckpoint,
  type AdminCommandClaim,
  type AdminCommandIdentity,
} from "@/server/admin/command-receipt";
import type { KeyCandidateClient } from "@/server/admin/key-candidate-client";
import {
  createKeyReferenceRegistry,
  KeyLifecycleError,
  parseReferenceCandidates,
  referenceRevisionKey,
  referenceSetHash,
  type KeyConnectionTarget,
  type KeyReferenceAdapter,
} from "@/server/admin/key-reference";
import { AuditLogError, type AuditRequestContext } from "@/server/audit-log";
import { readAuthClock } from "@/server/auth/clock";
import { readAdminApiKey } from "@/server/projections/admin-api-key";
import {
  decryptSecret,
  encryptSecret,
  generateFingerprint,
  SecretDecryptError,
  type KeyResolver,
} from "@/server/security/secret-envelope";
import {
  AuditTransactionConflictError,
  openAuditedAdminDatabase,
  writeAuditLog,
} from "@/server/services/audit-log-service";

interface CommandScope {
  context: AuditRequestContext;
  authorize(tx: Prisma.TransactionClient): Promise<{ id: string; email: string }>;
}
interface CoordinatorOptions {
  client: PrismaClient;
  audited: ReturnType<typeof openAuditedAdminDatabase>;
  resolver: KeyResolver;
  adapters: readonly KeyReferenceAdapter[];
  candidateClient: KeyCandidateClient;
}
interface PreparedRun {
  run: KeyRotationRun;
  claim: AdminCommandClaim;
}
class ExistingRotation extends AuditLogError {
  constructor() {
    super("VALIDATION_ERROR");
  }
}

function errorCode(run: KeyRotationRun): string | null {
  const checkpoint = run.checkpointJson as Record<string, unknown>;
  return typeof checkpoint.errorCode === "string" ? checkpoint.errorCode : null;
}
function digest(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** One coordinator owns preparation, real transport validation and the final all-reference CAS. */
export function createKeyRotationCoordinator(options: CoordinatorOptions) {
  const { client, audited, resolver, candidateClient } = options,
    registry = createKeyReferenceRegistry(options.adapters);
  async function transaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return client.$transaction(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000,
      timeout: 15_000,
    });
  }
  async function boundedRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const retry =
          error instanceof AuditTransactionConflictError ||
          (error instanceof Prisma.PrismaClientKnownRequestError &&
            ["P2034", "P2002"].includes(error.code));
        if (!retry || attempt === 3) throw error;
        await delay(15 * (attempt + 1));
      }
    }
    throw new KeyLifecycleError(503, "INTERNAL_ERROR");
  }
  async function snapshot(
    tx: Prisma.TransactionClient,
    run: KeyRotationRun,
    replayed: boolean,
  ): Promise<KeyRotationReceipt> {
    const key = await readAdminApiKey(tx, run.newKeyId ?? run.oldKeyId);
    if (!key) throw new KeyLifecycleError(503, "CONFIG_ERROR");
    return parseKeyRotationReceipt({
      key,
      stage: run.stage,
      affectedConfigCount: parseReferenceCandidates(run.candidateIdsJson).length,
      errorCode: errorCode(run),
      replayed,
    });
  }
  async function existing(
    command: AdminCommandIdentity,
    scope: CommandScope,
  ): Promise<PreparedRun | KeyRotationReceipt> {
    return boundedRetry(() =>
      transaction(async (tx) => {
        await scope.authorize(tx);
        const receipt = await findAdminCommandReceipt(tx, command);
        if (!receipt) throw new KeyLifecycleError(503, "INTERNAL_ERROR");
        if (receipt.status === "SUCCEEDED" || receipt.status === "FAILED") {
          const response = readTerminalRotationReceipt(receipt);
          if (receipt.status === "FAILED")
            throw new KeyLifecycleError(
              receipt.errorCode === "VERSION_CONFLICT" ? 409 : 503,
              receipt.errorCode === "VERSION_CONFLICT" ? "VERSION_CONFLICT" : "CONFIG_ERROR",
              { rotation: response },
            );
          return response;
        }
        const run = await tx.keyRotationRun.findUnique({ where: { receiptId: receipt.id } });
        if (!run) throw new KeyLifecycleError(503, "CONFIG_ERROR");
        const claim = await claimAdminCommand(tx, {
          receiptId: receipt.id,
          leaseOwner: `rotation_${randomUUID()}`,
          leaseMs: 60_000,
        });
        if (!claim) return snapshot(tx, run, true);
        return { run, claim };
      }),
    );
  }
  async function prepare(
    command: AdminCommandIdentity,
    input: ApiKeyRotateRequest,
    scope: CommandScope,
  ): Promise<PreparedRun | KeyRotationReceipt> {
    try {
      return await boundedRetry(() =>
        audited.transaction(async (tx) => {
          const actor = await scope.authorize(tx);
          if (await findAdminCommandReceipt(tx, command)) throw new ExistingRotation();
          await tx.$queryRaw`SELECT id FROM "ApiKeyConfig" WHERE id=${command.resourceId} FOR UPDATE`;
          const old = await readAdminApiKey(tx, command.resourceId);
          if (!old) throw new KeyLifecycleError(404, "NOT_FOUND");
          if (
            old.revision !== input.expectedVersion ||
            old.status !== "ACTIVE" ||
            old.provider !== input.provider
          )
            throw new KeyLifecycleError(409, "VERSION_CONFLICT");
          if (
            await tx.apiKeyConfig.count({
              where: { keyFingerprint: generateFingerprint(input.plainKey) },
            })
          )
            throw new KeyLifecycleError(409, "VERSION_CONFLICT");
          const receipt = await reserveAdminCommand(tx, command),
            claim = await claimAdminCommand(tx, {
              receiptId: receipt.id,
              leaseOwner: `rotation_${randomUUID()}`,
              leaseMs: 60_000,
            });
          if (!claim) throw new KeyLifecycleError(503, "INTERNAL_ERROR");
          const references = await registry.list(tx, old.id),
            newKeyId = `key_${randomUUID()}`,
            now = await readAuthClock(tx);
          await tx.apiKeyConfig.create({
            data: {
              id: newKeyId,
              name: input.name,
              provider: old.provider,
              ...encryptSecret(
                { id: newKeyId, provider: old.provider, plainKey: input.plainKey },
                resolver,
              ),
              status: "DISABLED",
              createdAt: now,
              updatedAt: now,
            },
            select: { id: true },
          });
          const candidates = await registry.prepare(tx, references, newKeyId);
          const baseRevisionsJson: Record<string, number> = { [old.id]: old.revision };
          for (const reference of references)
            baseRevisionsJson[referenceRevisionKey(reference)] = reference.revision;
          const run = await prepareKeyRotationRun(tx, {
            claim,
            oldKeyId: old.id,
            newKeyId,
            referenceSetHash: referenceSetHash(references),
            baseRevisionsJson,
            candidateIdsJson: candidates,
          });
          await writeAuditLog(tx, {
            actor: { kind: "USER", id: actor.id, emailSnapshot: actor.email },
            action: "API_KEY_CREATE",
            targetType: "ApiKeyConfig",
            targetId: newKeyId,
            context: scope.context,
            detailJson: {
              after: { status: "DISABLED", revision: 0 },
              result: "SUCCESS",
              reasonCode: "KEY_CREATED",
            },
          });
          return { run, claim };
        }),
      );
    } catch (error) {
      if (error instanceof ExistingRotation) return existing(command, scope);
      throw error;
    }
  }
  async function test(
    prepared: PreparedRun,
    scope: CommandScope,
  ): Promise<{ verificationHash: string; targetsHash: string }> {
    const loaded = await transaction(async (tx) => {
      await scope.authorize(tx);
      await assertAdminCommandClaim(tx, prepared.claim);
      let run = await tx.keyRotationRun.findUniqueOrThrow({ where: { id: prepared.run.id } });
      if (run.stage === "PREPARING")
        run = await saveKeyRotationCheckpoint(tx, {
          claim: prepared.claim,
          runId: run.id,
          stage: "TESTING",
          step: "TESTING",
        });
      if (run.stage !== "TESTING" && run.stage !== "READY")
        throw new KeyLifecycleError(409, "VERSION_CONFLICT");
      if (!run.newKeyId) throw new KeyLifecycleError(503, "CONFIG_ERROR");
      const row = await tx.apiKeyConfig.findUnique({ where: { id: run.newKeyId } });
      if (!row || row.status !== "DISABLED" || row.revision !== 0)
        throw new KeyLifecycleError(409, "VERSION_CONFLICT");
      const targets: KeyConnectionTarget[] = [];
      for (const candidate of parseReferenceCandidates(run.candidateIdsJson)) {
        const target = await registry
          .adapter(candidate.adapterId)
          .connectionTarget(tx, candidate, row.id);
        if (
          target.keyId !== row.id ||
          stableStringify(target.candidate) !== stableStringify(candidate)
        )
          throw new KeyLifecycleError(503, "CONFIG_ERROR");
        targets.push(target);
      }
      return { row, targets, run };
    });
    // No database transaction remains open while the controlled HTTP transport runs.
    const plainKey = decryptSecret(loaded.row, resolver);
    if (generateFingerprint(plainKey) !== loaded.row.keyFingerprint)
      throw new KeyLifecycleError(503, "CONFIG_ERROR");
    const started = Date.now(),
      proofs: string[] = [];
    for (const target of loaded.targets) {
      if (Date.now() - started > 30_000) throw new KeyLifecycleError(503, "PROVIDER_TIMEOUT");
      proofs.push(await candidateClient.verify(target, plainKey));
    }
    const targetsHash = digest(loaded.targets);
    const verificationHash = digest({
      runId: loaded.run.id,
      newKeyId: loaded.row.id,
      referenceSetHash: loaded.run.referenceSetHash,
      candidates: parseReferenceCandidates(loaded.run.candidateIdsJson),
      targetsHash,
      fencingToken: prepared.claim.fencingToken,
      proofs,
    });
    await transaction(async (tx) => {
      await scope.authorize(tx);
      await assertAdminCommandClaim(tx, prepared.claim);
      await saveKeyRotationCheckpoint(tx, {
        claim: prepared.claim,
        runId: prepared.run.id,
        stage: "READY",
        step: "VERIFIED",
        verificationHash,
      });
    });
    return { verificationHash, targetsHash };
  }
  async function activate(
    prepared: PreparedRun,
    proof: { verificationHash: string; targetsHash: string },
    scope: CommandScope,
  ): Promise<KeyRotationReceipt> {
    return boundedRetry(() =>
      audited.transaction(async (tx) => {
        const actor = await scope.authorize(tx);
        await assertAdminCommandClaim(tx, prepared.claim);
        const run = await tx.keyRotationRun.findUniqueOrThrow({ where: { id: prepared.run.id } });
        if (
          run.stage !== "READY" ||
          !run.newKeyId ||
          (run.checkpointJson as Record<string, unknown>).verificationHash !==
            proof.verificationHash
        )
          throw new KeyLifecycleError(409, "VERSION_CONFLICT");
        await tx.$queryRaw`SELECT id FROM "ApiKeyConfig" WHERE id IN (${run.oldKeyId},${run.newKeyId}) ORDER BY id FOR UPDATE`;
        const old = await readAdminApiKey(tx, run.oldKeyId),
          candidate = await readAdminApiKey(tx, run.newKeyId);
        const base = run.baseRevisionsJson as Record<string, number>;
        if (
          !old ||
          !candidate ||
          old.status !== "ACTIVE" ||
          old.revision !== base[old.id] ||
          candidate.status !== "DISABLED" ||
          candidate.revision !== 0 ||
          candidate.provider !== old.provider
        )
          throw new KeyLifecycleError(409, "VERSION_CONFLICT");
        const references = await registry.list(tx, old.id),
          candidates = parseReferenceCandidates(run.candidateIdsJson);
        if (
          referenceSetHash(references) !== run.referenceSetHash ||
          references.length !== candidates.length ||
          references.some((ref) => base[referenceRevisionKey(ref)] !== ref.revision)
        )
          throw new KeyLifecycleError(409, "VERSION_CONFLICT");
        const currentTargets: KeyConnectionTarget[] = [];
        for (const entry of candidates)
          currentTargets.push(
            await registry.adapter(entry.adapterId).connectionTarget(tx, entry, candidate.id),
          );
        if (digest(currentTargets) !== proof.targetsHash)
          throw new KeyLifecycleError(409, "VERSION_CONFLICT");
        const now = await readAuthClock(tx);
        await tx.apiKeyConfig.update({
          where: { id: candidate.id, revision: 0, status: "DISABLED" },
          data: { status: "ACTIVE", revision: { increment: 1 }, updatedAt: now },
          select: { id: true },
        });
        for (const reference of references) {
          const next = candidates.find(
            (item) =>
              item.adapterId === reference.adapterId && item.referenceId === reference.referenceId,
          );
          if (!next) throw new KeyLifecycleError(503, "CONFIG_ERROR");
          await registry.adapter(reference.adapterId).activate(tx, reference, next, candidate.id);
        }
        await tx.apiKeyConfig.update({
          where: { id: old.id, revision: old.revision, status: "ACTIVE" },
          data: { status: "REVOKED", revokedAt: now, revision: { increment: 1 }, updatedAt: now },
          select: { id: true },
        });
        await writeAuditLog(tx, {
          actor: { kind: "USER", id: actor.id, emailSnapshot: actor.email },
          action: "API_KEY_UPDATE",
          targetType: "ApiKeyConfig",
          targetId: candidate.id,
          context: scope.context,
          detailJson: {
            before: { status: "DISABLED", revision: 0 },
            after: { status: "ACTIVE", revision: 1 },
            result: "SUCCESS",
            reasonCode: "KEY_UPDATED",
          },
        });
        await writeAuditLog(tx, {
          actor: { kind: "USER", id: actor.id, emailSnapshot: actor.email },
          action: "API_KEY_ROTATE",
          targetType: "ApiKeyConfig",
          targetId: old.id,
          context: scope.context,
          detailJson: {
            before: { status: "ACTIVE", revision: old.revision },
            after: { status: "REVOKED", revision: old.revision + 1 },
            count: references.length,
            result: "SUCCESS",
            reasonCode: "KEY_ROTATED",
          },
        });
        const completed = await saveKeyRotationCheckpoint(tx, {
          claim: prepared.claim,
          runId: run.id,
          stage: "ACTIVATED",
          step: "ACTIVATED",
          verificationHash: proof.verificationHash,
        });
        const response = await snapshot(tx, completed, false);
        await finishKeyRotationCommand(tx, prepared.claim, response);
        return response;
      }),
    );
  }
  async function recordFailure(
    prepared: PreparedRun,
    scope: CommandScope,
    error: unknown,
  ): Promise<KeyRotationReceipt> {
    const failure =
      error instanceof KeyLifecycleError
        ? error
        : error instanceof SecretDecryptError
          ? new KeyLifecycleError(503, "CONFIG_ERROR")
          : new KeyLifecycleError(503, "INTERNAL_ERROR");
    if (failure.status === 401 || failure.status === 403) throw failure;
    return transaction(async (tx) => {
      await scope.authorize(tx);
      await assertAdminCommandClaim(tx, prepared.claim);
      const run = await tx.keyRotationRun.findUniqueOrThrow({ where: { id: prepared.run.id } });
      const aborted = failure.status === 409;
      const stage = aborted ? "ABORTED" : run.stage === "READY" ? "READY" : "TESTING";
      const checkpoint = await saveKeyRotationCheckpoint(tx, {
        claim: prepared.claim,
        runId: run.id,
        stage,
        step: stage === "ABORTED" ? "ABORTED" : stage === "READY" ? "VERIFIED" : "TESTING",
        errorCode: failure.publicCode,
      });
      const response = await snapshot(tx, checkpoint, false);
      if (aborted) await finishKeyRotationCommand(tx, prepared.claim, response, "VERSION_CONFLICT");
      else await releaseKeyRotationCommand(tx, prepared.claim);
      return response;
    });
  }
  return Object.freeze({
    async rotate(
      command: AdminCommandIdentity,
      input: ApiKeyRotateRequest,
      scope: CommandScope,
    ): Promise<KeyRotationReceipt> {
      const prepared = await prepare(command, input, scope);
      if (!("claim" in prepared)) return prepared;
      try {
        const proof = await test(prepared, scope);
        return await activate(prepared, proof, scope);
      } catch (error) {
        let response: KeyRotationReceipt;
        try {
          response = await recordFailure(prepared, scope, error);
        } catch (recordError) {
          if (recordError instanceof KeyLifecycleError) throw recordError;
          if (recordError instanceof AdminCommandError && recordError.kind === "CLAIM_LOST")
            throw new KeyLifecycleError(409, "VERSION_CONFLICT");
          throw new KeyLifecycleError(503, "INTERNAL_ERROR");
        }
        if (response.stage === "ABORTED")
          throw new KeyLifecycleError(409, "VERSION_CONFLICT", { rotation: response });
        if (
          response.errorCode === "PROVIDER_UNAVAILABLE" ||
          response.errorCode === "PROVIDER_TIMEOUT" ||
          response.errorCode === "CONFIG_ERROR"
        )
          return response;
        throw new KeyLifecycleError(503, "INTERNAL_ERROR", { rotation: response });
      }
    },
  });
}
