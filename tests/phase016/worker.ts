import { PrismaClient } from "@prisma/client";
import { createChatCommandHandler } from "@/server/chat/process-task";
import { runTask, drainOutbox } from "@/server/tasks/dispatcher";
import { completeCommand } from "@/server/chat/command-state";
import {
  heartbeatTask,
  saveTaskCheckpoint,
  failTask,
  type TaskLease,
} from "@/server/tasks/durable-task";
import { adminApiKeysService, createAdminApiKeysService } from "@/server/admin/api-keys";
import { createProviderKeyCandidateClient } from "@/server/ai/key-candidate-client";
import { createIsolatedHttpTransport } from "@/server/ai/deepseek-provider";
import { saveKeyRotationCheckpoint } from "@/server/admin/command-receipt";
import { publicDns } from "../phase015/http-fixture";
import { randomUUID } from "node:crypto";

const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [] });
let resume: (() => void) | undefined;
const send = (value: object) => process.send?.({ ...value, pid: process.pid });
const hold = () =>
  new Promise<void>((resolve) => {
    resume = resolve;
  });
process.on("message", (raw) => {
  const input = raw as {
    action: string;
    commandId: string;
    holdAt?: string;
    leaseMs?: number;
    lease?: TaskLease;
    taskId?: string;
    rotationRunId?: string;
    origin?: string;
    kind?: "CHAT_COMMAND" | "ADMIN_KEY_ROTATION";
  };
  if (input.action === "continue") {
    resume?.();
    resume = undefined;
    return;
  }
  void (async () => {
    if (input.action === "run") {
      const result = await runTask(
        createChatCommandHandler({
          onCheckpoint: async (stage) => {
            send({ type: "stage", stage });
            if (input.holdAt === stage) await hold();
          },
        }),
        {
          db,
          kind: "CHAT_COMMAND",
          aggregateId: input.commandId,
          runId: "process_" + randomUUID().replaceAll("-", ""),
          leaseMs: input.leaseMs ?? 600,
          onClaim: async (task) => {
            send({
              type: "claim",
              taskId: task.id,
              leaseOwner: task.leaseOwner,
              fencingToken: task.fencingToken,
              attemptCount: task.attemptCount,
              checkpoint: task.checkpointJson,
            });
            if (input.holdAt === "CLAIM") await hold();
          },
        },
      );
      send({ type: "done", result });
    } else if (input.action === "late") {
      const lease = input.lease!;
      const results = [];
      for (const fn of [
        () => db.$transaction((tx) => heartbeatTask(tx, lease)),
        () => db.$transaction((tx) => saveTaskCheckpoint(tx, lease, { stage: "STALE" })),
        () => db.$transaction((tx) => failTask(tx, { ...lease, retryable: false })),
        () =>
          db.$transaction((tx) =>
            completeCommand(tx, {
              ...lease,
              commandId: input.commandId,
              assistantContent: { schemaVersion: 1, kind: "MESSAGE", text: "stale" },
            }),
          ),
      ]) {
        try {
          await fn();
          results.push("WRITTEN");
        } catch {
          results.push("REJECTED");
        }
      }
      send({ type: "done", result: results });
    } else if (input.action === "outbox") {
      const result = await drainOutbox(db, {
        batchSize: 1,
        afterDelivery: async (row) => {
          send({ type: "delivered", eventId: row.eventId });
          if (input.holdAt === "ACK") await hold();
        },
      });
      send({ type: "done", result });
    } else if (input.action === "rotation") {
      const service = createAdminApiKeysService({
        databaseUrl: process.env.DATABASE_URL,
        candidateClient: createProviderKeyCandidateClient(
          db,
          input.origin
            ? { transport: createIsolatedHttpTransport(input.origin), dnsLookup: publicDns }
            : {},
        ),
      });
      try {
        const result = await runTask(
          async (_client, { lease }) => {
            const response = await service.resumeRotation(lease).catch((error) => {
              send({
                type: "rotation-error",
                result: {
                  name: error?.name,
                  code: error?.code,
                  publicCode: error?.publicCode,
                  kind: error?.kind,
                },
              });
              throw error;
            });
            send({
              type: "rotation-response",
              result: { stage: response.stage, errorCode: response.errorCode },
            });
            return response.stage === "ACTIVATED"
              ? { ok: true }
              : {
                  ok: false,
                  retryable: false,
                  errorCategory: response.errorCode ?? "CONFIG_ERROR",
                };
          },
          {
            db,
            kind: "ADMIN_KEY_ROTATION",
            aggregateId: input.commandId,
            runId: "rotation_" + randomUUID().replaceAll("-", ""),
            leaseMs: input.leaseMs ?? 2000,
            onClaim: async (task) => {
              send({
                type: "claim",
                taskId: task.id,
                leaseOwner: task.leaseOwner,
                fencingToken: task.fencingToken,
                attemptCount: task.attemptCount,
                checkpoint: task.checkpointJson,
              });
              if (input.holdAt === "CLAIM") await hold();
            },
          },
        );
        send({ type: "done", result });
      } finally {
        await service.disconnect();
      }
    } else if (input.action === "late-rotation") {
      const lease = input.lease!,
        results = [];
      for (const fn of [
        () => db.$transaction((tx) => heartbeatTask(tx, lease)),
        () => db.$transaction((tx) => saveTaskCheckpoint(tx, lease, { stage: "STALE" })),
        () =>
          db.$transaction((tx) =>
            saveKeyRotationCheckpoint(tx, {
              claim: { ...lease, receiptId: input.commandId, leaseUntil: new Date() },
              runId: input.rotationRunId!,
              stage: "TESTING",
              step: "TESTING",
            }),
          ),
        () => adminApiKeysService().resumeRotation(lease),
      ]) {
        try {
          await fn();
          results.push("WRITTEN");
        } catch {
          results.push("REJECTED");
        }
      }
      send({ type: "done", result: results });
    }
  })()
    .catch((error) => {
      send({
        type: "error",
        result: { name: error?.name, code: error?.code ?? error?.kind ?? "WORKER_ERROR" },
      });
    })
    .finally(async () => {
      await db.$disconnect();
      await adminApiKeysService().disconnect();
      process.disconnect();
    });
});
