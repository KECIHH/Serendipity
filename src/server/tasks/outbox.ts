import "server-only";
import { Prisma, type Outbox, type PrismaClient } from "@prisma/client";
import { canonicalHash } from "@/server/ai/canonical-hash";
import { validateChatEnvelope } from "@/lib/chat-stream";
import { envelopeFromRow, publishPersistentWakeup } from "@/server/chat/events";
import { readAuthClock } from "@/server/auth/clock";

export const OUTBOX_RETRY_MS = 5000;
/** Short claim transaction. availableAt is the bounded delivery visibility timeout. */
export async function claimOutboxBatch(
  tx: Prisma.TransactionClient,
  input: { batchSize?: number } = {},
): Promise<Outbox[]> {
  const now = await readAuthClock(tx),
    size = input.batchSize ?? 50;
  if (!Number.isInteger(size) || size < 1 || size > 100) throw new Error("OUTBOX_BATCH_INVALID");
  const rows = await tx.$queryRaw<Outbox[]>`SELECT * FROM "Outbox"
    WHERE status='PENDING' AND "availableAt"<=${now} ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT ${size}`;
  const claimed: Outbox[] = [];
  for (const row of rows)
    claimed.push(
      await tx.outbox.update({
        where: { id: row.id },
        data: {
          attemptCount: { increment: 1 },
          availableAt: new Date(now.getTime() + OUTBOX_RETRY_MS),
        },
      }),
    );
  return claimed;
}
export async function markOutboxDelivered(
  tx: Prisma.TransactionClient,
  row: Pick<Outbox, "id" | "attemptCount">,
) {
  return tx.outbox.updateMany({
    where: { id: row.id, status: "PENDING", attemptCount: row.attemptCount },
    data: {
      status: "DELIVERED",
      publishedAt: await readAuthClock(tx),
    },
  });
}
export async function deliverOutboxRow(client: PrismaClient, row: Outbox) {
  if (row.type === "admin.rotation.accepted") {
    const task = await client.durableTask.findUnique({
      where: { adminReceiptId: row.aggregateId },
    });
    const payload = row.payloadJson as Prisma.JsonObject;
    if (
      !task ||
      payload.taskId !== task.id ||
      payload.receiptId !== row.aggregateId ||
      payload.schemaVersion !== 1 ||
      canonicalHash(payload) !== row.payloadHash
    )
      throw new Error("OUTBOX_EVENT_INVALID");
    await client.$executeRaw`SELECT pg_notify('serendipity_task',${JSON.stringify({ taskId: task.id })})`;
    return;
  }
  const event = await client.chatCommandEvent.findUnique({ where: { eventId: row.eventId } });
  if (!event || event.aggregateId !== row.aggregateId || event.type !== row.type)
    throw new Error("OUTBOX_EVENT_INVALID");
  const envelope = validateChatEnvelope(row.payloadJson);
  if (
    canonicalHash(envelope) !== row.payloadHash ||
    canonicalHash(envelopeFromRow(event)) !== row.payloadHash
  )
    throw new Error("OUTBOX_HASH_INVALID");
  await publishPersistentWakeup(client, envelope);
}
/** Delivery and acknowledgement are separate: a crash may repeat a wakeup, never a message. */
export async function drainOutbox(
  client: PrismaClient,
  input: {
    afterDelivery?: (row: Outbox) => Promise<void>;
    batchSize?: number;
  } = {},
) {
  const rows = await client.$transaction((tx) => claimOutboxBatch(tx, input));
  let delivered = 0;
  for (const row of rows) {
    await deliverOutboxRow(client, row);
    await input.afterDelivery?.(row);
    const ack = await client.$transaction((tx) => markOutboxDelivered(tx, row));
    delivered += ack.count;
  }
  return delivered;
}
