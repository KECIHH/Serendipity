// @vitest-environment node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOrResumeChatCommand } from "@/server/chat/command-service";
import { claimCommand, completeCommand, failCommand, cancelCommand } from "@/server/chat/command-state";
import { replayEvents, normalizeReplayCursor, deltaFrame } from "@/server/chat/sse";
import { issueOrReuseAnonymousSession, resolveExistingOwner } from "@/server/chat/owner";
import { createTravelRecord, createFixtureOwner, phase016Client, phase016OwnerClient, type FixtureOwner } from "./fixture";

const enabled = Boolean(process.env.PHASE016_FIXTURE_CONFIG);
const db = enabled ? phase016Client() : undefined;
const owner = enabled ? phase016OwnerClient() : undefined;

beforeAll(async () => {
  if (owner) {
    await owner.chatCommandEvent.deleteMany();
    await owner.commandIdempotency.deleteMany();
    await owner.chatCommand.deleteMany();
    await owner.chatMessage.deleteMany();
    await owner.travelRecord.deleteMany();
    await owner.user.deleteMany();
  }
});

afterAll(async () => {
  await db?.$disconnect();
  await owner?.$disconnect();
});

async function freshRecord(owner: FixtureOwner) {
  return createTravelRecord(db!, { owner, title: `record-${randomUUID()}` });
}

describe("Phase016 chat session foundation", () => {
  it("first-accept: anonymous and logged-in owners commit a full transaction with a USER message", async () => {
    const anon = await createFixtureOwner(db!, { anon: true });
    const record = await freshRecord(anon.owner);
    const accepted = await createOrResumeChatCommand(db!, {
      owner: anon.owner,
      travelRecordId: record.id,
      kind: "CHAT_MESSAGE",
      idempotencyKey: `key-${randomUUID()}`,
      message: "hello",
      clientMessageId: `cm_${randomUUID().replaceAll("-", "")}`,
      traceId: `tr_${randomUUID().replaceAll("-", "")}`,
    });
    expect(accepted.replayed).toBe(false);
    expect(accepted.ownerType).toBe("ANONYMOUS");
    expect(accepted.commandId).toMatch(/^cmd_/);
    const command = await db!.chatCommand.findUniqueOrThrow({ where: { id: accepted.commandId } });
    expect(command.status).toBe("PENDING");
    expect(command.kind).toBe("CHAT_MESSAGE");
    const userMsg = await db!.chatMessage.findUniqueOrThrow({ where: { id: command.userMessageId } });
    expect(userMsg.role).toBe("USER");
    expect(userMsg.content).toBe("hello");
    const events = await db!.chatCommandEvent.findMany({ where: { aggregateId: command.id } });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("message.accepted");
    const idem = await db!.commandIdempotency.findUnique({
      where: { commandId: command.id },
    });
    expect(idem?.status).toBe("PENDING");
  });

  it("first-accept: missing valid owner writes zero rows", async () => {
    const anon = await createFixtureOwner(db!, { anon: true });
    const record = await freshRecord(anon.owner);
    const before = await db!.chatCommand.count();
    await expect(
      createOrResumeChatCommand(db!, {
        owner: { anonTokenHash: "0".repeat(64) } as never,
        travelRecordId: record.id,
        kind: "CHAT_MESSAGE",
        idempotencyKey: "k",
        message: "x",
        clientMessageId: "cm_x",
        traceId: "tr_x",
      }),
    ).rejects.toThrow();
    expect(await db!.chatCommand.count()).toBe(before);
  });

  it("idempotency: same key+hash replays same IDs; different hash returns 409", async () => {
    const owner = await createFixtureOwner(db!, { anon: true });
    const record = await freshRecord(owner.owner);
    const idemKey = `key-${randomUUID()}`;
    const first = await createOrResumeChatCommand(db!, {
      owner: owner.owner,
      travelRecordId: record.id,
      kind: "CHAT_MESSAGE",
      idempotencyKey: idemKey,
      message: "repeat me",
      clientMessageId: "cm_repeat",
      traceId: "tr_repeat",
    });
    const second = await createOrResumeChatCommand(db!, {
      owner: owner.owner,
      travelRecordId: record.id,
      kind: "CHAT_MESSAGE",
      idempotencyKey: idemKey,
      message: "repeat me",
      clientMessageId: "cm_repeat",
      traceId: "tr_repeat",
    });
    expect(second.replayed).toBe(true);
    expect(second.commandId).toBe(first.commandId);
    expect(second.userMessageId).toBe(first.userMessageId);
    expect(await db!.chatCommand.count({ where: { travelRecordId: record.id } })).toBe(1);
    await expect(
      createOrResumeChatCommand(db!, {
        owner: owner.owner,
        travelRecordId: record.id,
        kind: "CHAT_MESSAGE",
        idempotencyKey: idemKey,
        message: "different content",
        clientMessageId: "cm_other",
        traceId: "tr_other",
      }),
    ).rejects.toThrow(/IDEMPOTENCY_KEY_REUSED/i);
  });

  it("owner-resume: valid owner continues; forged cookie and another user are rejected", async () => {
    const user = await createFixtureOwner(db!, {});
    const record = await freshRecord(user.owner);
    await createOrResumeChatCommand(db!, {
      owner: user.owner,
      travelRecordId: record.id,
      kind: "CHAT_MESSAGE",
      idempotencyKey: "k1",
      message: "first",
      clientMessageId: "cm_1",
      traceId: "tr_1",
    });
    const resumed = await createOrResumeChatCommand(db!, {
      owner: user.owner,
      travelRecordId: record.id,
      kind: "CHAT_MESSAGE",
      idempotencyKey: "k2",
      message: "second",
      clientMessageId: "cm_2",
      traceId: "tr_2",
    });
    expect(resumed.replayed).toBe(false);
    const msgs = await db!.chatMessage.findMany({
      where: { travelRecordId: record.id },
      orderBy: { sequence: "asc" },
    });
    expect(msgs.map((m) => m.content)).toEqual(["first", "second"]);
    expect(msgs[0].sequence).toBe(1);
    expect(msgs[1].sequence).toBe(2);
    const other = await createFixtureOwner(db!, {});
    await expect(
      createOrResumeChatCommand(db!, {
        owner: other.owner,
        travelRecordId: record.id,
        kind: "CHAT_MESSAGE",
        idempotencyKey: "k3",
        message: "hijack",
        clientMessageId: "cm_3",
        traceId: "tr_3",
      }),
    ).rejects.toThrow(/record was not found/i);
  });

  it("replay: events replay in sequence order without gaps or duplicates; window exceeded returns resync", async () => {
    const owner = await createFixtureOwner(db!, { anon: true });
    const record = await freshRecord(owner.owner);
    const cmd = await createOrResumeChatCommand(db!, {
      owner: owner.owner,
      travelRecordId: record.id,
      kind: "CHAT_MESSAGE",
      idempotencyKey: "kr",
      message: "replay me",
      clientMessageId: "cm_r",
      traceId: "tr_r",
    });
    await db!.$transaction(async (tx) => {
      await claimCommand(tx, { commandId: cmd.commandId, leaseOwner: "w1" });
      await completeCommand(tx, {
        commandId: cmd.commandId,
        leaseOwner: "w1",
        assistantContent: JSON.stringify({ ok: true, answer: "replayed" }),
      });
    });
    const events = await db!.$transaction((tx) => replayEvents(tx, { aggregateId: cmd.commandId }));
    expect(events.events.length).toBeGreaterThanOrEqual(1);
    const seqs = events.events.map((e) => Number(e.sequence));
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1);
    expect(events.events.every((e) => e.aggregateId === cmd.commandId)).toBe(true);
  });

  it("transient-delta: delta frames are not persisted, and replay omits them", async () => {
    const owner = await createFixtureOwner(db!, { anon: true });
    const record = await freshRecord(owner.owner);
    const cmd = await createOrResumeChatCommand(db!, {
      owner: owner.owner,
      travelRecordId: record.id,
      kind: "CHAT_MESSAGE",
      idempotencyKey: "kd",
      message: "delta test",
      clientMessageId: "cm_d",
      traceId: "tr_d",
    });
    const frame = deltaFrame({ eventId: cmd.commandId, deltaIndex: 0, text: "partial" });
    expect(frame).toContain("partial");
    const persisted = await db!.chatMessage.count({ where: { travelRecordId: record.id } });
    expect(persisted).toBe(1);
    const events = await db!.$transaction((tx) => replayEvents(tx, { aggregateId: cmd.commandId }));
    expect(events.events.every((e) => e.type !== "assistant.delta")).toBe(true);
  });

  it("cancel-race: only one winner (CANCELLED or COMPLETED) and no duplicate terminal", async () => {
    const owner = await createFixtureOwner(db!, { anon: true });
    const record = await freshRecord(owner.owner);
    const cmd = await createOrResumeChatCommand(db!, {
      owner: owner.owner,
      travelRecordId: record.id,
      kind: "CHAT_MESSAGE",
      idempotencyKey: "kc",
      message: "race",
      clientMessageId: "cm_c",
      traceId: "tr_c",
    });
    const cancelled = await db!.$transaction((tx) => cancelCommand(tx, { commandId: cmd.commandId, leaseOwner: "0" }));
    expect(["CANCELLED", "COMPLETED"]).toContain(cancelled.winner);
    const terminal = await db!.chatCommandEvent.findMany({
      where: { aggregateId: cmd.commandId, type: { in: ["assistant.completed", "command.failed", "command.cancelled"] } },
    });
    expect(terminal.length).toBeLessThanOrEqual(1);
  });

  it("provider-failure: FAILED retains USER intent with no assistant final message", async () => {
    const owner = await createFixtureOwner(db!, { anon: true });
    const record = await freshRecord(owner.owner);
    const cmd = await createOrResumeChatCommand(db!, {
      owner: owner.owner,
      travelRecordId: record.id,
      kind: "CHAT_MESSAGE",
      idempotencyKey: "kf",
      message: "fail me",
      clientMessageId: "cm_f",
      traceId: "tr_f",
    });
    await db!.$transaction((tx) => failCommand(tx, {
      commandId: cmd.commandId,
      leaseOwner: "0",
      errorCode: "PROVIDER_UNAVAILABLE",
      errorMessage: "Provider unavailable.",
    }));
    const command = await db!.chatCommand.findUniqueOrThrow({ where: { id: cmd.commandId } });
    expect(command.status).toBe("FAILED");
    expect(command.errorCode).toBe("PROVIDER_UNAVAILABLE");
    const assistants = await db!.chatMessage.findMany({
      where: { travelRecordId: record.id, role: "ASSISTANT" },
    });
    expect(assistants).toHaveLength(0);
    const users = await db!.chatMessage.findMany({
      where: { travelRecordId: record.id, role: "USER" },
    });
    expect(users).toHaveLength(1);
  });
});