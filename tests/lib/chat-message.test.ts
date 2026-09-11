// @vitest-environment node
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashAnonymousToken } from "@/server/anonymous-owner";
import { DataLayerError } from "@/server/repositories/data-layer-error";
import * as repository from "@/server/repositories/chat-message";

const databaseMock = vi.hoisted(() => {
  const touch = vi.fn();
  return {
    touch,
    client: {
      $transaction: touch,
      $queryRaw: touch,
      chatMessage: { create: touch, findUnique: touch, findFirst: touch, findMany: touch },
    },
  };
});

vi.mock("@/server/db", () => ({ db: databaseMock.client }));

beforeEach(() => {
  databaseMock.touch.mockReset();
  databaseMock.touch.mockRejectedValue(new Error("Synthetic driver detail must not escape"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function input() {
  return {
    owner: { anonTokenHash: hashAnonymousToken(randomBytes(32).toString("base64url")) },
    travelRecordId: "synthetic-record",
    sequence: 1,
    role: "USER" as const,
    kind: "TEXT" as const,
    content: "Synthetic message",
  };
}

describe("ChatMessage repository boundary", () => {
  it("ordered-messages: cursor round-trips the record sequence and message identity", () => {
    const anchor = { travelRecordId: "synthetic-record", sequence: 42, id: "synthetic-message" };
    const cursor = repository.encodeChatMessageCursor(anchor);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(repository.decodeChatMessageCursor(cursor)).toEqual(anchor);
    expect(repository.encodeChatMessageCursor(repository.decodeChatMessageCursor(cursor))).toBe(
      cursor,
    );
    const other = repository.encodeChatMessageCursor({ ...anchor, travelRecordId: "other-record" });
    expect(other === cursor).toBe(false);
  });

  it("ordered-messages: malformed noncanonical and ambiguous cursor payloads are rejected", () => {
    const encoded = (value: unknown) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const valid = repository.encodeChatMessageCursor({
      travelRecordId: "synthetic-record",
      sequence: 1,
      id: "synthetic-message",
    });
    const invalid: unknown[] = [
      null,
      undefined,
      1,
      {},
      "",
      "!",
      `${valid}=`,
      `${valid}\n`,
      "A".repeat(1025),
      Buffer.from("not JSON").toString("base64url"),
      encoded(null),
      encoded({ travelRecordId: "synthetic-record", sequence: 1, id: "synthetic-message" }),
      encoded(["synthetic-record", 1]),
      encoded(["synthetic-record", 1, "synthetic-message", "ignored"]),
      encoded(["synthetic-record", 0, "synthetic-message"]),
      encoded(["synthetic-record", 1.5, "synthetic-message"]),
      encoded(["synthetic-record", "1", "synthetic-message"]),
      encoded(["synthetic-record", 2_147_483_648, "synthetic-message"]),
      encoded(["synthetic-record", 1, ""]),
      encoded(["synthetic-record\n", 1, "synthetic-message"]),
      Buffer.from('[ "synthetic-record", 1, "synthetic-message" ]').toString("base64url"),
    ];
    for (const cursor of invalid) {
      expect(() => repository.decodeChatMessageCursor(cursor as string)).toThrow(DataLayerError);
    }
  });

  it("ordered-messages: cursor encoder rejects missing extra and invalid anchor fields", () => {
    const anchor = { travelRecordId: "synthetic-record", sequence: 1, id: "synthetic-message" };
    for (const value of [
      {},
      { ...anchor, sequence: 0 },
      { ...anchor, sequence: -1 },
      { ...anchor, id: "" },
      { ...anchor, travelRecordId: "synthetic-record\n" },
      { ...anchor, createdAt: "2026-01-01T00:00:00.000Z" },
    ]) {
      expect(() => repository.encodeChatMessageCursor(value as never)).toThrow(DataLayerError);
    }
  });

  it("ownership: reading and appending require exactly one owner before SQL", async () => {
    for (const owner of [
      undefined,
      null,
      {},
      { userId: "synthetic", ...input().owner },
      { recordId: "synthetic-record" },
    ]) {
      await expect(
        repository.appendChatMessage({ ...input(), owner: owner as never }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(
        repository.listChatMessages({ owner: owner as never, travelRecordId: "synthetic-record" }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(databaseMock.touch).not.toHaveBeenCalled();
  });

  it("ordered-messages: missing nonintegral and out-of-range sequences fail before SQL", async () => {
    for (const sequence of [undefined, null, "1", 0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
      await expect(
        repository.appendChatMessage({ ...input(), sequence: sequence as never }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(databaseMock.touch).not.toHaveBeenCalled();
  });

  it("ordered-messages: invalid role kind content and record identities fail before SQL", async () => {
    for (const change of [
      { role: "TOOL" },
      { kind: "UNKNOWN" },
      { content: "" },
      { content: " \n\t " },
      { content: "NUL\0inside" },
      { content: "invalid\ud800" },
      { travelRecordId: "" },
      { travelRecordId: "synthetic-record\n" },
      { id: "client-chosen-server-id" },
      { createdAt: new Date("2026-01-01T00:00:00.000Z") },
    ]) {
      await expect(
        repository.appendChatMessage({ ...input(), ...change } as never),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(databaseMock.touch).not.toHaveBeenCalled();
  });

  it("ordered-messages: bad page sizes and foreign or malformed cursors fail before SQL", async () => {
    const { owner, travelRecordId } = input();
    for (const limit of [0, -1, 101, 1.5, NaN, Infinity, "20", null]) {
      await expect(
        repository.listChatMessages({ owner, travelRecordId, limit: limit as never }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    for (const cursor of [
      "invalid!",
      repository.encodeChatMessageCursor({
        travelRecordId: "other-record",
        sequence: 1,
        id: "synthetic-message",
      }),
    ]) {
      await expect(
        repository.listChatMessages({ owner, travelRecordId, cursor }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(databaseMock.touch).not.toHaveBeenCalled();
  });

  it("client-idempotency: absent structured validation rejects all non-null JSON before SQL", async () => {
    for (const contentJson of [{}, [], false, 0, "unvalidated", { travelPlan: {} }]) {
      await expect(
        repository.appendChatMessage({ ...input(), contentJson: contentJson as never }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    await expect(
      repository.appendChatMessage({ ...input(), kind: "STRUCTURED", contentJson: null }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(databaseMock.touch).not.toHaveBeenCalled();
  });

  it("client-idempotency: invalid client and reply identifiers fail before SQL", async () => {
    for (const value of ["", "whitespace id", "synthetic-id\n", "a".repeat(129), 1, {}]) {
      await expect(
        repository.appendChatMessage({ ...input(), clientMessageId: value as never }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(
        repository.appendChatMessage({ ...input(), replyToMessageId: value as never }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(databaseMock.touch).not.toHaveBeenCalled();
  });

  it("ordered-messages: database faults remain redacted errors and never become empty pages", async () => {
    const { owner, travelRecordId } = input();
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    for (const operation of [
      () => repository.listChatMessages({ owner, travelRecordId }),
      () => repository.appendChatMessage({ ...input(), contentJson: null }),
    ]) {
      let error: unknown;
      try {
        await operation();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(DataLayerError);
      expect(error).toMatchObject({ code: "INTERNAL_ERROR" });
      expect((error as Error).cause).toBeUndefined();
      expect(String(error).includes("Synthetic driver detail")).toBe(false);
    }
    expect(databaseMock.touch).toHaveBeenCalledTimes(2);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("delete-policy: ordinary repository exports no message deletion or sequence allocation", () => {
    expect(Object.keys(repository).sort()).toEqual([
      "appendChatMessage",
      "decodeChatMessageCursor",
      "encodeChatMessageCursor",
      "listChatMessages",
    ]);
  });
});
