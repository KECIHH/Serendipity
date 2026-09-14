import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma, type DurableTask, type TaskStatus } from "@prisma/client";

export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 5;

export type TaskKind = "CHAT_COMMAND" | "ADMIN_KEY_ROTATION";

export interface ClaimTaskInput {
  kind: TaskKind;
  aggregateId: string;
  leaseOwner: string;
  leaseMs?: number;
  maxAttempts?: number;
  now?: number;
}

export interface ClaimTaskResult {
  task: DurableTask;
  fenced: boolean;
  adopted: boolean;
}

function isTerminal(status: TaskStatus): boolean {
  return status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED";
}

/**
 * Claim a PENDING task or adopt an expired RUNNING lease. Uses FOR UPDATE SKIP LOCKED so
 * two workers can never both win. Adoption increments the fencing token and keeps RUNNING.
 */
export async function claimTask(
  tx: Prisma.TransactionClient,
  input: ClaimTaskInput,
): Promise<ClaimTaskResult> {
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const now = typeof input.now === "number" ? new Date(input.now) : new Date();
  const leaseUntil = new Date(now.getTime() + leaseMs);

  const rows = await tx.$queryRaw<DurableTask[]>`
    SELECT * FROM "DurableTask"
    WHERE "kind" = ${input.kind} AND "aggregateId" = ${input.aggregateId}
      AND (
        "status" = 'PENDING'
        OR ("status" = 'RUNNING' AND "leaseUntil" < ${now})
      )
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  `;
  const current = rows[0];
  if (!current) throw new Error("TASK_UNAVAILABLE");

  const isAdoption = current.status === "RUNNING";
  const nextFencing = isAdoption ? current.fencingToken + 1 : 0;
  const nextAttempt = current.attemptCount + 1;
  if (nextAttempt > current.maxAttempts) {
    await tx.durableTask.update({
      where: { id: current.id },
      data: { status: "FAILED", errorCategory: "MAX_ATTEMPTS" },
    });
    throw new Error("TASK_MAX_ATTEMPTS");
  }
  const updated = await tx.durableTask.update({
    where: { id: current.id, fencingToken: current.fencingToken },
    data: {
      status: "RUNNING",
      leaseOwner: input.leaseOwner,
      leaseUntil,
      fencingToken: nextFencing,
      attemptCount: nextAttempt,
      availableAt: now,
      updatedAt: now,
    },
  });
  return { task: updated, fenced: isAdoption, adopted: isAdoption };
}

export interface HeartbeatInput {
  taskId: string;
  leaseOwner: string;
  fencingToken: number;
  leaseMs?: number;
  now?: number;
}

/** Only the current lease holder with the expected fencing token may renew. */
export async function heartbeatTask(
  tx: Prisma.TransactionClient,
  input: HeartbeatInput,
): Promise<void> {
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  const now = typeof input.now === "number" ? new Date(input.now) : new Date();
  const result = await tx.durableTask.updateMany({
    where: { id: input.taskId, leaseOwner: input.leaseOwner, fencingToken: input.fencingToken },
    data: { leaseUntil: new Date(now.getTime() + leaseMs), updatedAt: now },
  });
  if (result.count !== 1) throw new Error("TASK_LEASE_LOST");
}

export interface CompleteTaskInput {
  taskId: string;
  leaseOwner: string;
  fencingToken: number;
  resultRef?: string | null;
  now?: number;
}

export async function completeTask(
  tx: Prisma.TransactionClient,
  input: CompleteTaskInput,
): Promise<void> {
  const now = typeof input.now === "number" ? new Date(input.now) : new Date();
  const result = await tx.durableTask.updateMany({
    where: { id: input.taskId, leaseOwner: input.leaseOwner, fencingToken: input.fencingToken },
    data: { status: "SUCCEEDED", resultRef: input.resultRef ?? null, leaseUntil: null, updatedAt: now },
  });
  if (result.count !== 1) throw new Error("TASK_LEASE_LOST");
}

export interface FailTaskInput {
  taskId: string;
  leaseOwner: string;
  fencingToken: number;
  errorCategory?: string | null;
  retryable?: boolean;
  now?: number;
}

export async function failTask(
  tx: Prisma.TransactionClient,
  input: FailTaskInput,
): Promise<void> {
  const now = typeof input.now === "number" ? new Date(input.now) : new Date();
  const current = await tx.durableTask.findUnique({ where: { id: input.taskId } });
  if (!current || current.leaseOwner !== input.leaseOwner || current.fencingToken !== input.fencingToken) {
    throw new Error("TASK_LEASE_LOST");
  }
  const exhausted = input.retryable === false || current.attemptCount >= current.maxAttempts;
  if (exhausted) {
    await tx.durableTask.update({
      where: { id: current.id },
      data: {
        status: "FAILED",
        errorCategory: input.errorCategory ?? null,
        leaseUntil: null,
        updatedAt: now,
      },
    });
    return;
  }
  const backoffMs = Math.min(60_000, 1000 * 2 ** current.attemptCount);
  await tx.durableTask.update({
    where: { id: current.id },
    data: {
      status: "PENDING",
      errorCategory: input.errorCategory ?? null,
      leaseOwner: null,
      leaseUntil: null,
      availableAt: new Date(now.getTime() + backoffMs),
      updatedAt: now,
    },
  });
}

export async function cancelTask(
  tx: Prisma.TransactionClient,
  input: { taskId: string; now?: number },
): Promise<void> {
  const now = typeof input.now === "number" ? new Date(input.now) : new Date();
  await tx.durableTask.updateMany({
    where: { id: input.taskId, status: { in: ["PENDING", "RUNNING"] } },
    data: { status: "CANCELLED", leaseUntil: null, updatedAt: now },
  });
}

export interface EnqueueTaskInput {
  kind: TaskKind;
  aggregateId: string;
  payloadHash: string;
  payloadRef?: string | null;
  payloadSchemaVersion?: number | null;
  commandId?: string | null;
  rotationRunId?: string | null;
  maxAttempts?: number;
  now?: number;
}

export async function enqueueTask(
  tx: Prisma.TransactionClient,
  input: EnqueueTaskInput,
): Promise<DurableTask> {
  const now = typeof input.now === "number" ? new Date(input.now) : new Date();
  const existing = await tx.durableTask.findUnique({
    where: { kind_aggregateId: { kind: input.kind, aggregateId: input.aggregateId } },
  });
  if (existing) return existing;
  return tx.durableTask.create({
    data: {
      id: `task_${randomUUID().replaceAll("-", "")}`,
      kind: input.kind,
      aggregateId: input.aggregateId,
      payloadHash: input.payloadHash,
      payloadRef: input.payloadRef ?? null,
      payloadSchemaVersion: input.payloadSchemaVersion ?? null,
      status: "PENDING",
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      checkpointJson: Prisma.JsonNull,
      commandId: input.commandId ?? null,
      rotationRunId: input.rotationRunId ?? null,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
}