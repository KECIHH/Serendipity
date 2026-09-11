// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashAnonymousToken, parseTravelRecordOwner } from "@/server/anonymous-owner";
import { DataLayerError } from "@/server/repositories/data-layer-error";
import * as repository from "@/server/repositories/travel-record";
import { readPhase008Target } from "../phase008/data-fixture";

const databaseMock = vi.hoisted(() => {
  const touch = vi.fn();
  return {
    touch,
    client: {
      $transaction: touch,
      $queryRaw: touch,
      travelRecord: { create: touch, findFirst: touch, findUnique: touch, update: touch },
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

function owner() {
  return { anonTokenHash: hashAnonymousToken(randomBytes(32).toString("base64url")) };
}

describe("TravelRecord trusted owner and hashing boundary", () => {
  it("hash: canonical 256-bit Cookie material hashes its exact UTF-8 bytes deterministically", () => {
    const raw = randomBytes(32).toString("base64url");
    const hashed = hashAnonymousToken(raw);
    const expected = createHash("sha256").update(raw, "utf8").digest("hex");
    expect(raw.length).toBe(43);
    expect(hashed).toMatch(/^[a-f0-9]{64}$/);
    expect(hashed).toBe(expected);
    expect(hashAnonymousToken(raw)).toBe(hashed);
    expect(hashed === (raw as string)).toBe(false);
    expect(hashAnonymousToken(randomBytes(32).toString("base64url")) === hashed).toBe(false);
  });

  it("hash: wrong lengths encodings and non-string values fail with a redacted error", () => {
    const canonical = randomBytes(32).toString("base64url");
    const invalid: unknown[] = [
      undefined,
      null,
      256,
      {},
      [],
      "",
      canonical.slice(1),
      `${canonical}=`,
      ` ${canonical}`,
      `${canonical}\n`,
      "a".repeat(64),
      "!".repeat(43),
      `${"A".repeat(42)}B`, // Same decoded bytes as a valid encoding but noncanonical trailing bits.
    ];
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    for (const input of invalid) {
      let error: unknown;
      try {
        hashAnonymousToken(input as string);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(DataLayerError);
      expect(error).toMatchObject({ code: "VALIDATION_ERROR" });
      expect((error as Error).cause).toBeUndefined();
      if (typeof input === "string" && input.length > 20) {
        expect(String(error).includes(input)).toBe(false);
        expect((error as Error).stack?.includes(input)).toBe(false);
      }
    }
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("ownership: owner parser accepts exactly one trusted scalar owner", () => {
    const anonymous = owner();
    expect(parseTravelRecordOwner(anonymous)).toEqual(anonymous);
    expect(parseTravelRecordOwner({ userId: "synthetic-user-id" })).toEqual({
      userId: "synthetic-user-id",
    });
    const nullPrototype = Object.assign(Object.create(null), anonymous);
    expect(parseTravelRecordOwner(nullPrototype)).toEqual(anonymous);
  });

  it("ownership: owner parser rejects missing ambiguous inherited and alternate identity fields", () => {
    const anonymous = owner();
    const invalid: unknown[] = [
      undefined,
      null,
      1,
      "synthetic-user-id",
      [],
      {},
      { userId: "" },
      { userId: "  " },
      { userId: null },
      { anonTokenHash: null },
      { userId: "synthetic-user-id", ...anonymous },
      { userId: "synthetic-user-id", anonTokenHash: undefined },
      { userId: "synthetic-user-id", anonTokenHash: null },
      { ...anonymous, userId: undefined },
      { ...anonymous, userId: null },
      { recordId: "synthetic-record-id" },
      { ip: "127.0.0.1" },
      { userAgent: "Synthetic fixture" },
      { userId: "synthetic-user-id", extra: true },
      Object.create({ userId: "inherited-user-id" }),
      new Date(),
    ];
    for (const input of invalid) {
      expect(() => parseTravelRecordOwner(input)).toThrow(DataLayerError);
      try {
        parseTravelRecordOwner(input);
      } catch (error) {
        expect(error).toMatchObject({ code: "VALIDATION_ERROR" });
      }
    }
  });

  it("ownership: owner parser rejects accessors and hidden or symbol keys without invoking getters", () => {
    const getter = vi.fn(() => "synthetic-user-id");
    const accessor = Object.defineProperty({}, "userId", { enumerable: true, get: getter });
    const hidden = Object.defineProperty({ userId: "synthetic-user-id" }, "hidden", {
      value: true,
    });
    const symbol = { userId: "synthetic-user-id", [Symbol("hidden")]: true };
    for (const input of [accessor, hidden, symbol]) {
      expect(() => parseTravelRecordOwner(input)).toThrow(DataLayerError);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("hash: request token alternatives and malformed persisted hashes are not valid owner inputs", () => {
    const raw = randomBytes(32).toString("base64url");
    const invalid = [
      { anonToken: raw },
      { anonTokenHash: raw },
      { anonTokenHash: "a".repeat(63) },
      { anonTokenHash: "a".repeat(65) },
      { anonTokenHash: "A".repeat(64) },
      { anonTokenHash: "z".repeat(64) },
      { anonTokenHash: `${"a".repeat(64)}\n` },
    ];
    for (const input of invalid) {
      let error: unknown;
      try {
        parseTravelRecordOwner(input);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(DataLayerError);
      expect(error).toMatchObject({ code: "VALIDATION_ERROR" });
      expect(String(error).includes(raw)).toBe(false);
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("ownership: all repositories reject invalid owners before touching SQL", async () => {
    const invalidOwners: unknown[] = [
      undefined,
      null,
      {},
      { userId: "synthetic", ...owner() },
      { anonTokenHash: "raw-token-shaped" },
    ];
    for (const invalid of invalidOwners) {
      await expect(
        repository.createTravelRecord({ owner: invalid as never, title: "Synthetic title" }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(
        repository.getTravelRecord({ owner: invalid as never, travelRecordId: "synthetic-record" }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(databaseMock.touch).not.toHaveBeenCalled();
  });

  it("lifecycle-version: JSON schema absence fails closed before starting SQL", async () => {
    for (const requirementJson of [{}, [], false, 0, "unvalidated", { destinations: [] }]) {
      await expect(
        repository.createTravelRecord({
          owner: owner(),
          title: "Synthetic title",
          requirementJson: requirementJson as never,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(databaseMock.touch).not.toHaveBeenCalled();
  });

  it("ownership: transfer requires an anonymous owner and a nonempty destination user", async () => {
    for (const input of [
      {
        owner: { userId: "synthetic-user" },
        travelRecordId: "synthetic-record",
        userId: "other-user",
      },
      { owner: owner(), travelRecordId: "synthetic-record", userId: "" },
      { owner: owner(), travelRecordId: "", userId: "synthetic-user" },
    ]) {
      await expect(
        repository.transferAnonymousTravelRecordToUser(input as never),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(databaseMock.touch).not.toHaveBeenCalled();
  });

  it("ownership: database failures are safe errors rather than records or missing-record responses", async () => {
    const operations = [
      () =>
        repository.createTravelRecord({
          owner: owner(),
          title: "Synthetic title",
          requirementJson: null,
        }),
      () => repository.getTravelRecord({ owner: owner(), travelRecordId: "synthetic-record" }),
      () =>
        repository.transferAnonymousTravelRecordToUser({
          owner: owner(),
          travelRecordId: "synthetic-record",
          userId: "synthetic-user",
        }),
    ];
    for (const operation of operations) {
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
    expect(databaseMock.touch).toHaveBeenCalledTimes(3);
  });

  it("ownership: repository exports only this phase's owned record primitives", () => {
    expect(Object.keys(repository).sort()).toEqual([
      "createTravelRecord",
      "getTravelRecord",
      "lockOwnedTravelRecord",
      "transferAnonymousTravelRecordToUser",
    ]);
  });

  it("ownership: database fixtures reject non-loopback unknown and unowned targets before connecting", () => {
    for (const input of [
      undefined,
      "not-a-url",
      "postgresql://synthetic:synthetic@localhost:5432/phase008_disposable_aabbccddeeff",
      "postgresql://synthetic:synthetic@192.0.2.1:5432/phase008_disposable_aabbccddeeff",
      "postgresql://synthetic:synthetic@127.0.0.1:5432/production",
      "postgresql://synthetic:synthetic@127.0.0.1:5432/phase007_disposable_aabbccddeeff",
      "postgresql://synthetic:synthetic@127.0.0.1:5432/phase008_disposable_aabbccddeeff?schema=private",
      "postgresql://synthetic:synthetic@127.0.0.1:5432/phase008_disposable_aabbccddeeff?host=remote.invalid",
    ]) {
      expect(() => readPhase008Target(input)).toThrow();
    }
    expect(
      readPhase008Target(
        "postgresql://synthetic:synthetic@127.0.0.1:5432/phase008_disposable_aabbccddeeff_mutation?schema=public",
      ).runId,
    ).toBe("aabbccddeeff");
  });
});
