import "server-only";

import { Prisma, type ChatMessage, type ChatMessageKind, type MessageRole } from "@prisma/client";

import { parseTravelRecordOwner, type TravelRecordOwner } from "@/server/anonymous-owner";
import { db } from "@/server/db";
import {
  DataLayerError,
  parseDataIdentifier,
  parsePositiveSequence,
  readDataLayerObject,
  requireAbsentJson,
  runDataLayerOperation,
} from "@/server/repositories/data-layer-error";
import { lockOwnedTravelRecord } from "@/server/repositories/travel-record";

export interface AppendChatMessageInput {
  owner: TravelRecordOwner;
  travelRecordId: string;
  sequence: number;
  role: MessageRole;
  kind: ChatMessageKind;
  content: string;
  contentJson?: null;
  clientMessageId?: string | null;
  replyToMessageId?: string | null;
}

export interface AppendChatMessageResult {
  message: ChatMessage;
  replayed: boolean;
}

export interface ChatMessageCursor {
  travelRecordId: string;
  sequence: number;
  id: string;
}

export interface ListChatMessagesInput {
  owner: TravelRecordOwner;
  travelRecordId: string;
  cursor?: string | null;
  limit?: number;
}

export interface ChatMessagePage {
  messages: ChatMessage[];
  nextCursor: string | null;
}

function parseOptionalIdentifier(value: unknown): string | null {
  return value === null || value === undefined ? null : parseDataIdentifier(value);
}

function parseMessageRole(value: unknown): MessageRole {
  if (value === "USER" || value === "ASSISTANT" || value === "SYSTEM") return value;
  throw new DataLayerError("VALIDATION_ERROR");
}

function parseTextContent(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.includes("\0") ||
    value.trim().length === 0
  ) {
    throw new DataLayerError("VALIDATION_ERROR");
  }
  return value;
}

/** Repository cursor only; the later HTTP boundary adds its signed envelope. */
export function encodeChatMessageCursor(input: ChatMessageCursor): string {
  const fields = readDataLayerObject(
    input,
    ["travelRecordId", "sequence", "id"],
    ["travelRecordId", "sequence", "id"],
  );
  return Buffer.from(
    JSON.stringify([
      parseDataIdentifier(fields.travelRecordId),
      parsePositiveSequence(fields.sequence),
      parseDataIdentifier(fields.id),
    ]),
    "utf8",
  ).toString("base64url");
}

export function decodeChatMessageCursor(cursor: string): ChatMessageCursor {
  if (typeof cursor !== "string" || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new DataLayerError("VALIDATION_ERROR");
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 3) {
      throw new DataLayerError("VALIDATION_ERROR");
    }
    const value = {
      travelRecordId: parseDataIdentifier(decoded[0]),
      sequence: parsePositiveSequence(decoded[1]),
      id: parseDataIdentifier(decoded[2]),
    };
    if (encodeChatMessageCursor(value) !== cursor) {
      throw new DataLayerError("VALIDATION_ERROR");
    }
    return value;
  } catch {
    throw new DataLayerError("VALIDATION_ERROR");
  }
}

export async function appendChatMessage(
  input: AppendChatMessageInput,
): Promise<AppendChatMessageResult> {
  const fields = readDataLayerObject(
    input,
    [
      "owner",
      "travelRecordId",
      "sequence",
      "role",
      "kind",
      "content",
      "contentJson",
      "clientMessageId",
      "replyToMessageId",
    ],
    ["owner", "travelRecordId", "sequence", "role", "kind", "content"],
  );
  const owner = parseTravelRecordOwner(fields.owner);
  const travelRecordId = parseDataIdentifier(fields.travelRecordId);
  const sequence = parsePositiveSequence(fields.sequence);
  const role = parseMessageRole(fields.role);
  if (fields.kind !== "TEXT") throw new DataLayerError("VALIDATION_ERROR");
  requireAbsentJson(fields.contentJson);
  const content = parseTextContent(fields.content);
  const clientMessageId = parseOptionalIdentifier(fields.clientMessageId);
  const replyToMessageId = parseOptionalIdentifier(fields.replyToMessageId);

  return runDataLayerOperation(() =>
    db.$transaction(async (transaction) => {
      await lockOwnedTravelRecord(transaction, { owner, travelRecordId });
      if (clientMessageId !== null) {
        const previous = await transaction.chatMessage.findUnique({
          where: { travelRecordId_clientMessageId: { travelRecordId, clientMessageId } },
        });
        if (previous) {
          if (
            previous.role !== role ||
            previous.kind !== "TEXT" ||
            previous.content !== content ||
            previous.contentJson !== null ||
            previous.replyToMessageId !== replyToMessageId
          ) {
            throw new DataLayerError("IDEMPOTENCY_KEY_REUSED");
          }
          return { message: previous, replayed: true };
        }
      }
      if (replyToMessageId !== null) {
        const reply = await transaction.chatMessage.findFirst({
          where: { id: replyToMessageId, travelRecordId },
          select: { id: true },
        });
        if (!reply) throw new DataLayerError("VALIDATION_ERROR");
      }
      const message = await transaction.chatMessage.create({
        data: {
          travelRecordId,
          sequence,
          role,
          kind: "TEXT",
          content,
          contentJson: Prisma.DbNull,
          clientMessageId,
          replyToMessageId,
        },
      });
      return { message, replayed: false };
    }),
  );
}

export async function listChatMessages(input: ListChatMessagesInput): Promise<ChatMessagePage> {
  const fields = readDataLayerObject(
    input,
    ["owner", "travelRecordId", "cursor", "limit"],
    ["owner", "travelRecordId"],
  );
  const owner = parseTravelRecordOwner(fields.owner);
  const travelRecordId = parseDataIdentifier(fields.travelRecordId);
  const limit = fields.limit === undefined ? 20 : fields.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new DataLayerError("VALIDATION_ERROR");
  }
  let cursor: ChatMessageCursor | null = null;
  if (fields.cursor !== undefined && fields.cursor !== null) {
    if (typeof fields.cursor !== "string") throw new DataLayerError("VALIDATION_ERROR");
    cursor = decodeChatMessageCursor(fields.cursor);
    if (cursor.travelRecordId !== travelRecordId) {
      throw new DataLayerError("VALIDATION_ERROR");
    }
  }
  return runDataLayerOperation(() =>
    db.$transaction(async (transaction) => {
      await lockOwnedTravelRecord(transaction, { owner, travelRecordId });
      if (cursor !== null) {
        const anchor = await transaction.chatMessage.findFirst({
          where: {
            id: cursor.id,
            travelRecordId,
            sequence: cursor.sequence,
          },
          select: { id: true },
        });
        if (!anchor) throw new DataLayerError("VALIDATION_ERROR");
      }
      const rows = await transaction.chatMessage.findMany({
        where: {
          travelRecordId,
          ...(cursor === null ? {} : { sequence: { gt: cursor.sequence } }),
        },
        orderBy: [{ sequence: "asc" }, { id: "asc" }],
        take: limit + 1,
      });
      const messages = rows.slice(0, limit);
      const last = messages[messages.length - 1];
      return {
        messages,
        nextCursor:
          rows.length > limit && last
            ? encodeChatMessageCursor({ travelRecordId, sequence: last.sequence, id: last.id })
            : null,
      };
    }),
  );
}
