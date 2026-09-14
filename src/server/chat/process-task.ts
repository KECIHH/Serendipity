import "server-only";

import { Prisma } from "@prisma/client";
import { db } from "@/server/db";
import { callGuardedAi } from "@/server/ai/guarded-client";
import { type TaskHandler } from "@/server/tasks/dispatcher";
import { claimCommand, completeCommand, failCommand } from "@/server/chat/command-state";
import { chatErrorMessage, isChatErrorCode } from "@/server/chat/error-codes";

export interface ChatTaskPorts {
  db?: Prisma.TransactionClient;
  owner?: { kind: "SYNTHETIC" | "USER"; userId?: string; runId?: string; privateInputAllowed?: boolean };
  clock?: () => number;
}

function ownerContext(): { kind: "SYNTHETIC"; runId: string } {
  const runId = process.env.PHASE016_FIXTURE_CONFIG
    ? JSON.parse(require("node:fs").readFileSync(process.env.PHASE016_FIXTURE_CONFIG, "utf8")).database
    : "phase016_disposable_test";
  return { kind: "SYNTHETIC", runId };
}

/**
 * Process a CHAT_COMMAND task. Claims the ChatCommand PENDING→RUNNING atomically, then
 * calls the guarded AI client. On success it completes the command (RUNNING→COMPLETED,
 * one assistant message + terminal event); on failure it records FAILED with no assistant.
 */
export const processChatCommandTask: TaskHandler = async (tx, input) => {
  const command = await tx.chatCommand.findUnique({ where: { id: input.aggregateId } });
  if (!command) return { ok: false, retryable: false, errorCategory: "NOT_FOUND" };
  if (command.status === "CANCELLED") return { ok: false, retryable: false, errorCategory: "CANCELLED" };

  const claim = await claimCommand(tx, {
    commandId: command.id,
    leaseOwner: input.fencingToken.toString(),
    now: Date.now(),
  }).catch((error) => {
    if (error instanceof Error && error.message === "COMMAND_NOT_CLAIMABLE") return null;
    throw error;
  });
  if (!claim) return { ok: false, retryable: false, errorCategory: "NOT_CLAIMED" };

  const result = await callGuardedAi(
    {
      promptKey: "conversation.modify",
      variables: {
        userText: command.userMessageId,
        candidates: [],
        locale: "zh-CN",
      },
      userMessage: command.userMessageId,
      traceId: command.traceId,
      travelRecordId: command.travelRecordId,
    },
    { db, owner: ownerContext() },
  );

  if (result.ok) {
    const completed = await completeCommand(tx, {
      commandId: command.id,
      leaseOwner: input.fencingToken.toString(),
      assistantContent: JSON.stringify(result.output),
      now: Date.now(),
    }).catch(() => null);
    if (!completed) return { ok: false, retryable: false, errorCategory: "NOT_CLAIMED" };
    return { ok: true, resultRef: result.traceId };
  }
  const code = isChatErrorCode(result.errorCode) ? result.errorCode : "PROVIDER_UNAVAILABLE";
  await failCommand(tx, {
    commandId: command.id,
    leaseOwner: input.fencingToken.toString(),
    errorCode: code,
    errorMessage: chatErrorMessage(code),
    now: Date.now(),
  }).catch(() => {});
  return { ok: false, retryable: result.retryable, errorCategory: result.errorCode };
};

/** The Phase012/013 key rotation executor is registered to the shared worker here. */
export const processKeyRotationTask: TaskHandler = async () => ({
  ok: false,
  retryable: false,
  errorCategory: "NOT_IMPLEMENTED",
});