import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { callGuardedAi, type GuardedAiClientOptions } from "@/server/ai/guarded-client";
import { adminApiKeysService } from "@/server/admin/api-keys";
import type { TaskHandler } from "@/server/tasks/dispatcher";
import { assertTaskLease, saveTaskCheckpoint, TaskLeaseLost } from "@/server/tasks/durable-task";
import { readTaskPayload, storeTaskPayload } from "@/server/tasks/payload";
import { readAuthClock } from "@/server/auth/clock";
import {
  claimCommand,
  completeCommand,
  failCommand,
  bindCommandController,
  parseAssistantContent,
} from "./command-state";
import { authorizeWorkerCommand } from "./ownership";
import { publishChatDelta } from "./events";
import { isChatErrorCode } from "./error-codes";

export function createChatCommandHandler(
  options: {
    ai?: Omit<GuardedAiClientOptions, "db" | "owner">;
    onCheckpoint?: (stage: "CALLING" | "OUTPUT_READY") => Promise<void>;
  } = {},
): TaskHandler {
  return async (client, { task, lease, signal }) => {
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const unbind = bindCommandController(task.aggregateId, controller);
    try {
      const prepared = await client.$transaction(async (tx) => {
        if (!(await claimCommand(tx, { ...lease, commandId: task.aggregateId }))) return null;
        const { command } = await authorizeWorkerCommand(tx, task.aggregateId);
        const current = await assertTaskLease(tx, lease),
          checkpoint = current.checkpointJson as Prisma.JsonObject;
        if (checkpoint.stage === "OUTPUT_READY") {
          const output = await readTaskPayload(tx, {
            payloadRef: String(checkpoint.resultPayloadRef),
            payloadHash: String(checkpoint.resultPayloadHash),
            payloadSchemaVersion: 1,
            ownerKeyHash: command.ownerKeyHash,
          });
          return { command, output: parseAssistantContent(output), message: "", attemptNo: 0 };
        }
        const payload = (await readTaskPayload(tx, {
          ...current,
          ownerKeyHash: command.ownerKeyHash,
        })) as Record<string, unknown>;
        const user = await tx.chatMessage.findUniqueOrThrow({
          where: { id: command.userMessageId },
        });
        if (
          !payload ||
          Object.keys(payload).sort().join() !== "locale,message,schemaVersion" ||
          payload.schemaVersion !== 1 ||
          payload.locale !== "zh-CN" ||
          typeof payload.message !== "string" ||
          payload.message !== user.content
        )
          throw new Error("CONFIG_ERROR");
        const reservations = await tx.aiUsageReservation.aggregate({
          where: { traceId: command.traceId },
          _max: { attemptNo: true },
        });
        const outputs = await tx.aiOutputRecord.aggregate({
          where: { traceId: command.traceId },
          _max: { attemptNo: true },
        });
        // A lost response may already have cost money. Keep its reservation and use a new attempt.
        const attemptNo =
          Math.max(reservations._max.attemptNo ?? 0, outputs._max.attemptNo ?? 0) + 1;
        await saveTaskCheckpoint(tx, lease, { version: 1, stage: "CALLING", attemptNo });
        return { command, output: null, message: payload.message, attemptNo };
      });
      if (!prepared) return { ok: true };
      let output = prepared.output;
      if (!output) {
        await options.onCheckpoint?.("CALLING");
        let deltaIndex = 0;
        const result = await callGuardedAi(
          {
            promptKey: "conversation.modify",
            variables: { userText: prepared.message, candidates: [], locale: "zh-CN" },
            userMessage: prepared.message,
            traceId: prepared.command.traceId,
            commandId: prepared.command.id,
            travelRecordId: prepared.command.travelRecordId,
            attemptNo: prepared.attemptNo,
            signal: controller.signal,
            onDelta: async (text) => {
              // Bound NOTIFY frames by code points, not UTF-16 halves. No durable table receives a delta.
              const characters = Array.from(text);
              for (let at = 0; at < characters.length; at += 800) {
                if (controller.signal.aborted) return;
                await client.$transaction(async (tx) => {
                  const { command } = await authorizeWorkerCommand(tx, task.aggregateId);
                  await assertTaskLease(tx, lease);
                  if (command.status !== "RUNNING") return;
                  await publishChatDelta(tx, {
                    eventId: "evt_" + randomUUID().replaceAll("-", ""),
                    sequence: 1,
                    aggregateId: command.id,
                    traceId: command.traceId,
                    type: "assistant.delta",
                    status: "RUNNING",
                    occurredAt: (await readAuthClock(tx)).toISOString(),
                    payloadVersion: 1,
                    payload: {
                      commandId: command.id,
                      deltaIndex: deltaIndex++,
                      text: characters.slice(at, at + 800).join(""),
                    },
                  });
                });
              }
            },
          },
          {
            ...options.ai,
            db: client,
            owner: { kind: "COMMAND", commandId: prepared.command.id, lease },
            // This card consumes validated explanatory content only; no mutation or plan is applied.
            validateOutput: (value) =>
              parseAssistantContent({
                schemaVersion: 1,
                kind: "MESSAGE",
                text: (value as { explanation?: unknown }).explanation,
              }),
          },
        );
        if (!result.ok) {
          await client.$transaction((tx) =>
            failCommand(tx, {
              ...lease,
              commandId: task.aggregateId,
              errorCode: isChatErrorCode(result.errorCode)
                ? result.errorCode
                : "PROVIDER_UNAVAILABLE",
            }),
          );
          return { ok: false, retryable: false, errorCategory: result.errorCode };
        }
        output = parseAssistantContent(result.output);
        await client.$transaction(async (tx) => {
          const { command } = await authorizeWorkerCommand(tx, task.aggregateId);
          await assertTaskLease(tx, lease);
          const stored = await storeTaskPayload(tx, {
            ownerKeyHash: command.ownerKeyHash,
            schemaVersion: 1,
            value: output,
          });
          await saveTaskCheckpoint(tx, lease, {
            version: 1,
            stage: "OUTPUT_READY",
            attemptNo: result.attemptNo,
            resultPayloadRef: stored.payloadRef,
            resultPayloadHash: stored.payloadHash,
          });
        });
        await options.onCheckpoint?.("OUTPUT_READY");
      }
      const completed = await client.$transaction((tx) =>
        completeCommand(tx, {
          ...lease,
          commandId: task.aggregateId,
          assistantContent: output,
        }),
      );
      return { ok: true, resultRef: completed.assistantMessageId ?? undefined };
    } catch (error) {
      if (error instanceof TaskLeaseLost) throw error;
      const code =
        error instanceof Error && isChatErrorCode(error.message) ? error.message : "CONFIG_ERROR";
      await client.$transaction((tx) =>
        failCommand(tx, { ...lease, commandId: task.aggregateId, errorCode: code }),
      );
      return { ok: false, retryable: false, errorCategory: code };
    } finally {
      unbind();
      signal.removeEventListener("abort", abort);
    }
  };
}
export const processChatCommandTask = createChatCommandHandler();
/** Both foreground requests and the worker use the Phase012/013 coordinator. */
export const processKeyRotationTask: TaskHandler = async (_client, { lease }) => {
  const response = await adminApiKeysService().resumeRotation(lease);
  return response.stage === "ACTIVATED"
    ? { ok: true, resultRef: response.key.id }
    : {
        ok: false,
        retryable: response.stage !== "ABORTED",
        errorCategory: response.errorCode ?? "CONFIG_ERROR",
      };
};
