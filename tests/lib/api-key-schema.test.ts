import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { apiKeyAad, apiKeyFingerprint, parseApiKeyEnvelope } from "@/server/api-key-envelope";
import { apiKeyFixture, malformedEnvelopes } from "../phase010/api-key-fixture";

describe("api-key-schema pure boundary", () => {
  it("accepts exact canonical envelopes across minimum and maximum ciphertext sizes", () => {
    for (const size of [1, 32, 16_384]) {
      const row = apiKeyFixture(size);
      const result = parseApiKeyEnvelope(row.encryptedKey, 1, row.encryptionKeyId);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Buffer.from(result.ciphertext, "base64").length).toBe(size);
    }
  });
  it("rejects every malformed encoding/schema/canonical serialization without echoing input", () => {
    const row = apiKeyFixture();
    for (const value of malformedEnvelopes(row)) {
      let rejected = false;
      try {
        parseApiKeyEnvelope(value, 1, row.encryptionKeyId);
      } catch (error) {
        rejected = error instanceof Error && error.message === "Secret envelope is invalid.";
      }
      expect(rejected).toBe(true);
    }
    expect(() => parseApiKeyEnvelope(row.encryptedKey, 2, row.encryptionKeyId)).toThrow();
    expect(() => parseApiKeyEnvelope(row.encryptedKey, 1, "0".repeat(64))).toThrow();
  });
  it("fingerprints trimmed original UTF-8 bytes, preserves case and rejects invalid lengths", () => {
    const value = randomBytes(32).toString("hex");
    expect(apiKeyFingerprint(` \n${value}\t`)).toBe(
      createHash("sha256").update(value).digest("hex"),
    );
    expect(apiKeyFingerprint("A")).not.toBe(apiKeyFingerprint("a"));
    for (const invalid of [" ", "a".repeat(16_385), "\ud800"])
      expect(() => apiKeyFingerprint(invalid)).toThrow();
  });
  it("binds AAD to record, provider and envelope version using JCS", () => {
    expect(apiKeyAad({ id: "test-id", provider: "test", envelopeVersion: 1 }).toString()).toBe(
      '{"envelopeVersion":1,"provider":"test","recordId":"test-id"}',
    );
    expect(() => apiKeyAad({ id: "test-id", provider: "test", envelopeVersion: 2 })).toThrow();
  });
});
