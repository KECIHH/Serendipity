// @vitest-environment node
import { describe, expect, it } from "vitest";
import { EmailNormalizationError, normalizeEmailV1 } from "@/server/auth";

describe("normalizeEmailV1", () => {
  it.each([
    ["  Alice.Smith+TAG@EXAMPLE.COM\t", "alice.smith+tag@example.com"],
    ["USER@例え.テスト", "user@xn--r8jz45g.xn--zckzah"],
    ["USER@XN--R8JZ45G.XN--ZCKZAH", "user@xn--r8jz45g.xn--zckzah"],
    ["USER@faß.de", "user@xn--fa-hia.de"],
    ["USER@ＦＯＯ。example", "user@foo.example"],
    ["USER@σόλος.example", "user@xn--wxaijb9b.example"],
    ["USER@127.1", "user@127.1"],
    ["USER@2130706433", "user@2130706433"],
    ["USER@localhost", "user@localhost"],
    ["!#$%&'*+/=?^_`{|}~-@example.com", "!#$%&'*+/=?^_`{|}~-@example.com"],
  ])("normalizes %s without URL host rewriting", (input, expected) => {
    expect(normalizeEmailV1(input)).toBe(expected);
    expect(normalizeEmailV1(expected)).toBe(expected);
  });

  it.each([
    "",
    "user",
    "user@@example.com",
    "@example.com",
    "a@",
    ".a@example.com",
    "a.@example.com",
    "a..b@example.com",
    "用户@example.com",
    "ü@example.com",
    "a b@example.com",
    '"a"@example.com',
    "a\u0000@example.com",
    "a@-example.com",
    "a@example-.com",
    "a@a..com",
    "a@example.com.",
    "a@example_.com",
    "a@[127.0.0.1]",
    "a@example.com/path",
    "a@example.com\\path",
    "a@example.com:443",
    "a@example.com?x",
    "a@example.com#x",
    "a@exa\tmple.com",
    "a@exa\nmple.com",
    "a@%65xample.com",
    "a@xn--a.example",
    "a@ab--cd.example",
    "a@a\u200cb.example",
    `${"a".repeat(65)}@example.com`,
    `a@${"b".repeat(64)}.com`,
    `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`,
  ])("rejects invalid identity %j", (input) => {
    expect(() => normalizeEmailV1(input)).toThrow(EmailNormalizationError);
    expect(() => normalizeEmailV1(input)).toThrow("Email address is invalid");
  });

  it("accepts the exact 64-byte local and 254-byte total boundaries", () => {
    const email = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    expect(Buffer.byteLength(email)).toBe(254);
    expect(normalizeEmailV1(email)).toBe(email);
    expect(() => normalizeEmailV1(`${email}d`)).toThrow(EmailNormalizationError);
  });

  it("rejects runtime non-string input without exposing it", () => {
    for (const input of [null, undefined, 12, {}, ["a@example.com"]]) {
      expect(() => normalizeEmailV1(input as string)).toThrow(EmailNormalizationError);
    }
  });
});
