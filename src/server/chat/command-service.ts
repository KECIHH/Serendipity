import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { canonicalHash } from "@/lib/ai/schemas";
import type { TravelRecordOwner } from "@/server/anonymous-owner";
import { parseDataIdentifier, readDataLayerObject } from "@/server/repositories/data-layer-error";
import { readAuthClock } from "@/server/auth/clock";
import { enqueueTask } from "@/server/tasks/durable-task";
import { storeTaskPayload } from "@/server/tasks/payload";
import { appendCommandEvent } from "./events";
import { authorizeRecord, ownerDomains, ownerKeyHash } from "./ownership";
import { ChatCommandError } from "./error-codes";

export const COMMAND_IDEMPOTENCY_TTL_SECONDS = 86400;
export type CommandKind = "CHAT_MESSAGE" | "PLAN_DRAFT";
export interface CreateOrResumeChatCommandInput {
  owner: TravelRecordOwner;
  travelRecordId: string;
  kind?: CommandKind;
  idempotencyKey: string;
  message: string;
  clientMessageId: string;
  traceId: string;
}
export interface CreateOrResumeChatCommandResult {
  travelRecordId: string;
  commandId: string;
  userMessageId: string;
  replayed: boolean;
  ownerType: "USER" | "ANONYMOUS";
}
export function parseCommandText(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    !value.trim() ||
    Array.from(value.trim()).length > 8000 ||
    Buffer.byteLength(value.trim()) > 32768
  )
    throw new ChatCommandError("VALIDATION_ERROR");
  return value.trim();
}
function parseInput(input: CreateOrResumeChatCommandInput, initial: boolean) {
  const row = readDataLayerObject(
    input,
    ["owner", "travelRecordId", "kind", "idempotencyKey", "message", "clientMessageId", "traceId"],
    ["owner", "travelRecordId", "idempotencyKey", "message", "clientMessageId", "traceId"],
  );
  const kind: CommandKind = initial ? "PLAN_DRAFT" : "CHAT_MESSAGE";
  if (row.kind !== undefined && row.kind !== kind) throw new ChatCommandError("VALIDATION_ERROR");
  if (
    typeof row.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(row.idempotencyKey)
  )
    throw new ChatCommandError("VALIDATION_ERROR");
  if (
    typeof row.clientMessageId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.clientMessageId)
  )
    throw new ChatCommandError("VALIDATION_ERROR");
  return {
    owner: input.owner,
    kind,
    travelRecordId: parseDataIdentifier(row.travelRecordId),
    message: parseCommandText(row.message),
    clientMessageId: row.clientMessageId,
    traceId: parseDataIdentifier(row.traceId),
    idempotencyKeyHash: createHash("sha256").update(row.idempotencyKey).digest("hex"),
  };
}
export async function nextMessageSequence(tx: Prisma.TransactionClient, travelRecordId: string) {
  const last = await tx.chatMessage.findFirst({
    where: { travelRecordId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  if (last?.sequence === 2147483647) throw new ChatCommandError("INTERNAL_ERROR", 500);
  return (last?.sequence ?? 0) + 1;
}
async function insertCommand(
  tx: Prisma.TransactionClient,
  input: CreateOrResumeChatCommandInput,
  initial: boolean,
) {
  const parsed = parseInput(input, initial),
    ownerHash = ownerKeyHash(parsed.owner);
  if (parsed.owner.anonTokenHash !== undefined)
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      "anon:" + parsed.owner.anonTokenHash,
    );
  await tx.$executeRawUnsafe(
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    "command:" + ownerHash + ":" + parsed.kind + ":" + parsed.idempotencyKeyHash,
  );
  await authorizeRecord(tx, {
    owner: parsed.owner,
    travelRecordId: parsed.travelRecordId,
    write: true,
  });
  const requestHash = canonicalHash({
    kind: parsed.kind,
    travelRecordId: parsed.travelRecordId,
    message: parsed.message,
    clientMessageId: parsed.clientMessageId,
  });
  const existing = await tx.commandIdempotency.findMany({
    where: {
      ownerKeyHash: { in: await ownerDomains(tx, parsed.owner) },
      kind: parsed.kind,
      idempotencyKeyHash: parsed.idempotencyKeyHash,
    },
  });
  if (existing.length) {
    if (existing.length !== 1 || existing[0].requestHash !== requestHash || !existing[0].commandId)
      throw new ChatCommandError("IDEMPOTENCY_KEY_REUSED", 409);
    const command = await tx.chatCommand.findUniqueOrThrow({
      where: { id: existing[0].commandId },
    });
    // Authorization is from the current record, never from the historical idempotency domain.
    await authorizeRecord(tx, { owner: parsed.owner, travelRecordId: command.travelRecordId });
    return {
      travelRecordId: command.travelRecordId,
      commandId: command.id,
      userMessageId: command.userMessageId,
      replayed: true,
      ownerType: parsed.owner.userId !== undefined ? ("USER" as const) : ("ANONYMOUS" as const),
    };
  }
  if (
    await tx.chatMessage.findUnique({
      where: {
        travelRecordId_clientMessageId: {
          travelRecordId: parsed.travelRecordId,
          clientMessageId: parsed.clientMessageId,
        },
      },
    })
  )
    throw new ChatCommandError("IDEMPOTENCY_KEY_REUSED", 409);
  const now = await readAuthClock(tx),
    commandId = "cmd_" + randomUUID().replaceAll("-", "");
  const payload = await storeTaskPayload(tx, {
    ownerKeyHash: ownerHash,
    schemaVersion: 1,
    now,
    value: { schemaVersion: 1, message: parsed.message, locale: "zh-CN" },
  });
  const user = await tx.chatMessage.create({
    data: {
      travelRecordId: parsed.travelRecordId,
      commandId,
      role: "USER",
      kind: "TEXT",
      content: parsed.message,
      contentJson: Prisma.DbNull,
      clientMessageId: parsed.clientMessageId,
      sequence: await nextMessageSequence(tx, parsed.travelRecordId),
    },
  });
  const command = await tx.chatCommand.create({
    data: {
      id: commandId,
      travelRecordId: parsed.travelRecordId,
      ownerKeyHash: ownerHash,
      kind: parsed.kind,
      idempotencyKeyHash: parsed.idempotencyKeyHash,
      requestHash,
      payloadRef: payload.payloadRef,
      payloadSchemaVersion: payload.payloadSchemaVersion,
      status: "PENDING",
      userMessageId: user.id,
      traceId: parsed.traceId,
      createdAt: now,
    },
  });
  const accepted: CreateOrResumeChatCommandResult = {
    travelRecordId: command.travelRecordId,
    commandId: command.id,
    userMessageId: user.id,
    replayed: false,
    ownerType: parsed.owner.userId !== undefined ? "USER" : "ANONYMOUS",
  };
  await tx.commandIdempotency.create({
    data: {
      ownerKeyHash: ownerHash,
      kind: parsed.kind,
      idempotencyKeyHash: parsed.idempotencyKeyHash,
      requestHash,
      commandId: command.id,
      status: "PENDING",
      responseJson: { ...accepted },
      expiresAt: new Date(now.getTime() + COMMAND_IDEMPOTENCY_TTL_SECONDS * 1000),
    },
  });
  await enqueueTask(tx, {
    kind: "CHAT_COMMAND",
    aggregateId: command.id,
    commandId: command.id,
    ...payload,
  });
  await appendCommandEvent(tx, {
    commandId: command.id,
    traceId: command.traceId,
    type: "message.accepted",
    status: "PENDING",
    now,
    payload: {
      commandId: command.id,
      travelRecordId: command.travelRecordId,
      message: {
        id: user.id,
        role: user.role,
        kind: user.kind,
        content: user.content,
        sequence: user.sequence,
        clientMessageId: user.clientMessageId,
      },
      conversationCursor: { travelRecordId: command.travelRecordId, sequence: user.sequence },
    },
  });
  return accepted;
}
/** Internal transaction primitive. The caller may create the record in this same transaction. */
export function insertInitialPlanDraftCommand(
  tx: Prisma.TransactionClient,
  input: CreateOrResumeChatCommandInput,
) {
  return insertCommand(tx, input, true);
}
/** Accept into an already owned record. No cookie, user, record or provider is implicitly created. */
export function acceptCommand(tx: Prisma.TransactionClient, input: CreateOrResumeChatCommandInput) {
  return insertCommand(tx, input, false);
}
export async function createOrResumeChatCommand(
  client: PrismaClient,
  input: CreateOrResumeChatCommandInput,
) {
  return client.$transaction((tx) => acceptCommand(tx, input), { maxWait: 15000, timeout: 15000 });
}
