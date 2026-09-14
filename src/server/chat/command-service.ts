import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma, type ChatCommandStatus } from "@prisma/client";
import { canonicalHash } from "@/lib/ai/schemas";
import { ChatCommandError } from "@/server/chat/error-codes";
import { parseTravelRecordOwner, type TravelRecordOwner } from "@/server/anonymous-owner";
import {
  DataLayerError,
  parseDataIdentifier,
  parsePositiveSequence,
  readDataLayerObject,
  runDataLayerOperation,
} from "@/server/repositories/data-layer-error";
import { lockOwnedTravelRecord } from "@/server/repositories/travel-record";

export const COMMAND_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
export type CommandKind = "CHAT_MESSAGE" | "PLAN_DRAFT";

export interface AcceptCommandInput {
  owner: TravelRecordOwner;
  travelRecordId: string;
  kind: CommandKind;
  idempotencyKeyHash: string;
  requestHash: string;
  userMessageId: string;
  userMessageContent: string;
  sequence: number;
  traceId: string;
  payloadRef?: string | null;
  payloadSchemaVersion?: number | null;
  now?: number;
}

export interface AcceptCommandResult {
  commandId: string;
  userMessageId: string;
  replayed: boolean;
  command: {
    id: string;
    status: ChatCommandStatus;
    kind: CommandKind;
    traceId: string;
    ownerKeyHash: string;
  };
}

function parseKind(value: unknown): CommandKind {
  if (value === "CHAT_MESSAGE" || value === "PLAN_DRAFT") return value;
  throw new DataLayerError("VALIDATION_ERROR");
}

function parseHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new DataLayerError("VALIDATION_ERROR");
  }
  return value;
}

function parseOptionalRef(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return parseDataIdentifier(value);
}

/**
 * The atomic accept transaction. Creates the USER message, the ChatCommand, the idempotency
 * ledger row and the `message.accepted` event in one database transaction. Any failure makes
 * the transaction's record/message/command/event count zero.
 */
export async function acceptCommand(
  tx: Prisma.TransactionClient,
  input: AcceptCommandInput,
): Promise<AcceptCommandResult> {
  const fields = readDataLayerObject(
    input,
    [
      "owner",
      "travelRecordId",
      "kind",
      "idempotencyKeyHash",
      "requestHash",
      "userMessageId",
      "userMessageContent",
      "sequence",
      "traceId",
      "payloadRef",
      "payloadSchemaVersion",
      "now",
    ],
    [
      "owner",
      "travelRecordId",
      "kind",
      "idempotencyKeyHash",
      "requestHash",
      "userMessageId",
      "userMessageContent",
      "sequence",
      "traceId",
    ],
  );
  const owner = parseTravelRecordOwner(fields.owner);
  const travelRecordId = parseDataIdentifier(fields.travelRecordId);
  const kind = parseKind(fields.kind);
  const idempotencyKeyHash = parseHash(fields.idempotencyKeyHash, "idempotencyKeyHash");
  const requestHash = parseHash(fields.requestHash, "requestHash");
  const userMessageId = parseDataIdentifier(fields.userMessageId);
  const userMessageContent = String(fields.userMessageContent);
  const sequence = parsePositiveSequence(fields.sequence);
  const traceId = parseDataIdentifier(fields.traceId);
  const payloadRef = parseOptionalRef(fields.payloadRef);
  const payloadSchemaVersion =
    fields.payloadSchemaVersion === null || fields.payloadSchemaVersion === undefined
      ? null
      : Number(fields.payloadSchemaVersion);
  const now = typeof fields.now === "number" ? fields.now : Date.now();
  const ownerKeyHash = owner.userId ?? owner.anonTokenHash;
  if (userMessageContent.trim().length === 0) throw new DataLayerError("VALIDATION_ERROR");

  const commandId = `cmd_${randomUUID().replaceAll("-", "")}`;
  const eventId = `evt_${randomUUID().replaceAll("-", "")}`;

  await lockOwnedTravelRecord(tx, { owner, travelRecordId });
  const record = await tx.travelRecord.findUnique({ where: { id: travelRecordId } });
  if (!record || record.status === "ARCHIVED") throw new DataLayerError("NOT_FOUND");

  const existing = await tx.commandIdempotency.findUnique({
    where: {
      ownerKeyHash_kind_idempotencyKeyHash: { ownerKeyHash, kind, idempotencyKeyHash },
    },
  });
  if (existing) {
    if (existing.requestHash !== requestHash) throw new DataLayerError("IDEMPOTENCY_KEY_REUSED");
    const existingCommand = existing.commandId
      ? await tx.chatCommand.findUnique({ where: { id: existing.commandId } })
      : null;
    if (!existingCommand) throw new DataLayerError("INTERNAL_ERROR");
    return {
      commandId: existingCommand.id,
      userMessageId: existingCommand.userMessageId,
      replayed: true,
      command: {
        id: existingCommand.id,
        status: existingCommand.status,
        kind: existingCommand.kind,
        traceId: existingCommand.traceId,
        ownerKeyHash: existingCommand.ownerKeyHash,
      },
    };
  }

  const userMessage = await tx.chatMessage.create({
    data: {
      travelRecordId,
      role: "USER",
      kind: "TEXT",
      content: userMessageContent,
      contentJson: Prisma.DbNull,
      sequence,
      clientMessageId: userMessageId,
    },
  });
  const command = await tx.chatCommand.create({
    data: {
      id: commandId,
      travelRecordId,
      ownerKeyHash,
      kind,
      idempotencyKeyHash,
      requestHash,
      payloadRef,
      payloadSchemaVersion,
      status: "PENDING",
      userMessageId: userMessage.id,
      traceId,
    },
  });
  await tx.commandIdempotency.create({
    data: {
      ownerKeyHash,
      kind,
      idempotencyKeyHash,
      requestHash,
      commandId: command.id,
      status: "PENDING",
      expiresAt: new Date(now + COMMAND_IDEMPOTENCY_TTL_SECONDS * 1000),
    },
  });
  await tx.chatCommandEvent.create({
    data: {
      eventId,
      aggregateId: command.id,
      traceId,
      type: "message.accepted",
      status: "PENDING",
      occurredAt: new Date(now),
      payloadVersion: 1,
      payloadJson: {
        commandId: command.id,
        travelRecordId,
        message: {
          id: userMessage.id,
          role: "USER",
          content: userMessageContent,
          sequence,
          clientMessageId: userMessageId,
        },
        conversationCursor: { travelRecordId, sequence: userMessage.sequence },
      },
    },
  });
  return {
    commandId: command.id,
    userMessageId: userMessage.id,
    replayed: false,
    command: {
      id: command.id,
      status: command.status,
      kind: command.kind,
      traceId: command.traceId,
      ownerKeyHash: command.ownerKeyHash,
    },
  };
}

export interface CreateOrResumeChatCommandInput {
  owner: TravelRecordOwner;
  travelRecordId: string;
  kind: CommandKind;
  idempotencyKey: string;
  message: string;
  clientMessageId: string;
  traceId: string;
  payloadRef?: string | null;
  payloadSchemaVersion?: number | null;
  now?: number;
}

export interface CreateOrResumeChatCommandResult {
  travelRecordId: string;
  commandId: string;
  userMessageId: string;
  replayed: boolean;
  ownerType: "USER" | "ANONYMOUS";
}

export interface ChatCommandPorts {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  chatCommand: Prisma.TransactionClient["chatCommand"];
}

/**
 * Public entry point. Derives the owner server-side, validates the idempotency key and
 * request hash, and accepts a command transactionally. Same key+hash replays with the
 * original IDs; same key with a different hash returns 409 with zero side effects.
 */
export async function createOrResumeChatCommand(
  db: ChatCommandPorts,
  input: CreateOrResumeChatCommandInput,
): Promise<CreateOrResumeChatCommandResult> {
  const fields = readDataLayerObject(
    input,
    [
      "owner",
      "travelRecordId",
      "kind",
      "idempotencyKey",
      "message",
      "clientMessageId",
      "traceId",
      "payloadRef",
      "payloadSchemaVersion",
      "now",
    ],
    ["owner", "travelRecordId", "kind", "idempotencyKey", "message", "clientMessageId", "traceId"],
  );
  const owner = parseTravelRecordOwner(fields.owner);
  const travelRecordId = parseDataIdentifier(fields.travelRecordId);
  const kind = parseKind(fields.kind);
  const idempotencyKey = String(fields.idempotencyKey);
  if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
    throw new ChatCommandError("VALIDATION_ERROR");
  }
  const message = String(fields.message);
  const clientMessageId = parseDataIdentifier(fields.clientMessageId);
  const traceId = parseDataIdentifier(fields.traceId);
  const payloadRef = parseOptionalRef(fields.payloadRef);
  const payloadSchemaVersion =
    fields.payloadSchemaVersion === null || fields.payloadSchemaVersion === undefined
      ? null
      : Number(fields.payloadSchemaVersion);
  const idempotencyKeyHash = canonicalHash(idempotencyKey);
  const requestHash = canonicalHash({
    kind,
    travelRecordId,
    message,
    clientMessageId,
    payloadRef,
    payloadSchemaVersion,
  });

  const accepted = await runDataLayerOperation(() =>
    db.$transaction(async (tx) =>
      acceptCommand(tx, {
        owner,
        travelRecordId,
        kind,
        idempotencyKeyHash,
        requestHash,
        userMessageId: clientMessageId,
        userMessageContent: message,
        sequence: await nextSequence(tx, travelRecordId),
        traceId,
        payloadRef,
        payloadSchemaVersion,
        now: typeof fields.now === "number" ? fields.now : undefined,
      }),
    ),
  ).catch((error) => {
    if (error instanceof DataLayerError && error.code === "IDEMPOTENCY_KEY_REUSED") {
      throw new ChatCommandError("IDEMPOTENCY_KEY_REUSED", 409);
    }
    throw error;
  });
  const ownerType = owner.userId !== undefined ? ("USER" as const) : ("ANONYMOUS" as const);
  if (accepted.replayed) {
    const existing = await db.chatCommand.findUnique({ where: { id: accepted.commandId } });
    if (!existing) throw new ChatCommandError("NOT_FOUND", 404);
    return {
      travelRecordId,
      commandId: existing.id,
      userMessageId: existing.userMessageId,
      replayed: true,
      ownerType,
    };
  }
  return {
    travelRecordId,
    commandId: accepted.commandId,
    userMessageId: accepted.userMessageId,
    replayed: false,
    ownerType,
  };
}

async function nextSequence(tx: Prisma.TransactionClient, travelRecordId: string): Promise<number> {
  const last = await tx.chatMessage.findFirst({
    where: { travelRecordId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  return (last?.sequence ?? 0) + 1;
}