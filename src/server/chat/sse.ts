import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";
import type { TravelRecordOwner } from "@/server/anonymous-owner";
import {
  advanceChatCheckpoint,
  validateChatEnvelope,
  type ChatEventEnvelope,
  type PersistentCheckpoint,
} from "@/lib/chat-stream";
import { readAuthClock } from "@/server/auth/clock";
import { authorizeCommand } from "./ownership";
import { envelopeFromRow, subscribeChatNotifications } from "./events";
import { ChatCommandError } from "./error-codes";

export const REPLAY_WINDOW_LIMIT = 1000;
export const REPLAY_BYTE_LIMIT = 256 * 1024;
export const REPLAY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const SSE_CONNECTION_MS = 60000;
export interface ReplayInput {
  owner: TravelRecordOwner;
  aggregateId: string;
  afterSequence?: string | null;
  lastEventId?: string | null;
}
export class ReplayWindowExceeded extends ChatCommandError {
  readonly internalReason = "REPLAY_WINDOW_EXCEEDED";
  readonly action = "RECONCILE_MESSAGES";
  constructor() {
    super("RESYNC_REQUIRED", 410);
  }
}
export function sseFrame(value: ChatEventEnvelope) {
  const envelope = validateChatEnvelope(value);
  return `id: ${envelope.eventId}\ndata: ${JSON.stringify(envelope)}\n\n`;
}
export function assertReplayWindow(events: readonly ChatEventEnvelope[], now: number) {
  if (
    events.length > REPLAY_WINDOW_LIMIT ||
    events.some((e) => now - Date.parse(e.occurredAt) > REPLAY_RETENTION_MS) ||
    events.reduce((sum, e) => sum + Buffer.byteLength(sseFrame(e)), 0) > REPLAY_BYTE_LIMIT
  )
    throw new ReplayWindowExceeded();
}
export async function replayEvents(tx: Prisma.TransactionClient, input: ReplayInput) {
  const command = await authorizeCommand(tx, input.owner, input.aggregateId),
    now = await readAuthClock(tx);
  const after = input.afterSequence;
  if (
    after !== undefined &&
    after !== null &&
    (!/^(0|[1-9][0-9]*)$/.test(after) || !Number.isSafeInteger(Number(after)))
  )
    throw new ChatCommandError("VALIDATION_ERROR", 400);
  let sequence = after ? Number(after) : 0,
    anchor: Date | undefined,
    anchorId: string | undefined;
  if (input.lastEventId !== undefined && input.lastEventId !== null) {
    if (!/^evt_[a-f0-9]{32}$/.test(input.lastEventId))
      throw new ChatCommandError("VALIDATION_ERROR", 400);
    const row = await tx.chatCommandEvent.findUnique({ where: { eventId: input.lastEventId } });
    if (row && row.aggregateId !== input.aggregateId) throw new ChatCommandError("NOT_FOUND", 404);
    if (!row) throw new ReplayWindowExceeded();
    if (after !== undefined && after !== null && Number(after) !== row.sequence)
      throw new ChatCommandError("VALIDATION_ERROR", 400);
    sequence = row.sequence;
    anchor = row.occurredAt;
    anchorId = row.eventId;
  } else if (sequence > 0) {
    const row = await tx.chatCommandEvent.findUnique({
      where: { aggregateId_sequence: { aggregateId: input.aggregateId, sequence } },
    });
    if (!row) throw new ReplayWindowExceeded();
    anchor = row.occurredAt;
    anchorId = row.eventId;
  }
  if (now.getTime() - (anchor ?? command.createdAt).getTime() > REPLAY_RETENTION_MS)
    throw new ReplayWindowExceeded();
  const rows = await tx.chatCommandEvent.findMany({
    where: { aggregateId: input.aggregateId, sequence: { gt: sequence } },
    orderBy: { sequence: "asc" },
    take: REPLAY_WINDOW_LIMIT + 1,
  });
  if (rows.some((row, index) => row.sequence !== sequence + index + 1))
    throw new ReplayWindowExceeded();
  const events = rows.map(envelopeFromRow);
  assertReplayWindow(events, now.getTime());
  return {
    events,
    status: command.status,
    checkpoint: events.reduce(
      advanceChatCheckpoint,
      anchorId ? ({ eventId: anchorId, sequence } as PersistentCheckpoint) : null,
    ),
  };
}
export async function reconcileCommand(
  client: PrismaClient,
  owner: TravelRecordOwner,
  commandId: string,
) {
  return client.$transaction(async (tx) => {
    const command = await authorizeCommand(tx, owner, commandId);
    const messages = await tx.chatMessage.findMany({
      where: { travelRecordId: command.travelRecordId },
      orderBy: { sequence: "asc" },
      select: {
        id: true,
        role: true,
        kind: true,
        content: true,
        contentJson: true,
        sequence: true,
        commandId: true,
      },
    });
    const last = await tx.chatCommandEvent.findFirst({
      where: { aggregateId: commandId },
      orderBy: { sequence: "desc" },
    });
    return {
      commandId,
      status: command.status,
      messages,
      checkpoint: last ? { eventId: last.eventId, sequence: last.sequence } : null,
    };
  });
}
/** Internal adapter for later registered HTTP routes. Disconnect closes transport only. */
export async function openChatEventStream(
  client: PrismaClient,
  input: ReplayInput,
  options: { databaseUrl?: string; signal?: AbortSignal; connectionMs?: number } = {},
): Promise<Response> {
  const connectionMs = options.connectionMs ?? SSE_CONNECTION_MS;
  if (!Number.isInteger(connectionMs) || connectionMs < 1 || connectionMs > SSE_CONNECTION_MS)
    throw new ChatCommandError("VALIDATION_ERROR", 400);
  try {
    await client.$transaction((tx) => replayEvents(tx, input));
  } catch (error) {
    if (error instanceof ReplayWindowExceeded)
      return Response.json(
        { error: { code: "RESYNC_REQUIRED", action: error.action } },
        { status: 410, headers: { "cache-control": "no-store" } },
      );
    throw error;
  }
  let finish: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false,
        replayed = false,
        bytes = 0,
        count = 0,
        cursor: PersistentCheckpoint = null;
      let pollTimer: ReturnType<typeof setInterval> | undefined,
        lifetime: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => Promise<void>) | undefined;
      let queue = Promise.resolve();
      const enqueue = (event: ChatEventEnvelope) => {
        if (
          closed ||
          (event.type !== "assistant.delta" && cursor && event.sequence <= cursor.sequence)
        )
          return;
        const frame = new TextEncoder().encode(sseFrame(event));
        if (bytes + frame.byteLength > REPLAY_BYTE_LIMIT || ++count > REPLAY_WINDOW_LIMIT) {
          finish();
          return;
        }
        bytes += frame.byteLength;
        controller.enqueue(frame);
        cursor = advanceChatCheckpoint(cursor, event);
      };
      finish = () => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (lifetime) clearTimeout(lifetime);
        options.signal?.removeEventListener("abort", finish);
        void unsubscribe?.().catch(() => {});
        try {
          controller.close();
        } catch {
          /* reader already cancelled */
        }
      };
      const schedule = (job: () => Promise<void>) => {
        queue = queue
          .then(async () => {
            if (!closed) await job();
          })
          .catch(() => finish());
      };
      const poll = async () => {
        const replay = await client.$transaction((tx) =>
          replayEvents(
            tx,
            cursor
              ? {
                  ...input,
                  lastEventId: cursor.eventId,
                  afterSequence: String(cursor.sequence),
                }
              : input,
          ),
        );
        for (const event of replay.events) enqueue(event);
        if (["COMPLETED", "FAILED", "CANCELLED"].includes(replay.status)) finish();
      };
      options.signal?.addEventListener("abort", finish, { once: true });
      if (options.signal?.aborted) {
        finish();
        return;
      }
      try {
        unsubscribe = await subscribeChatNotifications(
          options.databaseUrl ?? env.DATABASE_URL,
          (notice) => {
            if (notice.kind === "persistent" && notice.aggregateId === input.aggregateId)
              schedule(poll);
            if (
              replayed &&
              notice.kind === "delta" &&
              notice.event.aggregateId === input.aggregateId
            )
              schedule(async () => {
                const command = await client.$transaction((tx) =>
                  authorizeCommand(tx, input.owner, input.aggregateId),
                );
                if (command.status === "RUNNING") enqueue(notice.event);
              });
          },
          finish,
        );
        if (closed) {
          await unsubscribe();
          return;
        }
        schedule(async () => {
          await poll();
          replayed = true;
        });
        pollTimer = setInterval(() => schedule(poll), 100);
        lifetime = setTimeout(finish, connectionMs);
      } catch {
        finish();
      }
    },
    cancel() {
      finish();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
