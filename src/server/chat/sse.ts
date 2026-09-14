import "server-only";

import type { Prisma } from "@prisma/client";

export const REPLAY_WINDOW_LIMIT = 1000;
export const REPLAY_BYTE_LIMIT = 256 * 1024;
export const SSE_FRAME_ID = "id";

export interface SseEnvelope {
  eventId: string;
  sequence: string;
  aggregateId: string;
  traceId: string;
  type: string;
  status: string;
  occurredAt: string;
  payloadVersion: number;
  payload: unknown;
}

export interface ReplayInput {
  aggregateId: string;
  afterSequence?: string | null;
  lastEventId?: string | null;
  now?: number;
}

export interface ReplayResult {
  events: SseEnvelope[];
  cursor: string | null;
  windowExceeded: boolean;
}

/** Validate Last-Event-ID and afterSequence are consistent when both supplied. */
export function normalizeReplayCursor(input: ReplayInput): bigint | null {
  const after = input.afterSequence ?? null;
  const last = input.lastEventId ?? null;
  if (after === null && last === null) return null;
  if (after !== null && last !== null) {
    if (after !== last) throw new Error("CURSOR_MISMATCH");
  }
  const value: string | null = after ?? last;
  if (value === null || !/^\d+$/.test(value)) throw new Error("INVALID_CURSOR");
  const cursor = BigInt(value as string);
  if (cursor < BigInt(1)) throw new Error("INVALID_CURSOR");
  return cursor;
}

/**
 * Replay the persistent event stream for an aggregate. `assistant.delta` frames are transient
 * and never persisted, so replay only returns durable events. Exceeding the fixed window/page
 * limits signals REPLAY_WINDOW_EXCEEDED (public 410 RESYNC_REQUIRED).
 */
export async function replayEvents(
  tx: Prisma.TransactionClient,
  input: ReplayInput,
): Promise<ReplayResult> {
  const cursor = normalizeReplayCursor(input);
  const events = await tx.chatCommandEvent.findMany({
    where: {
      aggregateId: input.aggregateId,
      ...(cursor === null ? {} : { sequence: { gt: cursor } }),
    },
    orderBy: { sequence: "asc" },
    take: REPLAY_WINDOW_LIMIT + 1,
  });
  if (events.length > REPLAY_WINDOW_LIMIT) {
    return { events: [], cursor: null, windowExceeded: true };
  }
  const rendered = events.map((row) => ({
    eventId: row.eventId,
    sequence: row.sequence.toString(),
    aggregateId: row.aggregateId,
    traceId: row.traceId,
    type: row.type,
    status: row.status,
    occurredAt: row.occurredAt.toISOString(),
    payloadVersion: row.payloadVersion,
    payload: row.payloadJson,
  }));
  const last = rendered[rendered.length - 1];
  return { events: rendered, cursor: last ? last.sequence : cursor?.toString() ?? null, windowExceeded: false };
}

export function sseFrame(envelope: SseEnvelope): string {
  return `id: ${envelope.eventId}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/** Transient delta frame: only sent on the live connection, never persisted/replayed. */
export function deltaFrame(input: {
  eventId: string;
  deltaIndex: number;
  text: string;
}): string {
  const payload = {
    eventId: input.eventId,
    deltaIndex: input.deltaIndex,
    text: input.text,
  };
  return `id: ${input.eventId}\ndata: ${JSON.stringify(payload)}\n\n`;
}