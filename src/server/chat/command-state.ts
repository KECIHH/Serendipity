import "server-only";
import { Prisma, type PrismaClient, type ChatCommandStatus } from "@prisma/client";
import { readAuthClock } from "@/server/auth/clock";
import type { TravelRecordOwner } from "@/server/anonymous-owner";
import {
  assertTaskLease,
  cancelTask,
  completeTask,
  failTask,
  type TaskLease,
} from "@/server/tasks/durable-task";
import { nextMessageSequence } from "./command-service";
import { authorizeCommand, authorizeWorkerCommand } from "./ownership";
import { appendCommandEvent } from "./events";
import {
  ChatCommandError,
  chatErrorMessage,
  isChatErrorCode,
  type ChatErrorCode,
} from "./error-codes";

const controllers = new Map<string, Set<AbortController>>();
export function bindCommandController(commandId: string, controller: AbortController) {
  const set = controllers.get(commandId) ?? new Set<AbortController>();
  set.add(controller);
  controllers.set(commandId, set);
  return () => {
    set.delete(controller);
    if (!set.size) controllers.delete(commandId);
  };
}
export interface AssistantContent {
  schemaVersion: 1;
  kind: "MESSAGE" | "NEEDS_INFORMATION";
  text: string;
}
export function parseAssistantContent(value: unknown): AssistantContent {
  const input: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ChatCommandError("PROVIDER_UNAVAILABLE", 503);
  const row = input as AssistantContent;
  if (
    Object.keys(row).sort().join() !== "kind,schemaVersion,text" ||
    row.schemaVersion !== 1 ||
    !["MESSAGE", "NEEDS_INFORMATION"].includes(row.kind) ||
    typeof row.text !== "string" ||
    !row.text.isWellFormed() ||
    !row.text.trim() ||
    Array.from(row.text).length > 8000 ||
    Buffer.byteLength(row.text) > 32768
  )
    throw new ChatCommandError("PROVIDER_UNAVAILABLE", 503);
  return row;
}
export async function claimCommand(
  tx: Prisma.TransactionClient,
  input: TaskLease & { commandId: string },
) {
  const { command } = await authorizeWorkerCommand(tx, input.commandId);
  if (["COMPLETED", "FAILED", "CANCELLED"].includes(command.status)) return false;
  const task = await assertTaskLease(tx, input);
  if (task.commandId !== command.id) throw new ChatCommandError("NOT_FOUND", 404);
  if (command.status === "PENDING") {
    const now = await readAuthClock(tx);
    const changed = await tx.chatCommand.updateMany({
      where: { id: command.id, status: "PENDING" },
      data: { status: "RUNNING", startedAt: now },
    });
    if (changed.count !== 1) return false;
    await tx.commandIdempotency.updateMany({
      where: { commandId: command.id },
      data: { status: "RUNNING" },
    });
  }
  return true;
}
async function winner(tx: Prisma.TransactionClient, commandId: string) {
  const command = await tx.chatCommand.findUniqueOrThrow({ where: { id: commandId } });
  return { winner: command.status, assistantMessageId: command.assistantMessageId };
}
async function updateReceipt(
  tx: Prisma.TransactionClient,
  commandId: string,
  status: ChatCommandStatus,
  response: Prisma.InputJsonValue,
) {
  const now = await readAuthClock(tx);
  await tx.commandIdempotency.updateMany({
    where: { commandId },
    data: { status, responseJson: response, expiresAt: new Date(now.getTime() + 86400000) },
  });
}
/** CAS occurs before any assistant/event write; a stale task fence rolls the entire transaction back. */
export async function completeCommand(
  tx: Prisma.TransactionClient,
  input: TaskLease & { commandId: string; assistantContent: unknown },
) {
  const content = parseAssistantContent(input.assistantContent),
    { command } = await authorizeWorkerCommand(tx, input.commandId);
  const now = await readAuthClock(tx);
  const changed = await tx.chatCommand.updateMany({
    where: { id: command.id, status: "RUNNING" },
    data: { status: "COMPLETED", completedAt: now },
  });
  if (changed.count !== 1) return winner(tx, command.id);
  const task = await assertTaskLease(tx, input);
  if (task.commandId !== command.id) throw new ChatCommandError("NOT_FOUND", 404);
  const assistant = await tx.chatMessage.create({
    data: {
      travelRecordId: command.travelRecordId,
      commandId: command.id,
      role: "ASSISTANT",
      kind: "STRUCTURED",
      content: "",
      contentJson: { ...content },
      sequence: await nextMessageSequence(tx, command.travelRecordId),
    },
  });
  await tx.chatCommand.update({
    where: { id: command.id },
    data: { assistantMessageId: assistant.id },
  });
  const response = {
    commandId: command.id,
    message: {
      id: assistant.id,
      role: "ASSISTANT",
      kind: "STRUCTURED",
      content: { ...content },
      sequence: assistant.sequence,
    },
    conversationCursor: { travelRecordId: command.travelRecordId, sequence: assistant.sequence },
  };
  await appendCommandEvent(tx, {
    commandId: command.id,
    traceId: command.traceId,
    type: "assistant.completed",
    status: "COMPLETED",
    payload: response,
    now,
  });
  await updateReceipt(tx, command.id, "COMPLETED", response);
  await completeTask(tx, { ...input, resultRef: assistant.id });
  return { winner: "COMPLETED" as const, assistantMessageId: assistant.id };
}
export async function failCommand(
  tx: Prisma.TransactionClient,
  input: TaskLease & { commandId: string; errorCode: ChatErrorCode },
) {
  if (!isChatErrorCode(input.errorCode)) throw new ChatCommandError("CONFIG_ERROR", 503);
  // A current worker may close a revoked/archived command with a safe failure, but may
  // never publish assistant content for it. This is not an owner-facing mutation entry.
  let command;
  try {
    command = (await authorizeWorkerCommand(tx, input.commandId)).command;
  } catch (error) {
    if (!(error instanceof ChatCommandError) || error.code !== "NOT_FOUND") throw error;
    const task = await assertTaskLease(tx, input);
    command = await tx.chatCommand.findUniqueOrThrow({ where: { id: input.commandId } });
    if (task.commandId !== command.id) throw error;
    await tx.$queryRawUnsafe(
      'SELECT id FROM "TravelRecord" WHERE id=$1 FOR UPDATE',
      command.travelRecordId,
    );
  }
  const now = await readAuthClock(tx);
  const changed = await tx.chatCommand.updateMany({
    where: { id: command.id, status: { in: ["PENDING", "RUNNING"] } },
    data: {
      status: "FAILED",
      errorCode: input.errorCode,
      errorMessage: chatErrorMessage(input.errorCode),
      completedAt: now,
    },
  });
  if (changed.count !== 1) return winner(tx, command.id);
  const task = await assertTaskLease(tx, input);
  if (task.commandId !== command.id) throw new ChatCommandError("NOT_FOUND", 404);
  const response = {
    commandId: command.id,
    error: { code: input.errorCode, message: chatErrorMessage(input.errorCode) },
    conversationCursor: {
      travelRecordId: command.travelRecordId,
      sequence: (await nextMessageSequence(tx, command.travelRecordId)) - 1,
    },
  };
  await appendCommandEvent(tx, {
    commandId: command.id,
    traceId: command.traceId,
    type: "command.failed",
    status: "FAILED",
    payload: response,
    now,
  });
  await updateReceipt(tx, command.id, "FAILED", response);
  await failTask(tx, { ...input, errorCategory: input.errorCode, retryable: false });
  return { winner: "FAILED" as const, assistantMessageId: null };
}
export async function cancelCommand(
  tx: Prisma.TransactionClient,
  input: { owner: TravelRecordOwner; commandId: string },
) {
  const command = await authorizeCommand(tx, input.owner, input.commandId),
    now = await readAuthClock(tx);
  const changed = await tx.chatCommand.updateMany({
    where: { id: command.id, status: { in: ["PENDING", "RUNNING"] } },
    data: {
      status: "CANCELLED",
      completedAt: now,
      errorCode: "CANCELLED",
      errorMessage: chatErrorMessage("CANCELLED"),
    },
  });
  if (changed.count !== 1) return winner(tx, command.id);
  const task = await tx.durableTask.findUniqueOrThrow({ where: { commandId: command.id } });
  await cancelTask(tx, { taskId: task.id });
  const response = {
    commandId: command.id,
    error: { code: "CANCELLED", message: chatErrorMessage("CANCELLED") },
    conversationCursor: {
      travelRecordId: command.travelRecordId,
      sequence: (await nextMessageSequence(tx, command.travelRecordId)) - 1,
    },
  };
  await appendCommandEvent(tx, {
    commandId: command.id,
    traceId: command.traceId,
    type: "command.cancelled",
    status: "CANCELLED",
    payload: response,
    now,
  });
  await updateReceipt(tx, command.id, "CANCELLED", response);
  return { winner: "CANCELLED" as const, assistantMessageId: null };
}
export async function cancelChatCommand(
  client: PrismaClient,
  input: { owner: TravelRecordOwner; commandId: string },
) {
  const result = await client.$transaction((tx) => cancelCommand(tx, input));
  if (result.winner === "CANCELLED")
    for (const controller of controllers.get(input.commandId) ?? []) controller.abort();
  return result;
}
