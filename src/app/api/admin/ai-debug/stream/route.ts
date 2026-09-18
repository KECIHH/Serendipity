import { randomUUID } from "node:crypto";
import { createAuditContext } from "@/server/audit-log";
import { withAdminRoute } from "@/server/auth/guards";
import { db } from "@/server/db";
import { debugTaskAggregateId, debugTaskHandler } from "@/server/ai/debug-runner";
import {
  AI_DEBUG_STREAM_OPERATION,
  aiDebugFailure,
  aiDebugService,
} from "@/server/ai/debug-service";
import { runTask } from "@/server/tasks/dispatcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Accept the same persisted run, then push the receipt, transient deltas and one final
 * EventEnvelope. A lost connection never duplicates work: the run stays recoverable by GET.
 */
export const POST = withAdminRoute(async (request, _route, principal) => {
  const context = createAuditContext();
  let accepted;
  try {
    accepted = await aiDebugService().accept(principal, AI_DEBUG_STREAM_OPERATION, request);
  } catch (error) {
    return aiDebugFailure(error, context.requestId);
  }
  const runId = accepted.runId;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (name: string, payload: unknown, eventId?: string) => {
        try {
          controller.enqueue(
            encoder.encode(
              `${eventId === undefined ? "" : `id: ${eventId}\n`}event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`,
            ),
          );
        } catch {
          /* The client is gone; deltas are transient and never replayed. */
        }
      };
      send("accepted", accepted.receipt);
      try {
        const handler = debugTaskHandler(async (text) => {
          send("delta", { debugRunId: runId, text });
        });
        // A lost connection stops this attempt only; the persisted run stays resumable.
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) controller.abort();
        try {
          await runTask(
            (client, context) => handler(client, { ...context, signal: controller.signal }),
            {
              db,
              kind: "AI_DEBUG",
              aggregateId: await debugTaskAggregateId(db, runId),
              runId: "debug_stream_" + randomUUID().replaceAll("-", ""),
            },
          );
        } finally {
          request.signal.removeEventListener("abort", abort);
        }
      } catch {
        /* The persisted run remains the source of truth for recovery. */
      }
      let status: Awaited<ReturnType<ReturnType<typeof aiDebugService>["status"]>> | null = null;
      try {
        status = await aiDebugService().status(principal, runId);
      } catch {
        status = null;
      }
      const finalEventId = "evt_" + randomUUID().replaceAll("-", "");
      send(
        "final",
        {
          eventId: finalEventId,
          sequence: 1,
          aggregateId: runId,
          traceId: accepted.traceId,
          type: "ai-debug.completed",
          status: status?.status ?? "FAILED",
          occurredAt: new Date().toISOString(),
          payloadVersion: 1,
          payload: {
            debugRunId: runId,
            status: status?.status ?? "FAILED",
            errorCode: status?.errorCode ?? null,
            attemptIds: status?.attemptIds ?? [],
          },
        },
        finalEventId,
      );
      try {
        controller.close();
      } catch {
        /* Already closed by the client. */
      }
    },
    cancel() {
      /* Deltas are best effort; the run itself is durable. */
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
});
