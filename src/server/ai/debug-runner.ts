import "server-only";
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  AI_DEBUG_MAX_RAW_OUTPUT_CHARS,
  parseAiDebugRequest,
  type AiDebugFailureProfile,
  type AiDebugSummaryDto,
  type AiDebugDiagnosticCategory,
} from "@/lib/ai-debug";
import {
  canonicalJson,
  PromptOutputSchemas,
  promptKeyContract,
  type PromptKey,
} from "@/lib/ai/schemas";
import { safeParseAiJson } from "@/lib/ai/json-parser";
import type { RuntimeSchema } from "@/lib/ai/schema-validation";
import type { AiErrorCode } from "@/lib/ai/provider";
import type { MockFailureMode } from "@/server/ai/mock-provider";
import { createNluContext, type NluContext } from "@/server/ai/nlu-context";
import { guardedJsonChat, type GuardedAiCallResult } from "@/server/ai/guarded-client";
import { repairJsonWithAi } from "@/server/ai/json-repair";
import { assertTaskLease, saveTaskCheckpoint, TaskLeaseLost } from "@/server/tasks/durable-task";
import type { TaskHandler } from "@/server/tasks/dispatcher";
import { readTaskPayload } from "@/server/tasks/payload";

export const AI_DEBUG_TIMEOUT_MS = 30_000;
export const AI_DEBUG_ATTEMPT_BOUND = 8;
export const AI_DEBUG_STATUSES_TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED"] as const;

const syntheticDatabase = /^phase\d{3}_disposable_[a-f0-9]{12}$/;
export const debugOwnerKeyHash = (adminUserId: string): string =>
  createHash("sha256").update(`ai-debug:${adminUserId}`, "utf8").digest("hex");

/** Only the eight documented Mock profiles plus the repair and budget boundaries are selectable. */
const MOCK_MODE: Record<AiDebugFailureProfile, MockFailureMode | undefined> = {
  success: "success",
  timeout: "timeout",
  rate_limit: "rate_limit",
  server_error: "server_error",
  invalid_json: "invalid_json",
  schema_mismatch: "schema_mismatch",
  network_error: "network_error",
  cancel: "cancel",
  cost: undefined,
  repair: undefined,
};

// The debug worker resolves its Prompt key at runtime, so the typed generic entry points are
// narrowed once here instead of at every call site.
type DeltaRelay = (text: string) => Promise<void>;
type JsonChatInput = {
  promptKey: PromptKey;
  variables: Record<string, unknown>;
  userMessage: string;
  context: NluContext;
  attemptNo?: number;
  onDelta?: DeltaRelay;
};
type JsonChatOptions = Parameters<typeof guardedJsonChat<PromptKey>>[1];
const jsonChat = guardedJsonChat as unknown as (
  input: JsonChatInput,
  options: JsonChatOptions,
) => Promise<GuardedAiCallResult>;
type RepairOutcome =
  | { readonly ok: true; readonly data: unknown; readonly repairAttempts: number }
  | {
      readonly ok: false;
      readonly errorCode: string;
      readonly internalCode?: string;
      readonly repairAttempts: number;
    };
const repairJson = repairJsonWithAi as unknown as (
  rawText: string,
  errors: unknown,
  context: unknown,
) => Promise<RepairOutcome>;

interface AttemptRecord {
  readonly id: string;
  readonly attemptNo: number;
  readonly parsedOk: boolean;
  readonly status: string;
  readonly errorCode: string | null;
  readonly promptVersionId: string;
  readonly deploymentId: string;
  readonly deploymentConfigVersion: number;
  readonly providerId: string;
  readonly providerConfigVersion: number;
}

async function loadAttempts(client: PrismaClient, traceId: string): Promise<AttemptRecord[]> {
  const rows = await client.aiOutputRecord.findMany({
    where: { traceId },
    orderBy: { attemptNo: "asc" },
    select: {
      id: true,
      attemptNo: true,
      parsedOk: true,
      status: true,
      errorCode: true,
      promptVersionId: true,
      deploymentId: true,
      deploymentConfigVersion: true,
      providerId: true,
      providerConfigVersion: true,
    },
  });
  if (rows.length > AI_DEBUG_ATTEMPT_BOUND) throw new Error("CONFIG_ERROR");
  return rows;
}

async function buildSummary(
  client: PrismaClient,
  attempts: readonly AttemptRecord[],
  rawOutput: string | null,
  parsedData: unknown | null,
  diagnosticCategory: AiDebugDiagnosticCategory | null,
  issuePaths: readonly string[],
): Promise<AiDebugSummaryDto | null> {
  const last = attempts.at(-1);
  if (!last) return null;
  const version = await client.promptVersion.findUnique({
    where: { id: last.promptVersionId },
    select: { contentHash: true },
  });
  if (!version || !/^[a-f0-9]{64}$/.test(version.contentHash)) throw new Error("CONFIG_ERROR");
  return Object.freeze({
    promptVersionId: last.promptVersionId,
    promptHash: version.contentHash,
    deploymentId: last.deploymentId,
    deploymentConfigVersion: last.deploymentConfigVersion,
    providerId: last.providerId,
    providerConfigVersion: last.providerConfigVersion,
    rawOutput:
      rawOutput === null
        ? null
        : Array.from(rawOutput).slice(0, AI_DEBUG_MAX_RAW_OUTPUT_CHARS).join(""),
    parsedData: parsedData ?? null,
    schemaValidation: Object.freeze({
      valid: last.parsedOk,
      diagnosticCategory,
      issuePaths: Object.freeze([...issuePaths]),
    }),
    aiOutputRecordId: last.id,
  }) as AiDebugSummaryDto;
}

function serverVariables(
  promptKey: string,
  supplied: Readonly<Record<string, unknown>>,
  context: { readonly locale: string; readonly timezone: string; readonly serverDate: string },
): Record<string, unknown> {
  const names = new Set(promptKeyContract(promptKey).variables.map((item) => item.name));
  const variables: Record<string, unknown> = { ...supplied };
  // Locale, timezone and server date are always server-authoritative, never caller claims.
  if (names.has("locale")) variables.locale = context.locale;
  if (names.has("timezone")) variables.timezone = context.timezone;
  if (names.has("serverDate")) variables.serverDate = context.serverDate;
  return variables;
}

export interface AiDebugExecution {
  readonly runId: string;
  readonly taskId: string;
  readonly leaseOwner: string;
  readonly fencingToken: number;
  readonly signal: AbortSignal;
  readonly onDelta?: DeltaRelay;
}

/**
 * The single Phase018 debug execution. It consumes the persisted run, calls the Phase015
 * guarded client and only ever associates the AiOutputRecord attempts that client wrote.
 * An interrupted (aborted) execution leaves the run open for the next worker.
 */
export async function executeAiDebug(
  client: PrismaClient,
  execution: AiDebugExecution,
): Promise<
  { ok: true; resultRef?: string } | { ok: false; retryable?: boolean; errorCategory: string }
> {
  const lease = {
    taskId: execution.taskId,
    leaseOwner: execution.leaseOwner,
    fencingToken: execution.fencingToken,
  };
  const run = await client.aiDebugRun.findUnique({ where: { id: execution.runId } });
  if (!run || run.taskId !== execution.taskId)
    return { ok: false, retryable: false, errorCategory: "CONFIG_ERROR" };
  if ((AI_DEBUG_STATUSES_TERMINAL as readonly string[]).includes(run.status))
    return { ok: true, resultRef: run.id };
  const [identity] = await client.$queryRaw<Array<{ name: string }>>`
    SELECT current_database() AS name`;
  if (!syntheticDatabase.test(identity.name))
    return { ok: false, retryable: false, errorCategory: "CONFIG_ERROR" };

  let request: ReturnType<typeof parseAiDebugRequest>;
  try {
    request = await client.$transaction(async (tx) => {
      const current = await assertTaskLease(tx, lease);
      const stored = (await readTaskPayload(tx, {
        payloadRef: current.payloadRef,
        payloadHash: current.payloadHash,
        payloadSchemaVersion: current.payloadSchemaVersion,
        ownerKeyHash: debugOwnerKeyHash(run.adminUserId),
      })) as unknown;
      const parsed = parseAiDebugRequest(stored);
      await tx.aiDebugRun.updateMany({
        where: { id: run.id, status: "PENDING" },
        data: { status: "RUNNING" },
      });
      await saveTaskCheckpoint(tx, lease, {
        ...(current.checkpointJson as Prisma.InputJsonObject),
        version: 1,
        stage: "CALLING",
        promptKey: parsed.promptKey,
        failureProfile: parsed.failureProfile,
      });
      return parsed;
    });
  } catch (error) {
    if (error instanceof TaskLeaseLost) throw error;
    return { ok: false, retryable: false, errorCategory: "CONFIG_ERROR" };
  }
  // A lost first response must not spend a Provider call; the run stays resumable.
  if (execution.signal.aborted) return { ok: false, retryable: true, errorCategory: "INTERRUPTED" };

  const startedAt = Date.now();
  const budgetProfile = request.failureProfile === "cost";
  const context = createNluContext(
    {
      timezone:
        typeof request.variables.timezone === "string"
          ? request.variables.timezone
          : "Asia/Shanghai",
      locale: typeof request.variables.locale === "string" ? request.variables.locale : "zh-CN",
      planningMode: "quick",
      ownerContext: { kind: "SYNTHETIC", runId: identity.name },
      traceId: run.traceId,
      requestId: `request_${run.id}`,
      signal: execution.signal,
      deadlineAt: startedAt + AI_DEBUG_TIMEOUT_MS,
      tokenBudget: budgetProfile ? 1 : 1_000_000,
      costBudget: budgetProfile ? "0" : "5",
    },
    () => Date.now(),
  );
  const variables = serverVariables(request.promptKey, request.variables, context);
  const promptKey = request.promptKey as PromptKey;
  const captured: { text: string | null } = { text: null };
  const baseOptions = {
    db: client,
    mockProfileVerified: true,
    capturePolicy: { mode: "SYNTHETIC_DEBUG" as const, maxChars: AI_DEBUG_MAX_RAW_OUTPUT_CHARS },
    onDebugCapture: (text: string) => {
      captured.text = text;
    },
  };
  const userMessage = canonicalJson(variables);
  // A reclaimed task continues with a fresh attempt number; identity is never reused.
  const existing = await loadAttempts(client, run.traceId);
  const firstAttempt = (existing.at(-1)?.attemptNo ?? 0) + 1;

  let result: GuardedAiCallResult;
  let parsedData: unknown | null = null;
  let diagnosticCategory: AiDebugDiagnosticCategory | null = null;
  let issuePaths: readonly string[] = [];
  try {
    if (request.failureProfile === "repair") {
      const repaired = canonicalJson(promptKeyContract(promptKey).fixtureOutput);
      const broken = repaired.slice(0, -1);
      const target = PromptOutputSchemas[promptKey] as RuntimeSchema<unknown>;
      const first = await jsonChat(
        {
          promptKey,
          variables,
          userMessage,
          context,
          attemptNo: firstAttempt,
          onDelta: execution.onDelta,
        },
        { ...baseOptions, mockOutput: broken },
      );
      const parseFailure = safeParseAiJson(broken, target);
      if (first.ok || parseFailure.ok) {
        result = {
          ok: false,
          traceId: run.traceId,
          errorCode: "CONFIG_ERROR",
          retryable: false,
          safeMessage: "AI configuration is unavailable.",
        };
      } else {
        const repair = await repairJson(broken, parseFailure, {
          nluContext: context,
          targetSchema: target,
          originalAttemptNo: firstAttempt,
          originalPromptKey: promptKey,
          originalVariables: variables,
          clientOptions: {
            ...baseOptions,
            mockOutput: canonicalJson({ schemaVersion: 1, repairedText: repaired }),
          },
        });
        if (repair.ok) {
          parsedData = repair.data;
          result = {
            ok: true,
            traceId: run.traceId,
            attemptNo: firstAttempt + repair.repairAttempts,
            output: repair.data,
            inputTokens: null,
            outputTokens: null,
            durationMs: Date.now() - startedAt,
            retryable: false,
            safeMessage: "AI call completed.",
          };
        } else {
          diagnosticCategory =
            repair.internalCode === "INVALID_JSON" || repair.internalCode === "SCHEMA_MISMATCH"
              ? repair.internalCode
              : null;
          result = {
            ok: false,
            traceId: run.traceId,
            errorCode: repair.errorCode as AiErrorCode,
            retryable: false,
            safeMessage: "The AI provider is unavailable.",
          };
        }
      }
    } else {
      result = await jsonChat(
        {
          promptKey,
          variables,
          userMessage,
          context,
          attemptNo: firstAttempt,
          onDelta: execution.onDelta,
        },
        { ...baseOptions, mockFailureMode: MOCK_MODE[request.failureProfile] },
      );
      if (result.ok) parsedData = result.output;
      else if (
        result.internalCode === "INVALID_JSON" ||
        result.internalCode === "SCHEMA_MISMATCH"
      ) {
        diagnosticCategory = result.internalCode;
        if (captured.text !== null) {
          const parsed = safeParseAiJson(
            captured.text,
            PromptOutputSchemas[promptKey] as RuntimeSchema<unknown>,
          );
          if (!parsed.ok)
            issuePaths = parsed.details
              .slice(0, 32)
              .map((issue) => (typeof issue.path === "string" ? issue.path : "$"));
        }
      }
    }
  } catch {
    result = {
      ok: false,
      traceId: run.traceId,
      errorCode: "CONFIG_ERROR",
      retryable: false,
      safeMessage: "AI configuration is unavailable.",
    };
  }
  // A transport interruption is not a domain outcome: keep the run open for the next worker.
  if (execution.signal.aborted) return { ok: false, retryable: true, errorCategory: "INTERRUPTED" };

  const attempts = await loadAttempts(client, run.traceId);
  const status: "SUCCEEDED" | "FAILED" | "CANCELLED" = result.ok
    ? "SUCCEEDED"
    : result.errorCode === "CANCELLED"
      ? "CANCELLED"
      : "FAILED";
  const errorCode: string | null = result.ok ? null : (diagnosticCategory ?? result.errorCode);
  const summary =
    status === "SUCCEEDED"
      ? await buildSummary(
          client,
          attempts,
          captured.text,
          parsedData,
          diagnosticCategory,
          issuePaths,
        )
      : null;
  const attemptIds = attempts.map((row) => row.id);
  if (!attemptIds.every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id)))
    return { ok: false, retryable: false, errorCategory: "CONFIG_ERROR" };

  await client.$transaction(async (tx) => {
    await assertTaskLease(tx, lease);
    await tx.aiDebugRun.updateMany({
      where: { id: run.id, status: "RUNNING" },
      data: {
        status,
        attemptIdsJson: attemptIds,
        finalSummaryJson:
          summary === null ? Prisma.DbNull : (summary as unknown as Prisma.InputJsonObject),
        errorCode,
        completedAt: new Date(),
      },
    });
  });
  return { ok: true, resultRef: run.id };
}

/** The AI_DEBUG task is keyed by its Phase012 receipt, so callers resolve it from the run. */
export async function debugTaskAggregateId(client: PrismaClient, runId: string): Promise<string> {
  const run = await client.aiDebugRun.findUnique({
    where: { id: runId },
    select: { idempotencyReceiptId: true },
  });
  if (!run) throw new Error("NOT_FOUND");
  return run.idempotencyReceiptId;
}

/** The stream path relays transient deltas; the worker path persists only the final aggregate. */
export function debugTaskHandler(onDelta?: DeltaRelay): TaskHandler {
  return async (client, { task, lease, signal }) => {
    const run = await client.aiDebugRun.findUnique({
      where: { taskId: task.id },
      select: { id: true },
    });
    if (!run) return { ok: false, retryable: false, errorCategory: "CONFIG_ERROR" };
    return executeAiDebug(client, {
      runId: run.id,
      taskId: task.id,
      leaseOwner: lease.leaseOwner,
      fencingToken: lease.fencingToken,
      signal,
      onDelta,
    });
  };
}

export const processAiDebugTask: TaskHandler = debugTaskHandler();
