import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { db } from "../src/server/db";
import {
  runTask,
  runnableTasks,
  drainOutbox,
  type TaskHandler,
} from "../src/server/tasks/dispatcher";
import { processChatCommandTask, processKeyRotationTask } from "../src/server/chat/process-task";
import { adminApiKeysService } from "../src/server/admin/api-keys";

const handlers: Record<string, TaskHandler> = {
  CHAT_COMMAND: processChatCommandTask,
  ADMIN_KEY_ROTATION: processKeyRotationTask,
};
const runId = "worker_" + randomUUID().replaceAll("-", "");
let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});
async function tick() {
  await drainOutbox(db);
  for (const row of await runnableTasks(db)) {
    if (stopping) break;
    await runTask(handlers[row.kind], { db, ...row, runId });
  }
}
try {
  do {
    try {
      await tick();
    } catch {
      process.stderr.write("Worker tick failed; durable work remains recoverable.\n");
    }
    if (process.argv.includes("--once")) break;
    if (!stopping) await delay(1000);
  } while (!stopping);
} finally {
  await db.$disconnect();
  await adminApiKeysService().disconnect();
}
