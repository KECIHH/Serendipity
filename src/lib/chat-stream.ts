export interface ChatEventEnvelope {
  eventId: string;
  sequence: number;
  aggregateId: string;
  traceId: string;
  type:
    | "message.accepted"
    | "assistant.delta"
    | "assistant.completed"
    | "command.failed"
    | "command.cancelled";
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  occurredAt: string;
  payloadVersion: 1;
  payload: Record<string, unknown>;
}
export type PersistentCheckpoint = { eventId: string; sequence: number } | null;
export function isPersistentEvent(event: ChatEventEnvelope) {
  return event.type !== "assistant.delta";
}
/** Consumers persist this explicit checkpoint; the EventSource transient lastEventId is not a durable cursor. */
export function advanceChatCheckpoint(
  previous: PersistentCheckpoint,
  event: ChatEventEnvelope,
): PersistentCheckpoint {
  if (!isPersistentEvent(event) || (previous && event.sequence <= previous.sequence))
    return previous;
  return { eventId: event.eventId, sequence: event.sequence };
}
export function validateChatEnvelope(value: unknown): ChatEventEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_EVENT");
  const row = value as ChatEventEnvelope;
  if (
    Object.keys(row).sort().join() !==
      "aggregateId,eventId,occurredAt,payload,payloadVersion,sequence,status,traceId,type" ||
    !/^evt_[a-f0-9]{32}$/.test(row.eventId) ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(row.aggregateId) ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(row.traceId) ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    row.payloadVersion !== 1 ||
    !row.payload ||
    typeof row.payload !== "object" ||
    Array.isArray(row.payload) ||
    !Number.isFinite(Date.parse(row.occurredAt)) ||
    ![
      "message.accepted",
      "assistant.delta",
      "assistant.completed",
      "command.failed",
      "command.cancelled",
    ].includes(row.type) ||
    !["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"].includes(row.status)
  )
    throw new Error("INVALID_EVENT");
  if (
    row.type === "assistant.delta" &&
    (row.status !== "RUNNING" ||
      Object.keys(row.payload).sort().join() !== "commandId,deltaIndex,text" ||
      row.payload.commandId !== row.aggregateId ||
      !Number.isSafeInteger(row.payload.deltaIndex) ||
      Number(row.payload.deltaIndex) < 0 ||
      typeof row.payload.text !== "string")
  )
    throw new Error("INVALID_EVENT");
  if (row.type !== "assistant.delta" && row.sequence < 1) throw new Error("INVALID_EVENT");
  return row;
}
