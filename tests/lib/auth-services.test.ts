// @vitest-environment node
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readLoginCredentials } from "@/server/auth/credentials-service";
import {
  createLoginIdentity,
  loginBucketKeys,
  loginRetryAfter,
} from "@/server/auth/login-throttle";
import { hashSessionToken } from "@/server/auth/session-service";
import { AuthUnavailableError } from "@/server/auth/errors";

describe("auth services input and security primitives", () => {
  it("normalizes the account through V1 while retaining exact password bytes", () => {
    const password = "  CaseSensitive12!  ";
    const input = readLoginCredentials(" Synthetic.Login@EXAMPLE.INVALID ", password);
    expect(input?.email === "synthetic.login@example.invalid").toBe(true);
    expect(input?.password === password).toBe(true);
    expect(readLoginCredentials("invalid-without-a-domain", password)).toBeNull();
    expect(readLoginCredentials("界@example.invalid", password)).toBeNull();
  });

  it("rejects oversized and malformed UTF-8 before bcrypt can silently truncate", () => {
    const account = "boundary@example.invalid";
    expect(readLoginCredentials(account, "x".repeat(11))).toBeNull();
    expect(readLoginCredentials(account, "x".repeat(12)) !== null).toBe(true);
    expect(readLoginCredentials(account, "é".repeat(36)) !== null).toBe(true);
    expect(readLoginCredentials(account, "é".repeat(37))).toBeNull();
    expect(readLoginCredentials(account, "😀".repeat(18)) !== null).toBe(true);
    expect(readLoginCredentials(account, "😀".repeat(19))).toBeNull();
    expect(readLoginCredentials(account, "\ud800".repeat(12))).toBeNull();
    expect(readLoginCredentials("x".repeat(1025), "x".repeat(12))).toBeNull();
    expect(readLoginCredentials(account, { password: "x".repeat(12) })).toBeNull();
  });

  it("uses keyed domain-separated hashes and one canonical address identity", () => {
    const secret = randomBytes(32).toString("hex");
    const input = { account: "identity@example.invalid", clientAddress: "192.0.2.41" };
    const original = createLoginIdentity(input, secret);
    const mapped = createLoginIdentity({ ...input, clientAddress: "::ffff:192.0.2.41" }, secret);
    expect(original.ipHash === mapped.ipHash).toBe(true);
    expect(original.accountHash === mapped.accountHash).toBe(true);
    expect(/^[a-f0-9]{64}$/.test(original.ipHash)).toBe(true);
    expect(/^[a-f0-9]{64}$/.test(original.accountHash)).toBe(true);
    expect(original.ipHash === original.accountHash).toBe(false);
    const changedSecret = createLoginIdentity(input, randomBytes(32).toString("hex"));
    expect(changedSecret.ipHash === original.ipHash).toBe(false);
    const registration = createLoginIdentity({ ...input, scope: "REGISTER" }, secret);
    expect(registration.accountHash === original.accountHash).toBe(false);
    expect(() =>
      createLoginIdentity({ ...input, clientAddress: "not-an-address" }, secret),
    ).toThrow(AuthUnavailableError);
    expect(() =>
      createLoginIdentity({ ...input, account: "IDENTITY@example.invalid" }, secret),
    ).toThrow(AuthUnavailableError);
  });

  it("requires both advisory bucket keys in a deterministic order", () => {
    const identity = {
      scope: "LOGIN" as const,
      accountHash: "b".repeat(64),
      ipHash: "a".repeat(64),
    };
    const keys = loginBucketKeys(identity);
    expect(keys.length).toBe(2);
    expect(keys[0].includes(":account:")).toBe(true);
    expect(keys[1].includes(":ip:")).toBe(true);
    expect(keys[0] < keys[1]).toBe(true);
  });

  it("waits until both buckets admit, retaining failures when reservations expire", () => {
    const now = new Date("2026-09-11T10:00:00.000Z");
    const identity = {
      scope: "LOGIN" as const,
      accountHash: "a".repeat(64),
      ipHash: "b".repeat(64),
    };
    const failures = Array.from({ length: 5 }, (_, index) => ({
      ...identity,
      ipHash: `other-ip-${index}`,
      status: "FAILED",
      createdAt: new Date(now.getTime() - 100_000),
      reservedUntil: new Date(now.getTime() - 40_000),
    }));
    const reservations = Array.from({ length: 20 }, (_, index) => ({
      ...identity,
      accountHash: `other-account-${index}`,
      status: "RESERVED",
      createdAt: new Date(now.getTime() - 30_000),
      reservedUntil: new Date(now.getTime() + 30_000),
    }));
    expect(loginRetryAfter([...failures, ...reservations], identity, now)).toBe(800);
    expect(loginRetryAfter(reservations, identity, now)).toBe(30);
    expect(loginRetryAfter(reservations.slice(1), identity, now)).toBe(0);
  });

  it("requires enough rows to leave the window when a bucket already exceeds its limit", () => {
    const now = new Date("2026-09-11T10:00:00.000Z");
    const identity = {
      scope: "LOGIN" as const,
      accountHash: "a".repeat(64),
      ipHash: "b".repeat(64),
    };
    const rows = Array.from({ length: 7 }, (_, index) => ({
      ...identity,
      status: "FAILED",
      createdAt: new Date(now.getTime() - 900_000 + (index + 1) * 10_000),
      reservedUntil: new Date(now.getTime() - 840_000 + (index + 1) * 10_000),
    }));
    expect(loginRetryAfter(rows, identity, now)).toBe(30);
  });

  it("accepts only canonical 256-bit opaque tokens and persists only their digest", () => {
    const token = randomBytes(32).toString("base64url");
    const digest = hashSessionToken(token);
    expect(typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest)).toBe(true);
    expect(digest === token).toBe(false);
    expect(hashSessionToken(`${token}=`)).toBeNull();
    expect(hashSessionToken("f".repeat(64))).toBeNull();
    expect(hashSessionToken(null)).toBeNull();
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const nonCanonical = token.slice(0, -1) + alphabet[alphabet.indexOf(token.at(-1)!) + 1];
    expect(Buffer.from(nonCanonical, "base64url").equals(Buffer.from(token, "base64url"))).toBe(
      true,
    );
    expect(hashSessionToken(nonCanonical)).toBeNull();
  });
});
