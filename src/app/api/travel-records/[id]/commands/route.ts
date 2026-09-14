import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createOrResumeChatCommand } from "@/server/chat/command-service";
import { resolveExistingOwner } from "@/server/chat/owner";
import { ChatCommandError } from "@/server/chat/error-codes";
import { db } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function parseBody(request: Request): Promise<{ message: string; clientMessageId: string }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ChatCommandError("VALIDATION_ERROR");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ChatCommandError("VALIDATION_ERROR");
  }
  const message = (body as Record<string, unknown>).message;
  const clientMessageId = (body as Record<string, unknown>).clientMessageId;
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new ChatCommandError("VALIDATION_ERROR");
  }
  if (typeof clientMessageId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(clientMessageId)) {
    throw new ChatCommandError("VALIDATION_ERROR");
  }
  return { message, clientMessageId };
}

/**
 * POST /api/travel-records/{id}/commands
 * Creates a CHAT_MESSAGE command for an existing owned travel record. Requires a signed-in
 * user or an existing anonymous Cookie. Idempotency-Key is read only from the header and
 * never stored in the body or database in plaintext.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const travelRecordId = (await context.params).id;
    // Phase016 owner resolution: an existing anonymous Cookie is verified and hashed here.
    // A logged-in user is resolved by the session boundary before this write route.
    const owner = resolveExistingOwner(request, { userId: null });
    if (!owner) {
      return NextResponse.json(
        { error: "AUTH_REQUIRED", action: "BOOTSTRAP_ANONYMOUS_SESSION" },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }
    const idempotencyKey = request.headers.get("idempotency-key");
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      return NextResponse.json({ error: "VALIDATION_ERROR" }, { status: 400 });
    }
    const { message, clientMessageId } = await parseBody(request);
    const result = await createOrResumeChatCommand(db, {
      owner,
      travelRecordId,
      kind: "CHAT_MESSAGE",
      idempotencyKey,
      message,
      clientMessageId,
      traceId: `tr_${randomUUID().replaceAll("-", "")}`,
    });
    return NextResponse.json(
      {
        travelRecordId: result.travelRecordId,
        commandId: result.commandId,
        userMessageId: result.userMessageId,
        replayed: result.replayed,
        ownerType: result.ownerType,
      },
      { status: result.replayed ? 200 : 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ChatCommandError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}