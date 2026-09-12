// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { env } from "@/lib/env";
import { stableStringify } from "@/lib/json";
import { apiKeyAad, parseApiKeyEnvelope } from "@/server/api-key-envelope";
import {
  createKeyResolver,
  decryptSecret,
  encryptSecret,
  generateFingerprint,
  SecretDecryptError,
  type KeyResolver,
  type SecretEnvelopeRecord,
} from "@/server/security/secret-envelope";
import { malformedEnvelopes } from "../phase010/api-key-fixture";

function canaries(values: Record<string, string>): void {
  const config = process.env.PHASE013_FIXTURE_CONFIG;
  const file = config
    ? path.join(path.dirname(path.resolve(config)), "crypto-canaries.jsonl")
    : path.resolve(".scaffold/phase013/crypto-canaries.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${JSON.stringify(Object.fromEntries(Object.entries(values).filter(([, value]) => value.length >= 12)))}\n`,
  );
}

function fixture(plainKey = `fixture-only::${randomBytes(24).toString("hex")}`) {
  const master = randomBytes(32);
  const encodedMaster = master.toString("base64");
  const resolver = createKeyResolver(encodedMaster);
  const identity = { id: `fixture-${randomUUID()}`, provider: "synthetic-crypto" };
  const row = { ...identity, ...encryptSecret({ ...identity, plainKey }, resolver) };
  const envelope = parseApiKeyEnvelope(row.encryptedKey, 1, row.encryptionKeyId);
  canaries({
    master: encodedMaster,
    plainKey,
    normalized: plainKey.trim(),
    encryptedKey: row.encryptedKey,
    ciphertext: envelope.ciphertext,
    fingerprint: row.keyFingerprint,
  });
  return { master, encodedMaster, resolver, identity, row, envelope, plainKey };
}

function rejectsSafely(operation: () => unknown): boolean {
  try {
    operation();
    return false;
  } catch (error) {
    return (
      error instanceof SecretDecryptError &&
      error.code === "SECRET_DECRYPT_FAILED" &&
      error.message === "Secret decryption failed." &&
      !("cause" in error)
    );
  }
}

describe("[crypto-redaction] secret-envelope service", () => {
  it("round-trip preserves normalized UTF-8 boundary bytes and exact schema", () => {
    for (const plainKey of ["k", "m".repeat(16_384), " \n合成 密钥🚀 e\u0301\t "]) {
      const value = fixture(plainKey);
      expect(decryptSecret(value.row, value.resolver) === plainKey.trim()).toBe(true);
      expect(Object.keys(value.envelope)).toEqual([
        "algorithm",
        "ciphertext",
        "iv",
        "keyId",
        "tag",
        "version",
      ]);
      expect(Buffer.byteLength(value.row.encryptedKey, "utf8") <= 22_500).toBe(true);
      expect(Buffer.from(value.envelope.ciphertext, "base64").length).toBe(
        Buffer.byteLength(plainKey.trim(), "utf8"),
      );
      expect(Buffer.from(value.envelope.iv, "base64").length).toBe(12);
      expect(Buffer.from(value.envelope.tag, "base64").length).toBe(16);
      expect(value.envelope.version).toBe(1);
      expect(value.envelope.algorithm).toBe("A256GCM");
      expect(Object.isFrozen(value.envelope)).toBe(true);
      expect(value.row.keyFingerprint === generateFingerprint(plainKey)).toBe(true);
    }
  });

  it("fingerprint normalization preserves case and interior bytes", () => {
    const plainKey = `fixture-only::${randomBytes(24).toString("hex")}`;
    const expected = createHash("sha256").update(plainKey, "utf8").digest("hex");
    canaries({ plainKey, fingerprint: expected });
    expect(generateFingerprint(` \n${plainKey}\t `) === expected).toBe(true);
    expect(generateFingerprint("a") !== generateFingerprint("A")).toBe(true);
    expect(generateFingerprint("a b") !== generateFingerprint("ab")).toBe(true);
    expect(generateFingerprint("e\u0301") !== generateFingerprint("\u00e9")).toBe(true);
    for (const invalid of ["", " \n\t", "x".repeat(16_385), "界".repeat(5_462), "\ud800"])
      expect(rejectsSafely(() => generateFingerprint(invalid))).toBe(true);
    expect(rejectsSafely(() => generateFingerprint(7 as unknown as string))).toBe(true);
  });

  it("random IVs keep ciphertext distinct and fingerprints stable", () => {
    const value = fixture();
    const ivs = new Set<string>();
    const ciphertexts = new Set<string>();
    const fingerprints = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      const encrypted = encryptSecret(
        { ...value.identity, plainKey: value.plainKey },
        value.resolver,
      );
      const envelope = parseApiKeyEnvelope(encrypted.encryptedKey, 1, encrypted.encryptionKeyId);
      canaries({ encryptedKey: encrypted.encryptedKey, ciphertext: envelope.ciphertext });
      ivs.add(envelope.iv);
      ciphertexts.add(envelope.ciphertext);
      fingerprints.add(encrypted.keyFingerprint);
      expect(
        decryptSecret({ ...value.identity, ...encrypted }, value.resolver) === value.plainKey,
      ).toBe(true);
    }
    expect(ivs.size).toBe(20);
    expect(ciphertexts.size).toBe(20);
    expect(fingerprints.size).toBe(1);
  });

  it("key resolver validates environment keys and rejects unknown ids", () => {
    const value = fixture();
    const expectedId = createHash("sha256").update(value.master).digest("hex");
    expect(value.resolver.currentKeyId === expectedId).toBe(true);
    expect(value.resolver.currentKeyId !== value.row.keyFingerprint).toBe(true);
    expect(value.resolver.resolve(expectedId).equals(value.master)).toBe(true);
    const copy = value.resolver.resolve(expectedId);
    copy.fill(0);
    expect(value.resolver.resolve(expectedId).equals(value.master)).toBe(true);
    expect(rejectsSafely(() => value.resolver.resolve("0".repeat(64)))).toBe(true);
    expect(rejectsSafely(() => value.resolver.resolve(expectedId.toUpperCase()))).toBe(true);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const last = alphabet.indexOf(value.encodedMaster.at(-2)!);
    const noncanonical = `${value.encodedMaster.slice(0, -2)}${alphabet[last | 1]}=`;
    for (const invalid of [
      "",
      Buffer.alloc(31).toString("base64"),
      Buffer.alloc(33).toString("base64"),
      value.encodedMaster.replace(/=$/, ""),
      `${value.encodedMaster}\n`,
      noncanonical,
    ])
      expect(rejectsSafely(() => createKeyResolver(invalid))).toBe(true);
    expect(
      createKeyResolver().currentKeyId ===
        createHash("sha256").update(Buffer.from(env.ENCRYPTION_KEY, "base64")).digest("hex"),
    ).toBe(true);
    const wrongResolver = createKeyResolver(randomBytes(32).toString("base64"));
    expect(rejectsSafely(() => decryptSecret(value.row, wrongResolver))).toBe(true);
    const badResolvers: KeyResolver[] = [
      { currentKeyId: expectedId, resolve: () => Buffer.alloc(31) },
      { currentKeyId: expectedId, resolve: () => randomBytes(32) },
      { currentKeyId: "invalid", resolve: () => value.master },
    ];
    for (const resolver of badResolvers)
      expect(
        rejectsSafely(() =>
          encryptSecret({ ...value.identity, plainKey: value.plainKey }, resolver),
        ),
      ).toBe(true);
    // Decryption uses the row's exact historical id, never a fallback to the write key.
    const extendedResolver: KeyResolver = {
      currentKeyId: wrongResolver.currentKeyId,
      resolve: (keyId) => value.resolver.resolve(keyId),
    };
    expect(decryptSecret(value.row, extendedResolver) === value.plainKey).toBe(true);
  });

  it("decryption rejects every malformed envelope and column mismatch", () => {
    const value = fixture();
    for (const encryptedKey of malformedEnvelopes({ ...value.row, name: "Synthetic fixture" }))
      expect(
        rejectsSafely(() => decryptSecret({ ...value.row, encryptedKey }, value.resolver)),
      ).toBe(true);
    for (const patch of [
      { envelopeVersion: 2 },
      { envelopeVersion: "1" as unknown as number },
      { encryptionKeyId: "0".repeat(64) },
      { encryptionKeyId: value.row.encryptionKeyId.toUpperCase() },
      { encryptedKey: "x".repeat(22_501) },
    ])
      expect(rejectsSafely(() => decryptSecret({ ...value.row, ...patch }, value.resolver))).toBe(
        true,
      );
    const unknownId = createHash("sha256").update(randomBytes(32)).digest("hex");
    expect(
      rejectsSafely(() =>
        decryptSecret(
          {
            ...value.row,
            encryptionKeyId: unknownId,
            encryptedKey: stableStringify({ ...value.envelope, keyId: unknownId }),
          },
          value.resolver,
        ),
      ),
    ).toBe(true);
  });

  it("AAD and authentication bind record provider version IV tag and ciphertext", () => {
    const value = fixture();
    for (const patch of [
      { id: `fixture-${randomUUID()}` },
      { provider: "another-synthetic-provider" },
      { envelopeVersion: 2 },
      { id: "\ud800" },
    ])
      expect(rejectsSafely(() => decryptSecret({ ...value.row, ...patch }, value.resolver))).toBe(
        true,
      );
    for (const field of ["iv", "tag", "ciphertext"] as const) {
      const tampered = Buffer.from(value.envelope[field], "base64");
      tampered[0] ^= 1;
      const encryptedKey = stableStringify({
        ...value.envelope,
        [field]: tampered.toString("base64"),
      });
      expect(
        rejectsSafely(() => decryptSecret({ ...value.row, encryptedKey }, value.resolver)),
      ).toBe(true);
    }
    // A real externally produced GCM envelope proves compatibility with the shared JCS AAD.
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", value.master, iv, { authTagLength: 16 });
    cipher.setAAD(apiKeyAad(value.row));
    const ciphertext = Buffer.concat([cipher.update(value.plainKey, "utf8"), cipher.final()]);
    const encryptedKey = stableStringify({
      ...value.envelope,
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    });
    canaries({ encryptedKey, ciphertext: ciphertext.toString("base64") });
    expect(decryptSecret({ ...value.row, encryptedKey }, value.resolver) === value.plainKey).toBe(
      true,
    );
  });

  it("decryption failures contain only the fixed safe classification", () => {
    const value = fixture();
    const failures: Array<() => unknown> = [
      () => decryptSecret({ ...value.row, id: randomUUID() }, value.resolver),
      () => decryptSecret({ ...value.row, encryptedKey: value.plainKey }, value.resolver),
      () => decryptSecret(null as unknown as SecretEnvelopeRecord, value.resolver),
      () =>
        decryptSecret(value.row, {
          currentKeyId: value.resolver.currentKeyId,
          resolve: () => {
            throw new Error(value.plainKey);
          },
        }),
    ];
    for (const operation of failures) {
      let safe = false;
      try {
        operation();
      } catch (error) {
        const serialized = JSON.stringify(error);
        safe =
          error instanceof SecretDecryptError &&
          error.code === "SECRET_DECRYPT_FAILED" &&
          error.message === "Secret decryption failed." &&
          !("cause" in error) &&
          ![
            value.plainKey,
            value.row.encryptedKey,
            value.encodedMaster,
            value.row.keyFingerprint,
          ].some((secret) => serialized.includes(secret) || String(error).includes(secret));
      }
      expect(safe).toBe(true);
    }
  });
});
