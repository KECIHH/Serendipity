import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { Prisma, type PrismaClient, type AiUsageReservation } from "@prisma/client";
import { env } from "@/lib/env";
import type { AiErrorCode, ProviderResult, ProviderRequest } from "@/lib/ai/provider";
import {
  canonicalHash,
  canonicalJson,
  parsePromptVariables,
  parsePromptResponse,
  promptKeyContract,
} from "@/lib/ai/schemas";
import {
  resolveProviderAdapter,
  type ProviderRegistryOptions,
} from "@/server/ai/provider-registry";
import { resolvePromptSnapshot, type PromptModelSnapshot } from "@/server/services/prompt-service";
import { actualUsageCost, estimateUsage, reserveUsage } from "@/server/ai/usage-reservations";
import {
  bindGuardedKeyCandidate,
  loadGuardedKeyCandidate,
  type GuardedKeyCandidate,
} from "@/server/ai/key-candidate-context";

export interface GuardedAiCallInput {
  readonly promptKey: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly userMessage: string;
  readonly traceId: string;
  readonly travelRecordId?: string;
  readonly signal?: AbortSignal;
}
export type GuardedAiCallResult =
  | {
      readonly ok: true;
      readonly traceId: string;
      readonly attemptNo: number;
      readonly output: unknown;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly durationMs: number;
      readonly retryable: false;
      readonly safeMessage: string;
    }
  | {
      readonly ok: false;
      readonly traceId: string;
      readonly errorCode: AiErrorCode;
      readonly retryable: boolean;
      readonly safeMessage: string;
    };
export type AiOwnerContext =
  | { readonly kind: "SYNTHETIC"; readonly runId: string }
  | { readonly kind: "USER"; readonly userId: string; readonly privateInputAllowed: boolean };
export interface GuardedAiClientOptions extends ProviderRegistryOptions {
  readonly db: PrismaClient;
  readonly owner?: AiOwnerContext;
  readonly clock?: () => number;
  readonly maxUserMessageBytes?: number;
  readonly maxOutputBytes?: number;
  readonly jitter?: () => number;
  readonly costCap?: string;
}
function safeError(
  errorCode: AiErrorCode,
  traceId: string,
  retryable = false,
): GuardedAiCallResult {
  const messages: Record<AiErrorCode, string> = {
    FEATURE_DISABLED: "AI calls are disabled.",
    CONFIG_ERROR: "AI configuration is unavailable.",
    RATE_LIMITED: "The AI provider is rate limiting requests.",
    COST_LIMIT: "The AI cost limit was reached.",
    PROVIDER_TIMEOUT: "The AI provider timed out.",
    PROVIDER_UNAVAILABLE: "The AI provider is unavailable.",
    CANCELLED: "The AI call was cancelled.",
  };
  return { ok: false, traceId, errorCode, retryable, safeMessage: messages[errorCode] };
}
async function isAiEnabled(db: PrismaClient): Promise<boolean> {
  return (
    (await db.systemConfig.findUnique({ where: { key: "ai.calls.enabled" } }))?.valueJson === true
  );
}
async function authorizeOwner(
  input: GuardedAiCallInput,
  options: GuardedAiClientOptions,
  snapshot: PromptModelSnapshot,
) {
  const owner = options.owner;
  if (!owner) throw new Error("CONFIG_ERROR");
  if (owner.kind === "SYNTHETIC") {
    if (
      !/^phase\d{3}_disposable_[a-f0-9]{12}$/.test(owner.runId) ||
      snapshot.planningPolicy.scope !== "SYNTHETIC_ONLY"
    )
      throw new Error("CONFIG_ERROR");
    const [db] = await options.db.$queryRaw<
      Array<{ name: string; marker: string | null }>
    >`SELECT current_database() AS name,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()`;
    if (
      db.name !== owner.runId ||
      db.marker !==
        `serendipity-phase${owner.runId.slice(5, 8)}-disposable:${owner.runId.slice(-12)}` ||
      input.travelRecordId
    )
      throw new Error("CONFIG_ERROR");
  } else {
    if (snapshot.planningPolicy.scope === "SYNTHETIC_ONLY" || !owner.privateInputAllowed)
      throw new Error("CONFIG_ERROR");
    const user = await options.db.user.findUnique({ where: { id: owner.userId } });
    if (!user || user.status !== "ACTIVE") throw new Error("CONFIG_ERROR");
    if (
      input.travelRecordId &&
      (await options.db.travelRecord.findUnique({ where: { id: input.travelRecordId } }))
        ?.userId !== user.id
    )
      throw new Error("CONFIG_ERROR");
  }
}
function render(
  input: GuardedAiCallInput,
  snapshot: PromptModelSnapshot,
  maxBytes: number,
): ProviderRequest {
  if (
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.traceId) ||
    typeof input.userMessage !== "string" ||
    !input.userMessage.trim() ||
    Buffer.byteLength(input.userMessage) > maxBytes
  )
    throw new Error("CONFIG_ERROR");
  const variables = parsePromptVariables(input.promptKey, input.variables),
    scalars: Record<string, unknown> = {},
    data: Record<string, unknown> = {};
  for (const variable of promptKeyContract(input.promptKey).variables)
    (variable.delivery === "system_scalar" ? scalars : data)[variable.name] =
      variables[variable.name];
  const serialized = canonicalJson({ userMessage: input.userMessage, variables });
  if (/(?:authorization\s*:|bearer\s+[a-z0-9._-]{20,}|cookie\s*:)/i.test(serialized))
    throw new Error("CONFIG_ERROR");
  return {
    system: `${snapshot.system}\nValidated service scalars: ${canonicalJson(scalars)}`,
    userMessage: input.userMessage,
    userData: canonicalJson(data),
    maxOutputTokens: snapshot.model.maxOutputTokens,
    temperature: snapshot.model.temperature,
    responseFormat: "json",
  };
}
async function markSubmitted(
  options: GuardedAiClientOptions,
  reservation: AiUsageReservation,
  snapshot: PromptModelSnapshot,
  signal: AbortSignal,
  candidate?: GuardedKeyCandidate,
) {
  await options.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "SystemConfig" WHERE key='ai.calls.enabled' FOR SHARE`;
    if (signal.aborted) throw new Error("CANCELLED");
    if (
      (await tx.systemConfig.findUnique({ where: { key: "ai.calls.enabled" } }))?.valueJson !== true
    )
      throw new Error("FEATURE_DISABLED");
    if (candidate) {
      await loadGuardedKeyCandidate(tx, candidate);
    } else if (snapshot.provider.secretRef) {
      const key = await tx.apiKeyConfig.findUnique({ where: { id: snapshot.provider.secretRef } });
      if (key?.status !== "ACTIVE") throw new Error("CONFIG_ERROR");
    }
    const update = await tx.aiUsageReservation.updateMany({
      where: { id: reservation.id, status: "RESERVED", submissionState: "NOT_SENT" },
      data: { submissionState: "MAY_HAVE_BEEN_SENT" },
    });
    if (update.count !== 1) throw new Error("CONFIG_ERROR");
  });
}
async function persist(
  options: GuardedAiClientOptions,
  input: GuardedAiCallInput,
  snapshot: PromptModelSnapshot,
  reservation: AiUsageReservation,
  request: ProviderRequest,
  result: ProviderResult,
  internalCode?: string,
  unsent = false,
) {
  const success = result.ok && !internalCode;
  await options.db.$transaction(async (tx) => {
    const actualTokens = result.ok
      ? result.usage.inputTokens + result.usage.outputTokens
      : undefined;
    const actualCost = result.ok
      ? actualUsageCost(snapshot, result.usage.inputTokens, result.usage.outputTokens)
      : undefined;
    const settled =
      result.ok &&
      actualTokens! <= reservation.estimatedTokens &&
      actualCost!.lte(reservation.estimatedCost);
    const update = await tx.aiUsageReservation.updateMany({
      where: { id: reservation.id, status: { in: ["RESERVED", "RECONCILING"] } },
      data: unsent
        ? { status: "RELEASED", settledAt: new Date(options.clock?.() ?? Date.now()) }
        : settled
          ? {
              status: "SETTLED",
              submissionState: "ACCEPTED",
              actualTokens,
              actualCost,
              providerRequestId: result.providerRequestId,
              settledAt: new Date(options.clock?.() ?? Date.now()),
            }
          : { status: "RECONCILING", providerRequestId: result.providerRequestId },
    });
    if (update.count !== 1) throw new Error("CONFIG_ERROR");
    await tx.aiOutputRecord.create({
      data: {
        travelRecordId: input.travelRecordId ?? null,
        traceId: input.traceId,
        attemptNo: reservation.attemptNo,
        promptVersionId: snapshot.promptVersionId,
        activationRevision: snapshot.activationRevision,
        planningPolicyVersionId: snapshot.planningPolicyVersionId,
        deploymentId: snapshot.model.deploymentId,
        deploymentConfigVersion: snapshot.model.deploymentConfigVersion,
        providerId: snapshot.provider.providerId,
        providerConfigVersion: snapshot.provider.configVersion,
        inputHash: canonicalHash({
          request,
          planningPolicyVersionId: snapshot.planningPolicyVersionId,
          activationRevision: snapshot.activationRevision,
        }),
        outputHash: canonicalHash(result.ok ? result.output : { errorCode: result.errorCode }),
        rawOutput: null,
        parsedOk: success,
        status: success
          ? "SUCCEEDED"
          : !result.ok && result.errorCode === "CANCELLED"
            ? "CANCELLED"
            : "FAILED",
        errorCode: success
          ? null
          : (internalCode ??
            (!result.ok ? (result.internalCode ?? result.errorCode) : "PROVIDER_UNAVAILABLE")),
        errorMessage: success ? null : "Provider attempt failed.",
        inputTokens: result.ok ? result.usage.inputTokens : null,
        outputTokens: result.ok ? result.usage.outputTokens : null,
        durationMs: Math.max(0, Math.round(result.durationMs)),
      },
    });
  });
}
export async function callGuardedAi(
  input: GuardedAiCallInput,
  options: GuardedAiClientOptions,
): Promise<GuardedAiCallResult> {
  return executeGuardedAi(input, options);
}

export async function callGuardedKeyCandidate(
  input: GuardedAiCallInput,
  options: GuardedAiClientOptions,
  candidate: GuardedKeyCandidate,
): Promise<GuardedAiCallResult> {
  return executeGuardedAi(input, options, candidate);
}

async function executeGuardedAi(
  input: GuardedAiCallInput,
  options: GuardedAiClientOptions,
  candidate?: GuardedKeyCandidate,
): Promise<GuardedAiCallResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) controller.abort();
  const realStart = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const codeForAbort = () =>
    input.signal?.aborted ? ("CANCELLED" as const) : ("PROVIDER_TIMEOUT" as const);
  try {
    if (!(await isAiEnabled(options.db))) return safeError("FEATURE_DISABLED", input.traceId);
    if (controller.signal.aborted) return safeError(codeForAbort(), input.traceId);
    const snapshot = await options.db.$transaction(
      async (tx) => {
        const resolved = await resolvePromptSnapshot(tx, input.promptKey, input.variables);
        return candidate ? bindGuardedKeyCandidate(tx, resolved, candidate) : resolved;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 15000,
        timeout: 15000,
      },
    );
    await authorizeOwner(input, options, snapshot);
    const request = render(input, snapshot, Math.min(32768, options.maxUserMessageBytes ?? 32768));
    const requestBytes = Buffer.byteLength(
      canonicalJson({ ...request, model: snapshot.model.providerModelName }),
    );
    const estimate = estimateUsage(snapshot, requestBytes);
    const timeout = Math.min(snapshot.provider.timeoutMs, env.AI_TIMEOUT_MS);
    const deadlineAt = realStart + timeout;
    if (Date.now() >= deadlineAt) return safeError("PROVIDER_TIMEOUT", input.traceId);
    timer = setTimeout(abort, deadlineAt - Date.now());
    const context = { signal: controller.signal, deadlineAt };
    let mockAttempt = 0;
    for (
      let attemptNo = 1;
      attemptNo <= 1 + Math.min(1, snapshot.provider.maxRetries);
      attemptNo++
    ) {
      if (controller.signal.aborted) return safeError(codeForAbort(), input.traceId);
      if (!(await isAiEnabled(options.db))) return safeError("FEATURE_DISABLED", input.traceId);
      const resolution = await resolveProviderAdapter(
        options.db,
        {
          providerId: snapshot.provider.providerId,
          providerConfigVersion: snapshot.provider.configVersion,
          deploymentId: snapshot.model.deploymentId,
          deploymentConfigVersion: snapshot.model.deploymentConfigVersion,
          promptKey: input.promptKey,
        },
        { ...options, mockEvents: options.mockEvents?.slice(mockAttempt++) },
        candidate,
      );
      await resolution.adapter.prepare?.(context);
      if (controller.signal.aborted) return safeError(codeForAbort(), input.traceId);
      const reservation = await reserveUsage(options.db, snapshot, {
        traceId: input.traceId,
        attemptNo,
        requestBytes,
        now: options.clock?.() ?? Date.now(),
        costCap: Prisma.Decimal.min(
          String(env.AI_DAILY_COST_LIMIT),
          options.costCap ?? String(env.AI_DAILY_COST_LIMIT),
        ).toString(),
        signal: controller.signal,
      });
      try {
        await markSubmitted(options, reservation, snapshot, controller.signal, candidate);
      } catch (error) {
        await persist(
          options,
          input,
          snapshot,
          reservation,
          request,
          {
            ok: false,
            errorCode: controller.signal.aborted ? codeForAbort() : "CONFIG_ERROR",
            retryable: false,
            receivedByte: false,
            definitelyNotSent: true,
            durationMs: Date.now() - realStart,
          },
          error instanceof Error ? error.message : "CONFIG_ERROR",
          true,
        );
        throw error;
      }
      let result: ProviderResult;
      try {
        result = await resolution.adapter.complete(request, {
          signal: controller.signal,
          deadlineAt,
        });
      } catch {
        result = {
          ok: false,
          errorCode: controller.signal.aborted ? codeForAbort() : "PROVIDER_UNAVAILABLE",
          retryable: false,
          receivedByte: false,
          durationMs: Date.now() - realStart,
        };
      }
      if (controller.signal.aborted)
        result = {
          ok: false,
          errorCode: codeForAbort(),
          retryable: false,
          receivedByte: result.receivedByte,
          durationMs: Date.now() - realStart,
          providerRequestId: result.providerRequestId,
        };
      let output: unknown, internalCode: string | undefined;
      if (result.ok) {
        try {
          if (
            result.usage.inputTokens > estimate.inputTokens ||
            result.usage.outputTokens > estimate.outputTokens ||
            !Number.isSafeInteger(result.usage.inputTokens) ||
            !Number.isSafeInteger(result.usage.outputTokens) ||
            result.usage.inputTokens < 0 ||
            result.usage.outputTokens < 0 ||
            Buffer.byteLength(result.output) > Math.min(options.maxOutputBytes ?? 262144, 262144)
          )
            throw new Error("SCHEMA_MISMATCH");
          output = parsePromptResponse(input.promptKey, result.output);
        } catch (error) {
          internalCode =
            error instanceof Error && ["INVALID_JSON", "SCHEMA_MISMATCH"].includes(error.message)
              ? error.message
              : "SCHEMA_MISMATCH";
        }
      }
      try {
        await persist(options, input, snapshot, reservation, request, result, internalCode);
      } catch {
        await options.db.aiUsageReservation
          .updateMany({
            where: { id: reservation.id, status: "RESERVED" },
            data: { status: "RECONCILING" },
          })
          .catch(() => {});
        return safeError("PROVIDER_UNAVAILABLE", input.traceId);
      }
      if (result.ok)
        return internalCode
          ? safeError("PROVIDER_UNAVAILABLE", input.traceId)
          : {
              ok: true,
              traceId: input.traceId,
              attemptNo,
              output,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              durationMs: Date.now() - realStart,
              retryable: false,
              safeMessage: "AI call completed.",
            };
      const retry =
        attemptNo === 1 &&
        snapshot.provider.maxRetries > 0 &&
        result.retryable &&
        !result.receivedByte &&
        ["RATE_LIMITED", "PROVIDER_UNAVAILABLE"].includes(result.errorCode) &&
        !controller.signal.aborted;
      if (!retry)
        return safeError(result.errorCode, input.traceId, result.retryable && !result.receivedByte);
      const wait = Math.max(
        result.retryAfterMs ?? 0,
        Math.max(0, Math.min(100, options.jitter?.() ?? 25)),
      );
      if (Date.now() + wait >= deadlineAt) return safeError("PROVIDER_TIMEOUT", input.traceId);
      try {
        await delay(wait, undefined, { signal: controller.signal });
      } catch {
        return safeError(codeForAbort(), input.traceId);
      }
    }
    return safeError("PROVIDER_UNAVAILABLE", input.traceId);
  } catch (error) {
    const code = error instanceof Error ? error.message : "CONFIG_ERROR";
    if (controller.signal.aborted) return safeError(codeForAbort(), input.traceId);
    return safeError(
      ["FEATURE_DISABLED", "RATE_LIMITED", "COST_LIMIT", "CANCELLED", "CONFIG_ERROR"].includes(code)
        ? (code as AiErrorCode)
        : "CONFIG_ERROR",
      input.traceId,
    );
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
  }
}
