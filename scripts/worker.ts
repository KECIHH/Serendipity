import "server-only";

import { db } from "@/server/db";
import { runTask, drainOutbox, type WorkerContext, type TaskHandler, type TaskKind } from "@/server/tasks/dispatcher";
import { processKeyRotationTask, processChatCommandTask } from "@/server/chat/process-task";

const runId = process.env.WORKER_RUN_ID ?? `worker_${process.pid}`;
const ctx: WorkerContext = { kind: "CHAT_COMMAND", runId, pollMs: 1000, leaseMs: 30_000 };

const handlers: Record<string, TaskHandler> = {
  CHAT_COMMAND: processChatCommandTask,
  ADMIN_KEY_ROTATION: processKeyRotationTask,
};

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 1000);

async function tick() {
  const delivered = await drainOutbox(ctx);
  const kinds = Object.keys(handlers) as (keyof typeof handlers)[];
  const rows = await db.durableTask.findMany({
    where: {
      status: "PENDING",
      availableAt: { lte: new Date() },
      kind: { in: kinds },
    },
    orderBy: { createdAt: "asc" },
    take: 10,
    select: { id: true, kind: true, aggregateId: true },
  });
  for (const row of rows) {
    const handler = handlers[row.kind];
    if (!handler) continue;
    await runTask(handler, {
      kind: row.kind as TaskKind,
      aggregateId: row.aggregateId,
      runId,
      leaseMs: ctx.leaseMs,
    });
  }
  return delivered + rows.length;
}

if (runId === "worker_test") {
  const result = await tick();
  process.stdout.write(JSON.stringify({ ok: true, delivered: result }));
} else {
  const timer = setInterval(async () => {
    try {
      await tick();
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }, POLL_MS);
  process.on("SIGINT", () => {
    clearInterval(timer);
    process.exit(0);
  });
}