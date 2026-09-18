import "server-only";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { fail, type ApiErrorCode } from "@/lib/api-response";
import {
  AiDebugInputError,
  parseAiDebugRequest,
  parseAiDebugStatus,
  type AiDebugReceipt,
  type AiDebugStatusDto,
} from "@/lib/ai-debug";
import { db } from "@/server/db";
import {
  AdminCommandError,
  AI_DEBUG_STREAM_OPERATION,
  AI_DEBUG_TEST_OPERATION,
  findAdminCommandReceipt,
  makeAdminCommandIdentity,
  type AdminCommandIdentity,
} from "@/server/admin/command-receipt";
import { AuditLogError } from "@/server/audit-log";
import type { AdminPrincipal } from "@/server/auth/require-admin";
import { enqueueTask } from "@/server/tasks/durable-task";
import { storeTaskPayload } from "@/server/tasks/payload";
import { debugOwnerKeyHash } from "@/server/ai/debug-runner";

export const AI_DEBUG_OPERATIONS = [AI_DEBUG_TEST_OPERATION, AI_DEBUG_STREAM_OPERATION] as const;
export type AiDebugOperation = (typeof AI_DEBUG_OPERATIONS)[number];
export { AI_DEBUG_STREAM_OPERATION, AI_DEBUG_TEST_OPERATION };

export class AiDebugNotFoundError extends Error {
  constructor() {
    super("NOT_FOUND");
    this.name = "AiDebugNotFoundError";
  }
}

/** Shared public mapping: every registered code keeps its documented status and requestId. */
export function aiDebugFailure(error: unknown, requestId: string): Response {
  const status = (code: ApiErrorCode) =>
    Response.json(fail(code, "调试请求未完成", requestId), {
      status:
        code === "AUTH_REQUIRED"
          ? 401
          : code === "FORBIDDEN"
            ? 403
            : code === "NOT_FOUND"
              ? 404
              : code === "VALIDATION_ERROR"
                ? 400
                : code === "IDEMPOTENCY_KEY_REUSED" || code === "CANCELLED"
                  ? 409
                  : code === "RATE_LIMITED" || code === "COST_LIMIT"
                    ? 429
                    : code === "INTERNAL_ERROR"
                      ? 500
                      : 503,
      headers: { "cache-control": "no-store" },
    });
  if (error instanceof AiDebugInputError || error instanceof AiDebugNotFoundError)
    return status(error instanceof AiDebugInputError ? "VALIDATION_ERROR" : "NOT_FOUND");
  if (error instanceof AdminCommandError)
    return status(
      error.kind === "IDEMPOTENCY_KEY_REUSED" ? "IDEMPOTENCY_KEY_REUSED" : "VALIDATION_ERROR",
    );
  if (error instanceof AuditLogError) return status("INTERNAL_ERROR");
  const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
  return status(
    (
      [
        "VALIDATION_ERROR",
        "NOT_FOUND",
        "IDEMPOTENCY_KEY_REUSED",
        "FEATURE_DISABLED",
        "CONFIG_ERROR",
        "PROVIDER_UNAVAILABLE",
        "PROVIDER_TIMEOUT",
        "RATE_LIMITED",
        "COST_LIMIT",
        "CANCELLED",
      ] as const
    ).includes(code as never)
      ? (code as ApiErrorCode)
      : "INTERNAL_ERROR",
  );
}

export interface AiDebugAcceptance {
  readonly receipt: AiDebugReceipt;
  readonly runId: string;
  readonly traceId: string;
  readonly replayed: boolean;
}

export function createAiDebugService(client: PrismaClient = db) {
  async function readBody(request: Request): Promise<unknown> {
    try {
      return await request.json();
    } catch {
      throw new AiDebugInputError();
    }
  }

  function identityFor(
    principal: AdminPrincipal,
    operation: AiDebugOperation,
    payload: unknown,
    request: Request,
  ): AdminCommandIdentity {
    const idempotencyKey = request.headers.get("idempotency-key");
    const parsed = parseAiDebugRequest(payload);
    return makeAdminCommandIdentity({
      ownerUserId: principal.id,
      operationId: operation,
      resourceId: parsed.promptKey,
      idempotencyKey: idempotencyKey ?? "",
      payload: parsed,
    });
  }

  return {
    /**
     * Persist the accepted run, its controlled payload and the AI_DEBUG task in one
     * transaction. No Provider call happens here.
     */
    async accept(
      principal: AdminPrincipal,
      operation: AiDebugOperation,
      request: Request,
    ): Promise<AiDebugAcceptance> {
      const payload = await readBody(request);
      const identity = identityFor(principal, operation, payload, request);
      const parsed = parseAiDebugRequest(payload);
      const runId = "debugrun_" + randomUUID().replaceAll("-", "");
      const traceId = "debug_" + randomUUID().replaceAll("-", "");
      return client.$transaction(async (tx) => {
        const previous = await findAdminCommandReceipt(tx, identity);
        if (previous) {
          const existing = await tx.aiDebugRun.findUnique({
            where: { idempotencyReceiptId: previous.id },
          });
          if (!existing) throw new Error("CONFIG_ERROR");
          return {
            runId: existing.id,
            traceId: existing.traceId,
            replayed: true,
            receipt: { debugRunId: existing.id, status: existing.status, replayed: true },
          };
        }
        const now = new Date();
        const receipt = await tx.adminCommandReceipt.create({
          data: {
            ...identity,
            status: "PENDING",
            createdAt: now,
            availableAt: now,
            expiresAt: new Date(now.getTime() + 86_400_000),
          },
        });
        const stored = await storeTaskPayload(tx, {
          ownerKeyHash: debugOwnerKeyHash(principal.id),
          schemaVersion: 1,
          value: parsed,
        });
        const task = await enqueueTask(tx, {
          kind: "AI_DEBUG",
          aggregateId: receipt.id,
          adminReceiptId: receipt.id,
          payloadRef: stored.payloadRef,
          payloadHash: stored.payloadHash,
          payloadSchemaVersion: stored.payloadSchemaVersion,
          maxAttempts: 2,
        });
        const run = await tx.aiDebugRun.create({
          data: {
            id: runId,
            adminUserId: principal.id,
            idempotencyReceiptId: receipt.id,
            taskId: task.id,
            payloadRef: stored.payloadRef,
            payloadHash: stored.payloadHash,
            status: "PENDING",
            traceId,
            attemptIdsJson: [],
            createdAt: now,
          },
        });
        return {
          runId: run.id,
          traceId: run.traceId,
          replayed: false,
          receipt: { debugRunId: run.id, status: run.status, replayed: false },
        };
      });
    },

    /** Aggregate status only. Reading a run never reaches a Provider. */
    async status(principal: AdminPrincipal, debugRunId: string): Promise<AiDebugStatusDto> {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(debugRunId)) throw new AiDebugNotFoundError();
      const run = await client.aiDebugRun.findUnique({ where: { id: debugRunId } });
      if (!run || run.adminUserId !== principal.id) throw new AiDebugNotFoundError();
      const attemptIds = Array.isArray(run.attemptIdsJson) ? (run.attemptIdsJson as unknown[]) : [];
      return parseAiDebugStatus({
        debugRunId: run.id,
        status: run.status,
        attemptIds,
        finalSummary: run.finalSummaryJson ?? null,
        errorCode: run.errorCode,
      });
    },
  };
}

export const aiDebugService = createAiDebugService;
