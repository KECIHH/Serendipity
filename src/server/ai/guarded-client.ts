import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { Prisma, type PrismaClient, type AiUsageReservation } from "@prisma/client";
import { env } from "@/lib/env";
import { authorizeWorkerCommand } from "@/server/chat/ownership";
import { assertTaskLease, type TaskLease } from "@/server/tasks/durable-task";
import type { AiErrorCode, ProviderResult, ProviderRequest } from "@/lib/ai/provider";
import { canonicalHash } from "@/server/ai/canonical-hash";
import {
  canonicalJson,
  parsePromptVariables,
  parsePromptResponse,
  promptKeyContract,
  PromptOutputSchemas,
} from "@/lib/ai/schemas";
import {
  validatePromptReferences,
  type PromptKey,
  type PromptInputMap,
  type PromptOutputMap,
} from "@/lib/ai/schemas";
import {
  assertNluContext,
  nluRemainingMilliseconds,
  reserveNluBudget,
  type NluContext,
} from "./nlu-context";
import { captureAiOutput, type AiCapturePolicy } from "./capture-policy";
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
  readonly commandId?: string;
  readonly attemptNo?: number;
  readonly onDelta?: (text: string) => Promise<void>;
}
export type GuardedAiCallResult =
  | {
      readonly ok: true;
      readonly traceId: string;
      readonly attemptNo: number;
      readonly output: unknown;
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      readonly durationMs: number;
      readonly retryable: false;
      readonly safeMessage: string;
    }
  | {
      readonly ok: false;
      readonly traceId: string;
      readonly errorCode: AiErrorCode;
      readonly attemptNo?: number;
      readonly internalCode?: "INVALID_JSON" | "SCHEMA_MISMATCH" | "VALIDATION_ERROR";
      readonly retryable: boolean;
      readonly safeMessage: string;
    };
export type AiOwnerContext =
  | { readonly kind: "SYNTHETIC"; readonly runId: string }
  | { readonly kind: "COMMAND"; readonly commandId: string; readonly lease: TaskLease }
  | { readonly kind: "USER"; readonly userId: string; readonly privateInputAllowed: boolean };
export interface GuardedAiClientOptions extends ProviderRegistryOptions {
  readonly db: PrismaClient;
  readonly owner?: AiOwnerContext;
  readonly clock?: () => number;
  readonly maxUserMessageBytes?: number;
  readonly maxOutputBytes?: number;
  readonly jitter?: () => number;
  readonly costCap?: string;
  readonly validateOutput?: (output: unknown) => unknown;
  readonly nluContext?: NluContext;
  readonly capturePolicy?: AiCapturePolicy;
  readonly onDebugCapture?: (text: string) => void;
  /** Ephemeral server memory only. This callback never changes the persisted result. */
  readonly onInvalidOutput?: (rawText: string, attemptNo: number) => void;
}

interface FailedJsonAttempt {
  readonly promptKey: string;
  readonly schemaId: string;
  readonly variablesHash: string;
  readonly outputHash: string;
  claimed: boolean;
}
const failedJsonAttempts = new WeakMap<NluContext, Map<number, FailedJsonAttempt>>();
/** Consume an ephemeral receipt created only after this exact context persisted its failed call. */
export function claimOriginalJsonAttempt(
  context: NluContext,
  attemptNo: number,
  binding: Omit<FailedJsonAttempt, "claimed">,
): boolean {
  assertNluContext(context);
  const recorded = failedJsonAttempts.get(context)?.get(attemptNo);
  if (
    !recorded ||
    recorded.claimed ||
    recorded.promptKey !== binding.promptKey ||
    recorded.schemaId !== binding.schemaId ||
    recorded.variablesHash !== binding.variablesHash ||
    recorded.outputHash !== binding.outputHash
  )
    return false;
  recorded.claimed = true;
  return true;
}

async function authorizeCommandCall(
  tx: Prisma.TransactionClient,
  input: GuardedAiCallInput,
  options: GuardedAiClientOptions,
) {
  if (options.owner?.kind !== "COMMAND") {
    if (input.commandId) throw new Error("CONFIG_ERROR");
    return;
  }
  const { command } = await authorizeWorkerCommand(tx, options.owner.commandId);
  const task = await assertTaskLease(tx, options.owner.lease);
  if (
    input.commandId !== command.id ||
    input.travelRecordId !== command.travelRecordId ||
    input.traceId !== command.traceId ||
    command.status !== "RUNNING" ||
    task.commandId !== command.id
  )
    throw new Error("CONFIG_ERROR");
}
function safeError(
  errorCode: AiErrorCode,
  traceId: string,
  retryable = false,
): Extract<GuardedAiCallResult, { ok: false }> {
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
  if (owner.kind === "COMMAND") {
    await options.db.$transaction((tx) => authorizeCommandCall(tx, input, options));
    // The current bootstrap policy permits synthetic data only. Owning a command does
    // not turn private production input into synthetic input or bypass that policy.
    const [identity] = await options.db.$queryRaw<Array<{ name: string; marker: string | null }>>`
      SELECT current_database() AS name,shobj_description(oid,'pg_database') AS marker
      FROM pg_database WHERE datname=current_database()`;
    if (
      snapshot.planningPolicy.scope === "SYNTHETIC_ONLY" &&
      (!/^phase\d{3}_disposable_[a-f0-9]{12}$/.test(identity.name) ||
        identity.marker !==
          `serendipity-phase${identity.name.slice(5, 8)}-disposable:${identity.name.slice(-12)}`)
    )
      throw new Error("CONFIG_ERROR");
  } else if (owner.kind === "SYNTHETIC") {
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
  input?: GuardedAiCallInput,
) {
  await options.db.$transaction(async (tx) => {
    if (input) await authorizeCommandCall(tx, input, options);
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
    if (options.owner?.kind === "COMMAND") {
      // Authorization and the live lease were checked before reserving/submitting this call.
      // Accounting for that reservation must survive cancellation or lease expiry. This path
      // can only append its attempt and settle its own budget; it cannot authorize new work.
      const stored = await tx.aiUsageReservation.findUnique({ where: { id: reservation.id } });
      const command = await tx.chatCommand.findUnique({ where: { id: options.owner.commandId } });
      const task = await tx.durableTask.findUnique({ where: { id: options.owner.lease.taskId } });
      if (
        !stored ||
        stored.traceId !== input.traceId ||
        stored.attemptNo !== reservation.attemptNo ||
        stored.bucketKey !== reservation.bucketKey ||
        !command ||
        command.id !== input.commandId ||
        command.traceId !== input.traceId ||
        command.travelRecordId !== input.travelRecordId ||
        !task ||
        task.commandId !== command.id ||
        task.fencingToken < options.owner.lease.fencingToken
      )
        throw new Error("CONFIG_ERROR");
    } else await authorizeCommandCall(tx, input, options);
    const actualTokens =
      result.ok && result.usage ? result.usage.inputTokens + result.usage.outputTokens : undefined;
    const actualCost =
      result.ok && result.usage
        ? actualUsageCost(snapshot, result.usage.inputTokens, result.usage.outputTokens)
        : undefined;
    const settled =
      result.ok &&
      result.usage !== null &&
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
        commandId: input.commandId ?? null,
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
        inputTokens: result.ok ? (result.usage?.inputTokens ?? null) : null,
        outputTokens: result.ok ? (result.usage?.outputTokens ?? null) : null,
        durationMs: Math.max(0, Math.round(result.durationMs)),
      },
    });
  });
}

async function persistAdmissionFailure(
  options: GuardedAiClientOptions,
  input: GuardedAiCallInput,
  snapshot: PromptModelSnapshot,
  request: ProviderRequest,
  attemptNo: number,
  errorCode: string,
  started: number,
) {
  if (options.owner?.kind !== "COMMAND") return;
  await options.db.$transaction(async (tx) => {
    await authorizeCommandCall(tx, input, options);
    await tx.aiOutputRecord.create({
      data: {
        commandId: input.commandId,
        travelRecordId: input.travelRecordId,
        traceId: input.traceId,
        attemptNo,
        promptVersionId: snapshot.promptVersionId,
        activationRevision: snapshot.activationRevision,
        planningPolicyVersionId: snapshot.planningPolicyVersionId,
        deploymentId: snapshot.model.deploymentId,
        deploymentConfigVersion: snapshot.model.deploymentConfigVersion,
        providerId: snapshot.provider.providerId,
        providerConfigVersion: snapshot.provider.configVersion,
        inputHash: canonicalHash(request),
        outputHash: canonicalHash({ errorCode }),
        rawOutput: null,
        parsedOk: false,
        status: "FAILED",
        errorCode,
        errorMessage: "Provider attempt was not sent.",
        durationMs: Math.max(0, Date.now() - started),
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

export interface GuardedJsonChatInput<K extends PromptKey> {
  readonly promptKey: K;
  readonly variables: PromptInputMap[K];
  readonly userMessage: string;
  readonly context: NluContext;
  readonly travelRecordId?: string;
  readonly commandId?: string;
  readonly attemptNo?: number;
}
/** Phase017+ typed entry point. All calls share the certified request context. */
export async function guardedJsonChat<K extends PromptKey>(
  input: GuardedJsonChatInput<K>,
  options: Omit<GuardedAiClientOptions, "owner" | "nluContext">,
): Promise<GuardedAiCallResult> {
  let variables: PromptInputMap[K];
  try {
    assertNluContext(input.context);
    const scalars = input.variables as Readonly<Record<string, unknown>>;
    if (
      scalars.locale !== input.context.locale ||
      (Object.hasOwn(scalars, "serverDate") && scalars.serverDate !== input.context.serverDate) ||
      (Object.hasOwn(scalars, "timezone") && scalars.timezone !== input.context.timezone)
    )
      throw new Error("CONFIG_ERROR");
    variables = parsePromptVariables(input.promptKey, scalars) as unknown as PromptInputMap[K];
  } catch (error) {
    const code =
      error instanceof Error && ["CANCELLED", "PROVIDER_TIMEOUT"].includes(error.message)
        ? (error.message as AiErrorCode)
        : "CONFIG_ERROR";
    return safeError(code, input.context?.traceId ?? "unavailable");
  }
  return executeGuardedAi(
    {
      ...input,
      variables: variables as Readonly<Record<string, unknown>>,
      traceId: input.context.traceId,
      signal: input.context.signal,
    },
    {
      ...options,
      owner: input.context.ownerContext,
      nluContext: input.context,
      validateOutput(output) {
        validatePromptReferences(input.promptKey, variables, output as PromptOutputMap[K]);
        return options.validateOutput ? options.validateOutput(output) : output;
      },
    },
  );
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
    if (options.nluContext) {
      assertNluContext(options.nluContext);
      if (
        input.signal !== options.nluContext.signal ||
        input.traceId !== options.nluContext.traceId ||
        options.owner !== options.nluContext.ownerContext
      )
        throw new Error("CONFIG_ERROR");
    }
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
    const deadlineAt = Math.min(
      realStart + timeout,
      options.nluContext ? Date.now() + nluRemainingMilliseconds(options.nluContext) : Infinity,
    );
    if (Date.now() >= deadlineAt) return safeError("PROVIDER_TIMEOUT", input.traceId);
    timer = setTimeout(abort, deadlineAt - Date.now());
    const context = { signal: controller.signal, deadlineAt };
    let mockAttempt = 0;
    const firstAttempt = input.attemptNo ?? 1;
    if (!Number.isSafeInteger(firstAttempt) || firstAttempt < 1) throw new Error("CONFIG_ERROR");
    for (
      let attemptNo = firstAttempt;
      attemptNo <=
      firstAttempt +
        (input.promptKey === "planner.repair_json" ? 0 : Math.min(1, snapshot.provider.maxRetries));
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
      let reservation: AiUsageReservation;
      let requestBudget: ReturnType<typeof reserveNluBudget> | undefined;
      try {
        if (options.nluContext)
          requestBudget = reserveNluBudget(
            options.nluContext,
            estimate.estimatedTokens,
            estimate.estimatedCost,
          );
        reservation = await reserveUsage(options.db, snapshot, {
          traceId: input.traceId,
          attemptNo,
          requestBytes,
          now: options.clock?.() ?? Date.now(),
          costCap: Prisma.Decimal.min(
            String(env.AI_DAILY_COST_LIMIT),
            options.costCap ?? String(env.AI_DAILY_COST_LIMIT),
          ).toString(),
          signal: controller.signal,
          authorize: (tx) => authorizeCommandCall(tx, input, options),
        });
      } catch (error) {
        requestBudget?.settle({ tokens: 0, cost: new Prisma.Decimal(0) });
        const code = error instanceof Error ? error.message : "CONFIG_ERROR";
        if (["COST_LIMIT", "RATE_LIMITED"].includes(code))
          await persistAdmissionFailure(
            options,
            input,
            snapshot,
            request,
            attemptNo,
            code,
            realStart,
          );
        throw error;
      }
      try {
        await markSubmitted(options, reservation, snapshot, controller.signal, candidate, input);
      } catch (error) {
        requestBudget?.settle({ tokens: 0, cost: new Prisma.Decimal(0) });
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
      const attemptStart = Date.now();
      try {
        result = await resolution.adapter.complete(request, {
          signal: controller.signal,
          deadlineAt,
          onDelta: input.onDelta
            ? async (text) => {
                if (controller.signal.aborted) return;
                if (
                  typeof text !== "string" ||
                  !text.isWellFormed() ||
                  Buffer.byteLength(text) > 262144
                )
                  throw new Error("SCHEMA_MISMATCH");
                await input.onDelta!(text);
              }
            : undefined,
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
      result = { ...result, durationMs: Math.max(0, Date.now() - attemptStart) };
      let output: unknown, internalCode: string | undefined;
      if (result.ok) {
        const capture = captureAiOutput(
          result.output,
          options.capturePolicy,
          options.owner?.kind === "SYNTHETIC" && snapshot.provider.mode === "MOCK",
        );
        if (capture !== null) {
          // Optional diagnostics cannot interrupt append-only accounting for an external call.
          try {
            options.onDebugCapture?.(capture);
          } catch {
            /* Deliberately omit callback contents and exceptions from logs. */
          }
        }
        try {
          if (
            (result.usage !== null &&
              (result.usage.inputTokens > estimate.inputTokens ||
                result.usage.outputTokens > estimate.outputTokens ||
                !Number.isSafeInteger(result.usage.inputTokens) ||
                !Number.isSafeInteger(result.usage.outputTokens) ||
                result.usage.inputTokens < 0 ||
                result.usage.outputTokens < 0)) ||
            Buffer.byteLength(result.output) > Math.min(options.maxOutputBytes ?? 262144, 262144)
          )
            throw new Error("SCHEMA_MISMATCH");
          output = parsePromptResponse(input.promptKey, result.output);
          if (options.validateOutput) output = options.validateOutput(output);
        } catch (error) {
          internalCode =
            error instanceof Error &&
            ["INVALID_JSON", "SCHEMA_MISMATCH", "VALIDATION_ERROR"].includes(error.message)
              ? error.message
              : "SCHEMA_MISMATCH";
        }
      }
      if (
        result.ok &&
        result.usage &&
        Number.isSafeInteger(result.usage.inputTokens) &&
        Number.isSafeInteger(result.usage.outputTokens) &&
        result.usage.inputTokens >= 0 &&
        result.usage.outputTokens >= 0 &&
        result.usage.inputTokens <= estimate.inputTokens &&
        result.usage.outputTokens <= estimate.outputTokens
      )
        requestBudget?.settle({
          tokens: result.usage.inputTokens + result.usage.outputTokens,
          cost: actualUsageCost(snapshot, result.usage.inputTokens, result.usage.outputTokens),
        });
      else {
        requestBudget?.settle();
        if (result.ok && result.usage) result = { ...result, usage: null };
      }
      try {
        await persist(options, input, snapshot, reservation, request, result, internalCode);
      } catch {
        if (options.owner?.kind !== "COMMAND")
          await options.db.aiUsageReservation
            .updateMany({
              where: { id: reservation.id, status: "RESERVED" },
              data: { status: "RECONCILING" },
            })
            .catch(() => {});
        return safeError("PROVIDER_UNAVAILABLE", input.traceId);
      }
      if (result.ok) {
        if (
          options.nluContext &&
          input.promptKey !== "planner.repair_json" &&
          (internalCode === "INVALID_JSON" || internalCode === "SCHEMA_MISMATCH")
        ) {
          const attempts =
            failedJsonAttempts.get(options.nluContext) ?? new Map<number, FailedJsonAttempt>();
          attempts.set(attemptNo, {
            promptKey: input.promptKey,
            schemaId: PromptOutputSchemas[promptKeyContract(input.promptKey).key].schemaId,
            variablesHash: canonicalHash(input.variables),
            outputHash: canonicalHash(result.output),
            claimed: false,
          });
          failedJsonAttempts.set(options.nluContext, attempts);
        }
        if (internalCode && options.onInvalidOutput)
          options.onInvalidOutput(result.output, attemptNo);
        return internalCode
          ? {
              ...safeError("PROVIDER_UNAVAILABLE", input.traceId),
              ok: false,
              errorCode: "PROVIDER_UNAVAILABLE",
              attemptNo,
              internalCode: internalCode as "INVALID_JSON" | "SCHEMA_MISMATCH" | "VALIDATION_ERROR",
            }
          : {
              ok: true,
              traceId: input.traceId,
              attemptNo,
              output,
              inputTokens: result.usage?.inputTokens ?? null,
              outputTokens: result.usage?.outputTokens ?? null,
              durationMs: Date.now() - realStart,
              retryable: false,
              safeMessage: "AI call completed.",
            };
      }
      const retry =
        attemptNo === firstAttempt &&
        snapshot.provider.maxRetries > 0 &&
        input.promptKey !== "planner.repair_json" &&
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
      [
        "FEATURE_DISABLED",
        "RATE_LIMITED",
        "COST_LIMIT",
        "CANCELLED",
        "PROVIDER_TIMEOUT",
        "CONFIG_ERROR",
      ].includes(code)
        ? (code as AiErrorCode)
        : "CONFIG_ERROR",
      input.traceId,
    );
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
  }
}
