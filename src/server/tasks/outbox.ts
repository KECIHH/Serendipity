import "server-only";

import { createHash } from "node:crypto";
import { Prisma, type Outbox, type OutboxStatus } from "@prisma/client";

export const OUTBOX_RETRY_MS = 5_000;

export interface EnqueueOutboxInput {
  aggregateId: string;
  type: string;
  eventId: string;
  payload: unknown;
  now?: number;
}

/** Persist the outbox row before any external push; eventId is globally unique. */
export async function enqueueOutbox(
  tx: Prisma.TransactionClient,
  input: EnqueueOutboxInput,
): Promise<Outbox> {
  const now = typeof input.now === "number" ? new Date(input.now) : new Date();
  const existing = await tx.outbox.findUnique({ where: { eventId: input.eventId } });
  if (existing) return existing;
  return tx.outbox.create({
    data: {
      aggregateId: input.aggregateId,
      type: input.type,
      eventId: input.eventId,
      payloadHash: createHash("sha256").update(JSON.stringify(input.payload)).digest("hex"),
      payloadJson: input.payload as Prisma.InputJsonValue,
      status: "PENDING",
      availableAt: now,
      createdAt: now,
    },
  });
}

export interface ClaimOutboxInput {
  batchSize?: number;
  now?: number;
}

export async function claimOutboxBatch(
  tx: Prisma.TransactionClient,
  input: ClaimOutboxInput = {},
): Promise<Outbox[]> {
  const now = typeof input.now === "number" ? new Date(input.now) : new Date();
  const rows = await tx.$queryRaw<Outbox[]>`
    SELECT * FROM "Outbox"
    WHERE "status" = 'PENDING' AND "availableAt" <= ${now}
    ORDER BY "createdAt", "id"
    FOR UPDATE SKIP LOCKED
    LIMIT ${input.batchSize ?? 50}
  `;
  return rows;
}

export async function markOutboxDelivered(
  tx: Prisma.TransactionClient,
  input: { id: string; now?: number },
): Promise<void> {
  const now = typeof input.now === "number" ? new Date(input.now) : new Date();
  await tx.outbox.updateMany({
    where: { id: input.id, status: "PENDING" },
    data: { status: "DELIVERED", publishedAt: now },
  });
}

export async function requeueOutbox(
  tx: Prisma.TransactionClient,
  input: { id: string; now?: number },
): Promise<void> {
  const now = typeof input.now === "number" ? new Date(input.now) : new Date();
  await tx.outbox.updateMany({
    where: { id: input.id, status: "PENDING" },
    data: { attemptCount: { increment: 1 }, availableAt: new Date(now.getTime() + OUTBOX_RETRY_MS) },
  });
}