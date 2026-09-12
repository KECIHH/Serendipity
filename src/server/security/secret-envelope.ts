import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "@/lib/env";
import { envRegistry, parseEnv } from "@/lib/env-schema";
import { stableStringify } from "@/lib/json";
import { apiKeyAad, apiKeyFingerprint, parseApiKeyEnvelope } from "@/server/api-key-envelope";

export class SecretDecryptError extends Error {
  readonly code = "SECRET_DECRYPT_FAILED";

  constructor() {
    super("Secret decryption failed.");
    this.name = "SecretDecryptError";
  }
}

function failed(): never {
  throw new SecretDecryptError();
}

/** A future key ring may resolve older ids without changing the envelope format. */
export interface KeyResolver {
  readonly currentKeyId: string;
  resolve(keyId: string): Buffer;
}

export interface SecretEnvelopeColumns {
  readonly encryptedKey: string;
  readonly encryptionKeyId: string;
  readonly envelopeVersion: 1;
  readonly keyFingerprint: string;
}

export interface SecretEnvelopeRecord {
  readonly id: string;
  readonly provider: string;
  readonly encryptedKey: string;
  readonly encryptionKeyId: string;
  readonly envelopeVersion: number;
}

/** The environment parser remains the sole definition of a valid master-key input. */
export function createKeyResolver(encryptionKey: string = env.ENCRYPTION_KEY): KeyResolver {
  try {
    const parsed = parseEnv({ ENCRYPTION_KEY: encryptionKey }, "server", {
      registry: envRegistry.filter((entry) => entry.key === "ENCRYPTION_KEY"),
    });
    const master = Buffer.from(String(parsed.ENCRYPTION_KEY), "base64");
    const currentKeyId = createHash("sha256").update(master).digest("hex");
    return Object.freeze({
      currentKeyId,
      resolve(keyId: string): Buffer {
        if (keyId !== currentKeyId) failed();
        // Callers receive their own bytes and cannot modify the resolver's retained key.
        return Buffer.from(master);
      },
    });
  } catch {
    return failed();
  }
}

function resolveKey(resolver: KeyResolver, keyId: string): Buffer {
  if (typeof keyId !== "string" || !/^[0-9a-f]{64}$/.test(keyId)) failed();
  const key = resolver.resolve(keyId);
  if (
    !Buffer.isBuffer(key) ||
    key.length !== 32 ||
    createHash("sha256").update(key).digest("hex") !== keyId
  )
    failed();
  return key;
}

function boundAad(record: { id: string; provider: string; envelopeVersion: number }): Buffer {
  return apiKeyAad(record);
}

/** Boundary trim only; the shared Phase010 function owns the exact fingerprint bytes. */
export function generateFingerprint(plainKey: string): string {
  try {
    return apiKeyFingerprint(plainKey);
  } catch {
    return failed();
  }
}

/** The caller allocates the immutable row id before encryption; plaintext is never cached. */
export function encryptSecret(
  input: { id: string; provider: string; plainKey: string },
  resolver: KeyResolver = createKeyResolver(),
): Readonly<SecretEnvelopeColumns> {
  try {
    const keyFingerprint = generateFingerprint(input.plainKey);
    const encryptionKeyId = resolver.currentKeyId;
    const key = resolveKey(resolver, encryptionKeyId);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    cipher.setAAD(boundAad({ id: input.id, provider: input.provider, envelopeVersion: 1 }));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(input.plainKey.trim(), "utf8")),
      cipher.final(),
    ]);
    const encryptedKey = stableStringify({
      algorithm: "A256GCM",
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      keyId: encryptionKeyId,
      tag: cipher.getAuthTag().toString("base64"),
      version: 1,
    });
    parseApiKeyEnvelope(encryptedKey, 1, encryptionKeyId);
    return Object.freeze({ encryptedKey, encryptionKeyId, envelopeVersion: 1, keyFingerprint });
  } catch {
    return failed();
  }
}

/** Authorization and ACTIVE/candidate status checks belong to the calling server service. */
export function decryptSecret(
  record: SecretEnvelopeRecord,
  resolver: KeyResolver = createKeyResolver(),
): string {
  try {
    const envelope = parseApiKeyEnvelope(
      record.encryptedKey,
      record.envelopeVersion,
      record.encryptionKeyId,
    );
    const key = resolveKey(resolver, envelope.keyId);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"), {
      authTagLength: 16,
    });
    decipher.setAAD(boundAad(record));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const bytes = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    const plainKey = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (plainKey !== plainKey.trim()) failed();
    return plainKey;
  } catch {
    return failed();
  }
}
