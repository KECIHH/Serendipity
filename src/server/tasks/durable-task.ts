import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma, type DurableTask } from "@prisma/client";
import { readAuthClock } from "@/server/auth/clock";
import { readTaskPayload } from "./payload";
import { canonicalHash } from "@/lib/ai/schemas";

export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const TASK_KINDS = ["CHAT_COMMAND", "ADMIN_KEY_ROTATION"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export interface TaskLease {
  taskId: string;
  leaseOwner: string;
  fencingToken: number;
}
export class TaskLeaseLost extends Error {
  constructor() {
    super("TASK_LEASE_LOST");
  }
}
export interface ClaimTaskInput {
  kind: TaskKind;
  aggregateId: string;
  leaseOwner: string;
  leaseMs?: number;
}
function leaseDuration(value: number) {
  if (!Number.isSafeInteger(value) || value < 100 || value > 60_000)
    throw new Error("TASK_LEASE_INVALID");
  return value;
}
export async function claimTask(tx: Prisma.TransactionClient, input: ClaimTaskInput) {
  if (
    !(TASK_KINDS as readonly string[]).includes(input.kind) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.leaseOwner)
  )
    throw new Error("TASK_INPUT_INVALID");
  const now = await readAuthClock(tx);
  const rows = await tx.$queryRawUnsafe<DurableTask[]>(
    'SELECT * FROM "DurableTask" WHERE kind=$1 AND "aggregateId"=$2 AND "availableAt"<=$3 AND ((status=\'PENDING\' AND "attemptCount"<"maxAttempts") OR (status=\'RUNNING\' AND "leaseUntil"<=$3)) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1',
    input.kind,
    input.aggregateId,
    now,
  );
  const current = rows[0];
  if (!current) return null;
  const adopted = current.status === "RUNNING";
  const task = await tx.durableTask.update({
    where: { id: current.id },
    data: {
      status: "RUNNING",
      leaseOwner: input.leaseOwner,
      leaseUntil: new Date(now.getTime() + leaseDuration(input.leaseMs ?? DEFAULT_LEASE_MS)),
      fencingToken: { increment: 1 },
      // An expired lease continues the same domain attempt and checkpoint.
      attemptCount: adopted ? current.attemptCount : current.attemptCount + 1,
      updatedAt: now,
    },
  });
  return { task, adopted, fenced: adopted };
}
export async function assertTaskLease(
  tx: Prisma.TransactionClient,
  lease: TaskLease,
): Promise<DurableTask> {
  await tx.$queryRawUnsafe('SELECT id FROM "DurableTask" WHERE id=$1 FOR UPDATE', lease.taskId);
  const task = await tx.durableTask.findUnique({ where: { id: lease.taskId } });
  const now = await readAuthClock(tx);
  if (
    !task ||
    task.status !== "RUNNING" ||
    task.leaseOwner !== lease.leaseOwner ||
    task.fencingToken !== lease.fencingToken ||
    !task.leaseUntil ||
    task.leaseUntil <= now
  )
    throw new TaskLeaseLost();
  await tx.$queryRawUnsafe(
    "SELECT set_config('serendipity.task_id',$1,true),set_config('serendipity.task_owner',$2,true),set_config('serendipity.task_fence',$3,true)",
    task.id,
    lease.leaseOwner,
    String(lease.fencingToken),
  );
  return task;
}
export async function heartbeatTask(
  tx: Prisma.TransactionClient,
  input: TaskLease & { leaseMs?: number },
) {
  await assertTaskLease(tx, input);
  const now = await readAuthClock(tx);
  await tx.durableTask.update({
    where: { id: input.taskId },
    data: {
      leaseUntil: new Date(now.getTime() + leaseDuration(input.leaseMs ?? DEFAULT_LEASE_MS)),
      updatedAt: now,
    },
  });
}
export async function saveTaskCheckpoint(
  tx: Prisma.TransactionClient,
  lease: TaskLease,
  checkpoint: Prisma.InputJsonObject,
) {
  await assertTaskLease(tx, lease);
  await tx.durableTask.update({
    where: { id: lease.taskId },
    data: { checkpointJson: checkpoint },
  });
}
export async function completeTask(
  tx: Prisma.TransactionClient,
  input: TaskLease & { resultRef?: string | null },
) {
  await assertTaskLease(tx, input);
  await tx.durableTask.update({
    where: { id: input.taskId },
    data: {
      status: "SUCCEEDED",
      resultRef: input.resultRef ?? null,
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: await readAuthClock(tx),
    },
  });
}
export async function failTask(
  tx: Prisma.TransactionClient,
  input: TaskLease & {
    errorCategory?: string | null;
    retryable?: boolean;
    backoffMs?: number;
  },
) {
  const task = await assertTaskLease(tx, input),
    now = await readAuthClock(tx);
  const exhausted = input.retryable === false || task.attemptCount >= task.maxAttempts;
  const backoff = input.backoffMs ?? Math.min(60_000, 1000 * 2 ** task.attemptCount);
  if (!Number.isSafeInteger(backoff) || backoff < 0 || backoff > 60_000)
    throw new Error("TASK_BACKOFF_INVALID");
  await tx.durableTask.update({
    where: { id: task.id },
    data: {
      status: exhausted ? "FAILED" : "PENDING",
      errorCategory: input.errorCategory ?? null,
      leaseOwner: null,
      leaseUntil: null,
      availableAt: new Date(now.getTime() + (exhausted ? 0 : backoff)),
      updatedAt: now,
    },
  });
  return exhausted;
}
/** The domain caller authorizes and locks its aggregate before cancelling this task. */
export async function cancelTask(tx: Prisma.TransactionClient, input: { taskId: string }) {
  await tx.$queryRawUnsafe('SELECT id FROM "DurableTask" WHERE id=$1 FOR UPDATE', input.taskId);
  await tx.durableTask.updateMany({
    where: { id: input.taskId, status: { in: ["PENDING", "RUNNING"] } },
    data: {
      status: "CANCELLED",
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: await readAuthClock(tx),
    },
  });
}
export interface EnqueueTaskInput {
  kind: TaskKind;
  aggregateId: string;
  payloadHash: string;
  payloadRef: string;
  payloadSchemaVersion: number;
  commandId?: string;
  adminReceiptId?: string;
  rotationRunId?: string;
  maxAttempts?: number;
}
export async function enqueueTask(
  tx: Prisma.TransactionClient,
  input: EnqueueTaskInput,
): Promise<DurableTask> {
  let authorization: { ownerUserId: string; sessionVersion: number } | undefined;
  if (
    !(TASK_KINDS as readonly string[]).includes(input.kind) ||
    !/^[a-f0-9]{64}$/.test(input.payloadHash) ||
    typeof input.payloadRef !== "string" ||
    input.payloadSchemaVersion !== 1
  )
    throw new Error("PAYLOAD_REFERENCE_REQUIRED");
  if (input.kind === "CHAT_COMMAND") {
    if (input.commandId !== input.aggregateId) throw new Error("TASK_AGGREGATE_INVALID");
    await readTaskPayload(tx, input);
  } else {
    const receipt =
      input.adminReceiptId &&
      (await tx.adminCommandReceipt.findUnique({ where: { id: input.adminReceiptId } }));
    if (
      !receipt ||
      input.aggregateId !== receipt.id ||
      input.payloadRef !== "admin-command:" + receipt.id ||
      input.payloadHash !== receipt.requestHash
    )
      throw new Error("PAYLOAD_REFERENCE_INVALID");
    const actor = await tx.user.findUnique({ where: { id: receipt.ownerUserId } });
    if (!actor || actor.role !== "ADMIN" || actor.status !== "ACTIVE")
      throw new Error("TASK_OWNER_INVALID");
    authorization = { ownerUserId: actor.id, sessionVersion: actor.sessionVersion };
  }
  const existing = await tx.durableTask.findUnique({
    where: {
      kind_aggregateId: {
        kind: input.kind,
        aggregateId: input.aggregateId,
      },
    },
  });
  if (existing) {
    if (existing.payloadHash !== input.payloadHash || existing.payloadRef !== input.payloadRef)
      throw new Error("TASK_INPUT_CONFLICT");
    return existing;
  }
  const now = await readAuthClock(tx),
    maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20)
    throw new Error("TASK_INPUT_INVALID");
  const task = await tx.durableTask.create({
    data: {
      id: "task_" + randomUUID().replaceAll("-", ""),
      ...input,
      maxAttempts,
      checkpointJson: { version: 1, stage: "READY", ...(authorization ? { authorization } : {}) },
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  if (input.kind === "ADMIN_KEY_ROTATION") {
    const payload = { taskId: task.id, receiptId: input.adminReceiptId!, schemaVersion: 1 };
    await tx.outbox.create({
      data: {
        aggregateId: task.aggregateId,
        type: "admin.rotation.accepted",
        eventId: "evt_" + randomUUID().replaceAll("-", ""),
        payloadHash: canonicalHash(payload),
        payloadJson: payload,
      },
    });
  }
  return task;
}
