import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { ok } from "@/lib/api-response";
import { validScalarFormat } from "@/lib/ai/schema-validation";
import type { TravelRequirement } from "@/lib/ai/schema-types";
import type { MockFailureMode } from "@/server/ai/mock-provider";
import { createNluContext } from "@/server/ai/nlu-context";
import { env } from "@/lib/env";
import { assertSameOrigin } from "@/server/auth/cookie";
import { db as appDb, DatabaseUnavailableError } from "@/server/db";
import { ChatCommandError, isChatErrorCode, type ChatErrorCode } from "@/server/chat/error-codes";
import {
  insertInitialPlanDraftCommand,
  planDraftRequestHash,
} from "@/server/chat/command-service";
import { claimCommand, completePlanDraftCommand, failCommand } from "@/server/chat/command-state";
import { resolveExistingOwner } from "@/server/chat/owner";
import { ownerDomains, ownerKeyHash } from "@/server/chat/ownership";
import { verifyTrustedRequest } from "@/server/ingress";
import {
  defaultCapabilities,
  evaluateRequirementReadiness,
  readinessPolicy,
} from "@/server/services/nlu/detect-missing";
import { processNLUInput } from "@/server/services/nlu/process-input";
import {
  generateTravelPlanSummary,
  PlannerServiceError,
} from "@/server/services/planner-service";
import type { TaskHandler } from "@/server/tasks/dispatcher";
import { TaskLeaseLost } from "@/server/tasks/durable-task";
import { readTaskPayload } from "@/server/tasks/payload";
import { PlanDraftError, planErrorResponse } from "./http";

export interface DraftOverrides {
  readonly stageOutputs?: Partial<Record<"CORE" | "PARAMETERS" | "CONSTRAINTS", string>>;
  readonly summaryOutput?: string;
  readonly mockFailureMode?: MockFailureMode;
  readonly costCap?: string;
  readonly tokenBudget?: number;
  readonly costBudget?: string;
}

const overrideStore = new AsyncLocalStorage<DraftOverrides>();

/** Test profiles stay inside the guarded client. Production calls ignore this store. */
export function withDraftOverrides<T>(overrides: DraftOverrides, run: () => T): T {
  return overrideStore.run(overrides, run);
}

interface PlanDraftBody {
  content: string;
  planningMode: "quick" | "precise";
  clientRequestId: string;
  locale: string;
  timezone: string;
}

interface DraftPayload extends PlanDraftBody {
  rateDimension: string;
}

type Runner = (commandId: string, requestId: string) => Promise<unknown>;

function testOverrides(): DraftOverrides {
  return process.env.NODE_ENV === "test" ? (overrideStore.getStore() ?? {}) : {};
}

function rateDimension(ownerKey: string, address?: string): string {
  return createHash("sha256")
    .update(address ? `ip:${address}` : `owner:${ownerKey}`)
    .digest("hex");
}

function clientDimension(request: Request, ownerKey: string): string {
  try {
    return rateDimension(ownerKey, verifyTrustedRequest(request, env.AUTH_SECRET));
  } catch {
    return rateDimension(ownerKey);
  }
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > 65_536) throw new PlanDraftError("VALIDATION_ERROR");
  if (!text.trim()) throw new PlanDraftError("VALIDATION_ERROR");
  return JSON.parse(text);
}

function parsePlanDraftBody(value: unknown): PlanDraftBody {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new PlanDraftError("VALIDATION_ERROR");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== "clientRequestId,content,locale,planningMode,timezone")
    throw new PlanDraftError("VALIDATION_ERROR");
  if (typeof row.content !== "string" || !row.content.isWellFormed())
    throw new PlanDraftError("VALIDATION_ERROR");
  const content = row.content.trim();
  const length = Array.from(content).length;
  if (
    length < 1 ||
    length > 4000 ||
    (row.planningMode !== "quick" && row.planningMode !== "precise") ||
    typeof row.clientRequestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.clientRequestId) ||
    typeof row.locale !== "string" ||
    !validScalarFormat(row.locale, "bcp47-locale") ||
    typeof row.timezone !== "string" ||
    !validScalarFormat(row.timezone, "iana-timezone")
  )
    throw new PlanDraftError("VALIDATION_ERROR");
  return {
    content,
    planningMode: row.planningMode,
    clientRequestId: row.clientRequestId,
    locale: row.locale,
    timezone: row.timezone,
  };
}

function parseIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (!key || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new PlanDraftError("VALIDATION_ERROR");
  return key;
}

function draftTitle(content: string): string {
  const plain = Array.from(content.replace(/<[^>]*>/gu, " ").replace(/[<>]/gu, " "))
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(plain).slice(0, 80).join("") || "未命名行程";
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function parsePayload(value: unknown): DraftPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("CONFIG_ERROR");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join() !==
      "clientRequestId,content,locale,message,planningMode,rateDimension,schemaVersion,timezone" &&
    Object.keys(row).sort().join() !==
      "clientRequestId,locale,message,planningMode,rateDimension,schemaVersion,timezone"
  )
    throw new Error("CONFIG_ERROR");
  const content = typeof row.message === "string" ? row.message : row.content;
  if (
    row.schemaVersion !== 1 ||
    (row.planningMode !== "quick" && row.planningMode !== "precise") ||
    typeof content !== "string" ||
    typeof row.locale !== "string" ||
    typeof row.timezone !== "string" ||
    typeof row.clientRequestId !== "string" ||
    typeof row.rateDimension !== "string"
  )
    throw new Error("CONFIG_ERROR");
  return {
    content,
    planningMode: row.planningMode,
    clientRequestId: row.clientRequestId,
    locale: row.locale,
    timezone: row.timezone,
    rateDimension: row.rateDimension,
  };
}

function failureCode(error: unknown): ChatErrorCode {
  const code =
    error instanceof PlannerServiceError
      ? error.code
      : error instanceof ChatCommandError
        ? error.code
        : error instanceof Error
          ? error.message
          : "";
  if (code === "VALIDATION_ERROR") return "PROVIDER_UNAVAILABLE";
  return isChatErrorCode(code) ? code : "PROVIDER_UNAVAILABLE";
}

function resolvedFields(requirement: TravelRequirement): string[] {
  const fields: string[] = [];
  if (requirement.origin) fields.push("origin");
  if (requirement.destinations.length > 0) fields.push("destinations");
  if (requirement.dateRange) fields.push("dateRange");
  if (requirement.durationDays !== null) fields.push("durationDays");
  if (requirement.travelers.totalCount !== null) fields.push("travelers");
  if (requirement.budget.amount !== null || requirement.budget.level !== null) fields.push("budget");
  if (requirement.preferences.pace) fields.push("preferences.pace");
  if (requirement.preferences.interests.length > 0) fields.push("preferences.interests");
  return fields;
}

export const executePlanDraftTask: TaskHandler = async (client, { task, lease, signal }) => {
  const prepared = await client.$transaction(async (tx) => {
    if (!(await claimCommand(tx, { ...lease, commandId: task.aggregateId }))) return null;
    const command = await tx.chatCommand.findUniqueOrThrow({ where: { id: task.aggregateId } });
    const durable = await tx.durableTask.findUniqueOrThrow({ where: { id: lease.taskId } });
    const payload = parsePayload(
      await readTaskPayload(tx, { ...durable, ownerKeyHash: command.ownerKeyHash }),
    );
    return { command, payload };
  });
  if (!prepared) return { ok: true };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const overrides = testOverrides();
    const now = Date.now();
    const ctx = createNluContext(
      {
        timezone: prepared.payload.timezone,
        locale: prepared.payload.locale,
        planningMode: prepared.payload.planningMode,
        ownerContext: { kind: "COMMAND", commandId: prepared.command.id, lease },
        traceId: prepared.command.traceId,
        requestId: prepared.command.traceId,
        signal: controller.signal,
        deadlineAt: now + 120_000,
        tokenBudget: overrides.tokenBudget ?? 1_000_000,
        costBudget: overrides.costBudget ?? "5",
      },
      () => Date.now(),
    );
    const guarded = {
      db: client,
      travelRecordId: prepared.command.travelRecordId,
      maxOutputBytes: 8192,
      failClosed: true,
      ...(overrides.stageOutputs ? { stageOutputs: overrides.stageOutputs } : {}),
      ...(overrides.mockFailureMode ? { mockFailureMode: overrides.mockFailureMode } : {}),
      ...(overrides.costCap ? { costCap: overrides.costCap } : {}),
    };
    const result = await processNLUInput(prepared.payload.content, null, 0, ctx, guarded);
    const policy = await readinessPolicy(client, ctx);
    const readiness = evaluateRequirementReadiness(
      result.requirement,
      ctx,
      policy,
      defaultCapabilities,
    );
    const summary =
      result.confirmationStatus === "READY_FOR_PLANNING"
        ? (
            await generateTravelPlanSummary(result.requirement, ctx, {
              ...guarded,
              attemptNo: 9,
              ...(overrides.summaryOutput ? { mockOutput: overrides.summaryOutput } : {}),
            })
          ).summary
        : null;
    const requirementState = {
      revision: result.requirement.revision,
      resolvedFields: resolvedFields(result.requirement),
      questions: [...result.questions],
      assumptions: readiness.assumptions.map((item) => ({ ...item })),
      confirmationStatus: result.confirmationStatus,
    };
    const receipt = {
      travelRecordId: prepared.command.travelRecordId,
      commandId: prepared.command.id,
      commandStatus: "COMPLETED" as const,
      handoffStage: "REQUIREMENT_SUMMARY" as const,
      summary,
      plannerRunId: null,
      acceptedPlanningMode: prepared.payload.planningMode,
      travelRecordStatus: result.recordStatus,
      workspaceAvailable: false as const,
      requirementState,
      readiness: {
        status: result.confirmationStatus === "NEEDS_INFORMATION" ? ("BLOCKED" as const) : ("READY" as const),
      },
      replayed: false,
    };
    const assistantText =
      Array.from(summary?.title || result.questions[0] || "行程需求已记录。")
        .slice(0, 500)
        .join("") || "行程需求已记录。";
    await client.$transaction((tx) =>
      completePlanDraftCommand(tx, {
        ...lease,
        commandId: prepared.command.id,
        recordStatus: result.recordStatus,
        requirement: asJson(result.requirement),
        assistantText,
        receipt: asJson(receipt),
      }),
    );
    return { ok: true, resultRef: prepared.command.id };
  } catch (error) {
    if (error instanceof TaskLeaseLost) throw error;
    const code = failureCode(error);
    await client.$transaction((tx) =>
      failCommand(tx, { ...lease, commandId: prepared.command.id, errorCode: code }),
    );
    return { ok: false, retryable: false, errorCategory: code };
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

async function acceptPlanDraft(
  client: PrismaClient,
  input: {
    owner: Awaited<ReturnType<typeof resolveExistingOwner>>;
    body: PlanDraftBody;
    idempotencyKey: string;
    traceId: string;
    rateDimension: string;
  },
) {
  if (!input.owner) throw new PlanDraftError("AUTH_REQUIRED", 401);
  const owner = input.owner;
  const requestHash = planDraftRequestHash(input.body);
  const idempotencyKeyHash = createHash("sha256").update(input.idempotencyKey).digest("hex");
  return client.$transaction(
    async (tx) => {
      const ownerHash = ownerKeyHash(owner);
      await tx.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        `command:${ownerHash}:PLAN_DRAFT:${idempotencyKeyHash}`,
      );
      const existing = await tx.commandIdempotency.findMany({
        where: {
          ownerKeyHash: { in: await ownerDomains(tx, owner) },
          kind: "PLAN_DRAFT",
          idempotencyKeyHash,
        },
      });
      if (existing.length) {
        if (existing.length !== 1 || existing[0].requestHash !== requestHash || !existing[0].commandId)
          throw new ChatCommandError("IDEMPOTENCY_KEY_REUSED", 409);
        const command = await tx.chatCommand.findUniqueOrThrow({
          where: { id: existing[0].commandId },
        });
        return {
          commandId: command.id,
          status: command.status,
          replayed: true,
        };
      }
      const record = await tx.travelRecord.create({
        data: {
          ...(owner.userId !== undefined
            ? { userId: owner.userId, anonTokenHash: null }
            : { userId: null, anonTokenHash: owner.anonTokenHash }),
          title: draftTitle(input.body.content),
          status: "DRAFT",
          version: 0,
        },
      });
      const created = await insertInitialPlanDraftCommand(tx, {
        owner,
        travelRecordId: record.id,
        kind: "PLAN_DRAFT",
        idempotencyKey: input.idempotencyKey,
        message: input.body.content,
        clientMessageId: input.body.clientRequestId,
        traceId: input.traceId,
        planningMode: input.body.planningMode,
        locale: input.body.locale,
        timezone: input.body.timezone,
        rateDimension: input.rateDimension,
      });
      const command = await tx.chatCommand.findUniqueOrThrow({ where: { id: created.commandId } });
      return { commandId: command.id, status: command.status, replayed: created.replayed };
    },
    { maxWait: 15000, timeout: 15000 },
  );
}

function pendingReceipt(
  command: { id: string; travelRecordId: string; status: string },
  planningMode: "quick" | "precise",
) {
  return {
    travelRecordId: command.travelRecordId,
    commandId: command.id,
    commandStatus: command.status,
    handoffStage: "REQUIREMENT_SUMMARY" as const,
    summary: null,
    plannerRunId: null,
    acceptedPlanningMode: planningMode,
    travelRecordStatus: "DRAFT" as const,
    workspaceAvailable: false as const,
    requirementState: {
      revision: 0,
      resolvedFields: [],
      questions: [],
      assumptions: [],
      confirmationStatus: "NEEDS_INFORMATION" as const,
    },
    readiness: { status: "BLOCKED" as const },
    replayed: false,
  };
}

async function readOutcome(client: PrismaClient, commandId: string) {
  const command = await client.chatCommand.findUniqueOrThrow({ where: { id: commandId } });
  if (command.status === "FAILED" || command.status === "CANCELLED") {
    const raw = command.errorCode ?? "";
    throw new PlanDraftError(isChatErrorCode(raw) ? raw : "PROVIDER_UNAVAILABLE");
  }
  if (command.status !== "COMPLETED") {
    const durable = await client.durableTask.findUniqueOrThrow({ where: { commandId } });
    const payload = parsePayload(
      await client.$transaction((tx) =>
        readTaskPayload(tx, { ...durable, ownerKeyHash: command.ownerKeyHash }),
      ),
    );
    return pendingReceipt(command, payload.planningMode);
  }
  const stored = await client.commandIdempotency.findUniqueOrThrow({ where: { commandId } });
  if (!stored.responseJson || typeof stored.responseJson !== "object" || Array.isArray(stored.responseJson))
    throw new PlanDraftError("CONFIG_ERROR");
  return stored.responseJson as Record<string, unknown>;
}

export async function handlePlanDraft(request: Request, run: Runner): Promise<Response> {
  const requestId = randomUUID();
  try {
    assertSameOrigin(request);
    if (new URL(request.url).search.length > 0) throw new PlanDraftError("VALIDATION_ERROR");
    const body = parsePlanDraftBody(await readJson(request));
    const idempotencyKey = parseIdempotencyKey(request);
    const owner = await resolveExistingOwner(request, { db: appDb });
    if (!owner)
      throw new PlanDraftError("AUTH_REQUIRED", 401, { action: "BOOTSTRAP_ANONYMOUS_SESSION" });
    const accepted = await acceptPlanDraft(appDb, {
      owner,
      body,
      idempotencyKey,
      traceId: `trace_${randomUUID().replaceAll("-", "")}`,
      rateDimension: clientDimension(request, ownerKeyHash(owner)),
    });
    if (!accepted.replayed || accepted.status === "PENDING" || accepted.status === "RUNNING")
      await run(accepted.commandId, requestId);
    const data = await readOutcome(appDb, accepted.commandId);
    return Response.json(ok({ ...data, replayed: accepted.replayed }, requestId), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) return planErrorResponse(error, requestId);
    return planErrorResponse(error, requestId);
  }
}
