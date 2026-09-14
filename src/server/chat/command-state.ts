import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { ChatCommandError } from "@/server/chat/error-codes";

/**
 * ChatCommand state machine transitions. A command has exactly one USER message, at most one
 * final ASSISTANT message, and exactly one terminal persistent event. Every transition is a
 * guarded CAS so only one database winner ever advances the command.
 */

export interface ClaimCommandInput {
  commandId: string;
  leaseOwner: string;
  now?: number;
}

/** PENDING→RUNNING: at most one worker wins. */
export async function claimCommand(
  tx: Prisma.TransactionClient,
  input: ClaimCommandInput,
): Promise<boolean> {
  const now = typeof input.now === "number" ? new Date(input.now) : new Date();
  const result = await tx.chatCommand.updateMany({
    where: { id: input.commandId, status: "PENDING" },
    data: { status: "RUNNING", startedAt: now, updatedAt: now },
  });
  if (result.count !== 1) throw new Error("COMMAND_NOT_CLAIMABLE");
  return true;
}

export interface CompleteCommandInput {
  commandId: string;
  leaseOwner: string;
  assistantContent: string;
  now?: number;
}

/** RUNNING→COMPLETED: writes exactly one final ASSISTANT message and the terminal event. */
export async function completeCommand(
  tx: Prisma.TransactionClient,
  input: CompleteCommandInput,
): Promise<{ assistantMessageId: string; eventId: string }> {
  const now = typeof input.now === "number" ? new Date(input.now) : new Date();
  const command = await tx.chatCommand.findUnique({ where: { id: input.commandId } });
  if (!command || command.status !== "RUNNING") throw new Error("COMMAND_NOT_CLAIMABLE");

  const nextSequence = await tx.chatMessage.count({ where: { travelRecordId: command.travelRecordId } });
  const assistant = await tx.chatMessage.create({
    data: {
      travelRecordId: command.travelRecordId,
      role: "ASSISTANT",
      kind: "STRUCTURED",
      content: "",
      contentJson: JSON.parse(input.assistantContent),
      sequence: nextSequence + 1,
    },
  });
  const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
  const event = await tx.chatCommandEvent.create({
    data: {
      eventId,
      aggregateId: command.id,
      traceId: command.traceId,
      type: "assistant.completed",
      status: "COMPLETED",
      occurredAt: now,
      payloadVersion: 1,
      payloadJson: {
        commandId: command.id,
        message: { id: assistant.id, content: assistant.contentJson },
        conversationCursor: { travelRecordId: command.travelRecordId, sequence: assistant.sequence },
      },
    },
  });
  const updated = await tx.chatCommand.updateMany({
    where: { id: command.id, status: "RUNNING" },
    data: {
      status: "COMPLETED",
      assistantMessageId: assistant.id,
      completedAt: now,
      updatedAt: now,
    },
  });
  if (updated.count !== 1) throw new Error("COMMAND_NOT_CLAIMABLE");
  await tx.commandIdempotency.updateMany({
    where: { commandId: command.id },
    data: { status: "COMPLETED", responseJson: assistant.contentJson as Prisma.InputJsonValue },
  });
  return { assistantMessageId: assistant.id, eventId: event.eventId };
}

export interface FailCommandInput {
  commandId: string;
  leaseOwner: string;
  errorCode: string;
  errorMessage: string;
  now?: number;
}

/** RUNNING|PENDING→FAILED: no assistant message, safe error and USER intent retained. */
export async function failCommand(
  tx: Prisma.TransactionClient,
  input: FailCommandInput,
): Promise<void> {
  const now = typeof input.now === "number" ? new Date(input.now) : new Date();
  const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
  const command = await tx.chatCommand.findUnique({ where: { id: input.commandId } });
  if (!command || command.status === "COMPLETED" || command.status === "CANCELLED") {
    throw new Error("COMMAND_NOT_CLAIMABLE");
  }
  const event = await tx.chatCommandEvent.create({
    data: {
      eventId,
      aggregateId: command.id,
      traceId: command.traceId,
      type: "command.failed",
      status: "FAILED",
      occurredAt: now,
      payloadVersion: 1,
      payloadJson: { commandId: command.id, error: { code: input.errorCode, message: input.errorMessage } },
    },
  });
  await tx.chatCommand.updateMany({
    where: { id: command.id, status: { in: ["RUNNING", "PENDING"] } },
    data: {
      status: "FAILED",
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      completedAt: now,
      updatedAt: now,
    },
  });
  await tx.commandIdempotency.updateMany({
    where: { commandId: command.id },
    data: { status: "FAILED", responseJson: { error: input.errorCode } as Prisma.InputJsonValue },
  });
  void event;
}

export interface CancelCommandInput {
  commandId: string;
  leaseOwner: string;
  now?: number;
}

/** PENDING|RUNNING→CANCELLED by the owner; unique terminal event, no assistant final. */
export async function cancelCommand(
  tx: Prisma.TransactionClient,
  input: CancelCommandInput,
): Promise<{ winner: "CANCELLED" | "COMPLETED" }> {
  const now = typeof input.now === "number" ? new Date(input.now) : new Date();
  const command = await tx.chatCommand.findUnique({ where: { id: input.commandId } });
  if (!command) throw new ChatCommandError("NOT_FOUND", 404);
  if (command.status === "COMPLETED" || command.status === "CANCELLED" || command.status === "FAILED") {
    return { winner: command.status === "COMPLETED" ? "COMPLETED" : "CANCELLED" };
  }
  const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
  await tx.chatCommandEvent.create({
    data: {
      eventId,
      aggregateId: command.id,
      traceId: command.traceId,
      type: "command.cancelled",
      status: "CANCELLED",
      occurredAt: now,
      payloadVersion: 1,
      payloadJson: { commandId: command.id },
    },
  });
  const updated = await tx.chatCommand.updateMany({
    where: { id: command.id, status: { in: ["PENDING", "RUNNING"] } },
    data: { status: "CANCELLED", completedAt: now, updatedAt: now },
  });
  if (updated.count === 1) {
    await tx.commandIdempotency.updateMany({
      where: { commandId: command.id },
      data: { status: "CANCELLED", responseJson: { cancelled: true } as Prisma.InputJsonValue },
    });
    return { winner: "CANCELLED" };
  }
  return { winner: "COMPLETED" };
}