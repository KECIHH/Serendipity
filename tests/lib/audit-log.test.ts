// @vitest-environment node
import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_LOG_ACTIONS,
  AUDIT_LIMITS,
  AuditLogError,
  createAuditContext,
  hashAuditIp,
  normalizeAuditUserAgent,
  readAuditContext,
  sanitizeAuditDetail,
} from "@/server/audit-log";
import { writeAuditLog } from "@/server/services/audit-log-service";
import { SENSITIVE_KEYS, sensitiveCanary, systemInput } from "../phase009/audit-fixture";

describe("audit-log pure boundary", () => {
  it("recursive-redaction: dynamic sensitive field names cannot carry private canaries", () => {
    const secret = sensitiveCanary("exception");
    for (const key of [
      `apiKey_${secret}`,
      "apiKey_私密内容",
      "password💬",
      "token_customer_canary",
    ]) {
      let error: unknown;
      try {
        sanitizeAuditDetail({ metadata: { [key]: false } });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(AuditLogError);
      expect(String(error).includes(secret)).toBe(false);
    }
  });

  it("bounded-metadata: excessive own-key counts fail before descriptor copying", () => {
    const oversized = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [`key${index}`, null]),
    );
    const descriptor = vi.spyOn(Object, "getOwnPropertyDescriptor");
    let rejected = false;
    try {
      sanitizeAuditDetail(oversized);
    } catch (error) {
      rejected = error instanceof AuditLogError;
    }
    const visited = descriptor.mock.calls.length;
    descriptor.mockRestore();
    expect(rejected).toBe(true);
    expect(visited).toBe(0);
  });

  it("recursive-redaction: nested objects, arrays, separator and case variants never retain canaries", () => {
    const secret = sensitiveCanary("recursive");
    const variants = SENSITIVE_KEYS.flatMap((key) => [
      key,
      key.toUpperCase(),
      [...key.toLowerCase()].join("_"),
      [...key].join("-"),
    ]);
    const input = {
      metadata: {
        items: [
          Object.fromEntries(variants.map((key) => [key, secret])),
          { before: { apiKey: { arbitrary: secret } } },
        ],
      },
      revision: 2,
    };
    const original = JSON.stringify(input);
    const result = sanitizeAuditDetail(input);
    const serialized = JSON.stringify(result);
    expect(serialized.includes(secret)).toBe(false);
    const parsed = JSON.parse(serialized) as {
      metadata: { items: Array<Record<string, unknown>> };
      revision: number;
    };
    expect(Object.values(parsed.metadata.items[0]).every((value) => value === "***")).toBe(true);
    expect(parsed.revision).toBe(2);
    expect(JSON.stringify(input) === original).toBe(true);
    expect(sanitizeAuditDetail({ metadata: { items: [{ ｐａｓｓｗｏｒｄ: secret }] } })).toEqual({
      metadata: { items: [{ ｐａｓｓｗｏｒｄ: "***" }] },
    });
  });

  it("recursive-redaction: safe summaries are preserved and arbitrary private text fails closed", () => {
    const input = {
      result: "SUCCESS",
      before: { revision: 1, enabled: false },
      after: { revision: 2, enabled: true },
      changedFields: ["valueJson"],
      reasonCode: "CONFIG_CHANGED",
    };
    expect(sanitizeAuditDetail(input)).toEqual(input);
    for (const candidate of [
      { message: sensitiveCanary("exception") },
      { result: sensitiveCanary("exception") },
      { metadata: { unknown: "private free text" } },
      { changedFields: ["unregistered"] },
    ]) {
      try {
        sanitizeAuditDetail(candidate);
        throw new Error("Expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(AuditLogError);
        expect(String(error).includes(sensitiveCanary("exception"))).toBe(false);
      }
    }
    expect(sanitizeAuditDetail(null)).toBeNull();
    expect(sanitizeAuditDetail(undefined)).toBeNull();
  });

  it("recursive-redaction: network addresses use canonical domain-separated HMAC", () => {
    const key = new Uint8Array(32).fill(19);
    const digest = hashAuditIp("192.0.2.9", key);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(
      createHmac("sha256", key)
        .update("serendipity:audit:ip:v1\0")
        .update("192.0.2.9")
        .digest("hex"),
    );
    expect(hashAuditIp("2001:0db8:0000:0000:0000:0000:0000:0001", key)).toBe(
      hashAuditIp("2001:db8::1", key),
    );
    expect(hashAuditIp("192.0.2.9", new Uint8Array(32).fill(20))).not.toBe(digest);
    expect(() => hashAuditIp("not an address", key)).toThrow(AuditLogError);
    expect(() => hashAuditIp("192.0.2.9", new Uint8Array(31))).toThrow(AuditLogError);
  });

  it("bounded-metadata: depth and node limits include redacted subtrees", () => {
    let boundary: unknown = { secret: "redact me" };
    for (let level = 0; level < AUDIT_LIMITS.detailDepth - 1; level++)
      boundary = { metadata: boundary };
    expect(() => sanitizeAuditDetail(boundary)).not.toThrow();
    expect(() => sanitizeAuditDetail({ metadata: boundary })).toThrow(AuditLogError);
    expect(
      sanitizeAuditDetail({
        secret: Array.from({ length: AUDIT_LIMITS.detailNodes - 2 }, () => null),
      }),
    ).toEqual({ secret: "***" });
    expect(() =>
      sanitizeAuditDetail({
        secret: Array.from({ length: AUDIT_LIMITS.detailNodes - 1 }, () => null),
      }),
    ).toThrow(AuditLogError);
  });

  it("bounded-metadata: exact UTF-8 byte budgets fail instead of truncating detail", () => {
    const overhead = Buffer.byteLength(JSON.stringify({ secret: "" }));
    expect(
      sanitizeAuditDetail({ secret: "a".repeat(AUDIT_LIMITS.detailBytes - overhead) }),
    ).toEqual({ secret: "***" });
    expect(() =>
      sanitizeAuditDetail({ secret: "a".repeat(AUDIT_LIMITS.detailBytes - overhead + 1) }),
    ).toThrow(AuditLogError);
    expect(() =>
      sanitizeAuditDetail({ secret: "际".repeat(Math.ceil(AUDIT_LIMITS.detailBytes / 3)) }),
    ).toThrow(AuditLogError);
    expect(() => sanitizeAuditDetail({ ["secret" + "_".repeat(129)]: "x" })).toThrow(AuditLogError);
  });

  it("bounded-metadata: malformed JSON, accessors and prototype tricks cannot execute", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        getterCalls++;
        return sensitiveCanary("exception");
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.secret = cycle;
    const symbol = { [Symbol("secret")]: "value" };
    const sparse = new Array(2);
    sparse[1] = null;
    const hidden = Object.defineProperty({}, "secret", { enumerable: false, value: "hidden" });
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          getterCalls++;
          return [];
        },
      },
    );
    for (const value of [
      cycle,
      accessor,
      symbol,
      hidden,
      proxy,
      { secret: sparse },
      { secret: new Date() },
      { secret: BigInt(1) },
      { secret: NaN },
      { secret: Infinity },
      { secret: undefined },
      { secret: () => null },
      { secret: "\0" },
      { secret: "\ud800" },
      Object.create({ secret: "prototype" }) as unknown,
      JSON.parse('{"__proto__":{"secret":"x"}}') as unknown,
      [],
    ]) {
      expect(() => sanitizeAuditDetail(value)).toThrow(AuditLogError);
    }
    expect(getterCalls).toBe(0);
  });

  it("bounded-metadata: 257-character UA normalizes, Unicode stays intact, huge input fails", () => {
    expect(normalizeAuditUserAgent("x".repeat(257))).toBe("x".repeat(256));
    expect(normalizeAuditUserAgent("\0Agent\r\n\t/1\u0085\u2028")).toBe("Agent/1");
    const unicode = normalizeAuditUserAgent("旅🧭".repeat(140));
    expect([...unicode]).toHaveLength(256);
    expect(unicode.isWellFormed()).toBe(true);
    expect(() => normalizeAuditUserAgent("a".repeat(4097))).toThrow(AuditLogError);
    expect(() => normalizeAuditUserAgent("\ud800")).toThrow(AuditLogError);
  });

  it("lookup: server contexts are immutable, bounded, unique and unforgeable by copying", () => {
    const context = createAuditContext({
      trace: true,
      ipAddress: "192.0.2.9",
      hmacKey: new Uint8Array(32).fill(19),
      userAgent: "Agent/1\n",
    });
    expect(context.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(context.traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(context.requestId).not.toBe(context.traceId);
    expect(context.requestId).not.toBe(createAuditContext().requestId);
    expect(Object.isFrozen(context)).toBe(true);
    expect(readAuditContext(context)).toBe(context);
    expect(readAuditContext(undefined)).toEqual({
      requestId: null,
      traceId: null,
      ipHash: null,
      userAgentSummary: null,
    });
    for (const value of [
      { ...context },
      { ...context, requestId: "incoming-user-id" },
      { ...context, traceId: "t".repeat(1000) },
    ])
      expect(() => readAuditContext(value)).toThrow(AuditLogError);
    expect(() => createAuditContext({ ipAddress: "192.0.2.9" })).toThrow(AuditLogError);
    expect(() =>
      Reflect.apply(createAuditContext, undefined, [{ requestId: context.requestId }]),
    ).toThrow(AuditLogError);
  });

  it("transaction: a real global Prisma client cannot be passed to the helper", async () => {
    const db = new PrismaClient({
      datasourceUrl: "postgresql://synthetic:synthetic@127.0.0.1:1/phase009_disposable_unit",
      log: [],
    });
    try {
      // @ts-expect-error The global client is structurally excluded, even though Prisma's base TransactionClient is not.
      await expect(writeAuditLog(db, systemInput())).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    } finally {
      await db.$disconnect();
    }
    expect(Object.keys(AUDIT_LOG_ACTIONS)).toEqual([
      "CONFIG_UPDATE",
      "USER_DISABLE",
      "USER_UPDATE",
      "API_KEY_ROTATE",
      "API_KEY_CREATE",
      "API_KEY_UPDATE",
      "API_KEY_REVOKE",
      "SEED_ADMIN_CREATE",
      "SEED_CONFIG_CREATE",
      "LOGIN_SUCCESS",
      "LOGIN_FAILURE",
      "LOGIN_THROTTLED",
      "SESSION_LOGOUT",
    ]);
  });
});
