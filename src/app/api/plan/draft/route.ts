import { db } from "@/server/db";
import { processChatCommandTask } from "@/server/chat/process-task";
import { handlePlanDraft } from "@/server/plan/draft-service";
import { runTask } from "@/server/tasks/dispatcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handlePlanDraft(request, (commandId, requestId) =>
    runTask(processChatCommandTask, {
      db,
      kind: "CHAT_COMMAND",
      aggregateId: commandId,
      runId: `draft_${requestId.replaceAll("-", "")}`,
    }),
  );
}
