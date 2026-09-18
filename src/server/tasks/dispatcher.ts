import "server-only";
import type { PrismaClient, DurableTask } from "@prisma/client";
import { db } from "@/server/db";
import {
  claimTask,
  completeTask,
  failTask,
  heartbeatTask,
  TaskLeaseLost,
  type TaskKind,
  type TaskLease,
} from "./durable-task";
export type { TaskKind } from "./durable-task";
export { drainOutbox } from "./outbox";

export interface WorkerContext {
  db?: PrismaClient;
  kind: TaskKind;
  aggregateId: string;
  runId: string;
  leaseMs?: number;
  onClaim?: (task: DurableTask) => Promise<void>;
}
export type TaskHandler = (
  client: PrismaClient,
  input: { task: DurableTask; lease: TaskLease; signal: AbortSignal },
) => Promise<
  { ok: true; resultRef?: string } | { ok: false; retryable?: boolean; errorCategory: string }
>;
export type WorkerResult = "COMPLETED" | "RETRYING" | "FAILED" | "NOT_CLAIMED" | "CANCELLED";
function state(task: DurableTask): WorkerResult {
  return task.status === "SUCCEEDED"
    ? "COMPLETED"
    : task.status === "PENDING"
      ? "RETRYING"
      : task.status === "CANCELLED"
        ? "CANCELLED"
        : task.status === "FAILED"
          ? "FAILED"
          : "NOT_CLAIMED";
}
/** Claim commits before the handler starts. No transaction spans Provider or delivery I/O. */
export async function runTask(handler: TaskHandler, ctx: WorkerContext): Promise<WorkerResult> {
  const client = ctx.db ?? db,
    leaseMs = ctx.leaseMs ?? 30000;
  const claim = await client.$transaction((tx) =>
    claimTask(tx, {
      kind: ctx.kind,
      aggregateId: ctx.aggregateId,
      leaseOwner: ctx.runId,
      leaseMs,
    }),
  );
  if (!claim) return "NOT_CLAIMED";
  const lease: TaskLease = {
    taskId: claim.task.id,
    leaseOwner: ctx.runId,
    fencingToken: claim.task.fencingToken,
  };
  const controller = new AbortController();
  let heartbeatPending: Promise<void> | undefined;
  const timer = setInterval(
    () => {
      if (heartbeatPending) return;
      heartbeatPending = client
        .$transaction((tx) => heartbeatTask(tx, { ...lease, leaseMs }))
        .catch(() => {
          controller.abort();
        })
        .finally(() => {
          heartbeatPending = undefined;
        });
    },
    Math.max(30, Math.floor(leaseMs / 3)),
  );
  try {
    await ctx.onClaim?.(claim.task);
    let result: Awaited<ReturnType<TaskHandler>>;
    try {
      result = await handler(client, { task: claim.task, lease, signal: controller.signal });
    } catch (error) {
      if (error instanceof TaskLeaseLost) return "NOT_CLAIMED";
      result = { ok: false, retryable: true, errorCategory: "INTERNAL_ERROR" };
    }
    return await client.$transaction(async (tx) => {
      const current = await tx.durableTask.findUniqueOrThrow({ where: { id: lease.taskId } });
      if (current.status !== "RUNNING") return state(current);
      if (result.ok) {
        await completeTask(tx, { ...lease, resultRef: result.resultRef });
        return "COMPLETED";
      }
      const exhausted = await failTask(tx, {
        ...lease,
        errorCategory: result.errorCategory,
        retryable: result.retryable,
      });
      return exhausted ? "FAILED" : "RETRYING";
    });
  } catch (error) {
    if (error instanceof TaskLeaseLost) return "NOT_CLAIMED";
    throw error;
  } finally {
    clearInterval(timer);
    if (heartbeatPending) await heartbeatPending;
  }
}
export async function runnableTasks(client: PrismaClient, take = 10) {
  return client.$queryRaw<
    Array<{ kind: TaskKind; aggregateId: string }>
  >`SELECT kind,"aggregateId" FROM "DurableTask"
    WHERE kind IN ('CHAT_COMMAND','ADMIN_KEY_ROTATION','AI_DEBUG') AND "availableAt"<=public.auth_now()
    AND ((status='PENDING' AND "attemptCount"<"maxAttempts") OR (status='RUNNING' AND "leaseUntil"<=public.auth_now()))
    ORDER BY "availableAt",id LIMIT ${take}`;
}
