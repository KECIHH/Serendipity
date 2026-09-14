import "server-only";

import { Prisma } from "@prisma/client";
import { db } from "@/server/db";
import { claimTask, completeTask, failTask, heartbeatTask, type TaskKind } from "@/server/tasks/durable-task";
export type { TaskKind } from "@/server/tasks/durable-task";
import { claimOutboxBatch, markOutboxDelivered, requeueOutbox } from "@/server/tasks/outbox";

export interface WorkerContext {
  kind: TaskKind;
  runId: string;
  maxConcurrency?: number;
  pollMs?: number;
  leaseMs?: number;
}

export interface TaskHandler {
  (tx: Prisma.TransactionClient, input: {
    taskId: string;
    aggregateId: string;
    fencingToken: number;
    payloadRef: string | null;
    checkpoint: Prisma.JsonValue;
  }): Promise<{ ok: true; resultRef?: string | null } | { ok: false; retryable?: boolean; errorCategory?: string }>;
}

/**
 * Claim a single task and run its handler under the task lease. Only the lease holder with
 * the correct fencing token may complete/fail the task. Any handler throw fails the attempt.
 */
export async function runTask(
  handler: TaskHandler,
  ctx: WorkerContext & { kind: TaskKind; aggregateId: string },
): Promise<"COMPLETED" | "RETRYING" | "FAILED" | "NOT_CLAIMED" | "CANCELLED"> {
  return db.$transaction(async (tx) => {
    const claim = await claimTask(tx, {
      kind: ctx.kind,
      aggregateId: ctx.aggregateId,
      leaseOwner: ctx.runId,
      leaseMs: ctx.leaseMs,
    }).catch((error) => {
      if (error instanceof Error && ["TASK_UNAVAILABLE", "TASK_MAX_ATTEMPTS"].includes(error.message)) return null;
      throw error;
    });
    if (!claim) return "NOT_CLAIMED";
    const result = await handler(tx, {
      taskId: claim.task.id,
      aggregateId: ctx.aggregateId,
      fencingToken: claim.task.fencingToken,
      payloadRef: claim.task.payloadRef,
      checkpoint: claim.task.checkpointJson as Prisma.JsonValue,
    });
    if (result.ok) {
      await completeTask(tx, {
        taskId: claim.task.id,
        leaseOwner: ctx.runId,
        fencingToken: claim.task.fencingToken,
        resultRef: result.resultRef ?? null,
      });
      return "COMPLETED";
    }
    await failTask(tx, {
      taskId: claim.task.id,
      leaseOwner: ctx.runId,
      fencingToken: claim.task.fencingToken,
      errorCategory: result.errorCategory ?? null,
      retryable: result.retryable,
    });
    return result.retryable === false ? "FAILED" : "RETRYING";
  });
}

/** Deliver a batch of ready outbox rows. At-least-once: a crash before mark leaves it PENDING. */
export async function drainOutbox(ctx: WorkerContext): Promise<number> {
  let delivered = 0;
  await db.$transaction(async (tx) => {
    const batch = await claimOutboxBatch(tx, { now: Date.now() });
    for (const row of batch) {
      try {
        await dispatchOutboxRow(tx, row);
        await markOutboxDelivered(tx, { id: row.id });
        delivered += 1;
      } catch {
        await requeueOutbox(tx, { id: row.id });
      }
    }
  });
  return delivered;
}

async function dispatchOutboxRow(
  tx: Prisma.TransactionClient,
  row: { id: string; type: string; aggregateId: string; eventId: string; payloadJson: Prisma.JsonValue },
): Promise<void> {
  // The SSE publisher subscribes per-connection; the outbox is the durable replay/retry
  // journal. External delivery hooks are registered by consumer phases.
  void row;
}