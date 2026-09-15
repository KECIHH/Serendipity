import "server-only";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { Prisma, type ChatCommandEvent } from "@prisma/client";
import { canonicalHash } from "@/server/ai/canonical-hash";
import { validateChatEnvelope, type ChatEventEnvelope } from "@/lib/chat-stream";

const CHANNEL = "serendipity_chat";
export type ChatNotification =
  | { kind: "persistent"; aggregateId: string; eventId: string }
  | { kind: "delta"; event: ChatEventEnvelope };
/** LISTEN/NOTIFY crosses worker processes without persisting transient output. */
export async function subscribeChatNotifications(
  connectionString: string,
  listener: (notice: ChatNotification) => void,
  onError: () => void,
) {
  const connection = new Client({
    connectionString,
    application_name: "chat-stream",
    connectionTimeoutMillis: 5000,
  });
  connection.on("error", onError);
  connection.on("notification", (notice) => {
    if (notice.channel !== CHANNEL || !notice.payload) return;
    try {
      const value: unknown = JSON.parse(notice.payload);
      if (!value || typeof value !== "object") return;
      const row = value as ChatNotification;
      if (row.kind === "delta") {
        validateChatEnvelope(row.event);
        listener(row);
      } else if (
        row.kind === "persistent" &&
        typeof row.aggregateId === "string" &&
        typeof row.eventId === "string"
      )
        listener(row);
    } catch {
      /* An invalid wakeup never becomes an event. The persistent poll still reconciles. */
    }
  });
  try {
    await connection.connect();
    await connection.query(`LISTEN ${CHANNEL}`);
  } catch (error) {
    await connection.end();
    throw error;
  }
  return () => connection.end();
}
export async function publishChatDelta(tx: Prisma.TransactionClient, event: ChatEventEnvelope) {
  validateChatEnvelope(event);
  if (event.type !== "assistant.delta") throw new Error("TRANSIENT_EVENT_REQUIRED");
  const notice = JSON.stringify({ kind: "delta", event });
  if (Buffer.byteLength(notice) > 7800) throw new Error("DELTA_TOO_LARGE");
  await tx.$executeRaw`SELECT pg_notify(${CHANNEL},${notice})`;
}
export async function publishPersistentWakeup(
  tx: Prisma.TransactionClient,
  event: ChatEventEnvelope,
) {
  validateChatEnvelope(event);
  if (event.type === "assistant.delta") throw new Error("PERSISTENT_EVENT_REQUIRED");
  await tx.$executeRaw`SELECT pg_notify(${CHANNEL},${JSON.stringify({ kind: "persistent", aggregateId: event.aggregateId, eventId: event.eventId })})`;
}
export function envelopeFromRow(row: ChatCommandEvent): ChatEventEnvelope {
  return validateChatEnvelope({
    eventId: row.eventId,
    sequence: row.sequence,
    aggregateId: row.aggregateId,
    traceId: row.traceId,
    type: row.type,
    status: row.status,
    occurredAt: row.occurredAt.toISOString(),
    payloadVersion: row.payloadVersion,
    payload: row.payloadJson,
  });
}
export async function appendCommandEvent(
  tx: Prisma.TransactionClient,
  input: {
    commandId: string;
    traceId: string;
    type: Exclude<ChatEventEnvelope["type"], "assistant.delta">;
    status: ChatEventEnvelope["status"];
    payload: Record<string, unknown>;
    now?: Date;
  },
) {
  const last = await tx.chatCommandEvent.findFirst({
    where: { aggregateId: input.commandId },
    orderBy: { sequence: "desc" },
  });
  const event = await tx.chatCommandEvent.create({
    data: {
      eventId: "evt_" + randomUUID().replaceAll("-", ""),
      sequence: (last?.sequence ?? 0) + 1,
      aggregateId: input.commandId,
      traceId: input.traceId,
      type: input.type,
      status: input.status,
      occurredAt: input.now ?? new Date(),
      payloadVersion: 1,
      payloadJson: input.payload as Prisma.InputJsonObject,
    },
  });
  const envelope = envelopeFromRow(event);
  await tx.outbox.create({
    data: {
      aggregateId: input.commandId,
      eventId: event.eventId,
      type: event.type,
      payloadHash: canonicalHash(envelope),
      payloadJson: envelope as unknown as Prisma.InputJsonObject,
    },
  });
  return event;
}
