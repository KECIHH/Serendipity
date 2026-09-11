import "server-only";

import { createHash } from "node:crypto";
import { stableStringify } from "@/lib/json";

export interface ApiKeyEnvelopeV1 {
  version: 1;
  keyId: string;
  algorithm: "A256GCM";
  iv: string;
  ciphertext: string;
  tag: string;
}

export class ApiKeyEnvelopeError extends Error {
  constructor() {
    super("Secret envelope is invalid.");
    this.name = "ApiKeyEnvelopeError";
  }
}

function invalid(): never {
  throw new ApiKeyEnvelopeError();
}

const fields = ["algorithm", "ciphertext", "iv", "keyId", "tag", "version"];
const fingerprintPattern = /^[0-9a-f]{64}$/;

function base64Bytes(value: unknown, minimum: number, maximum: number): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 21_848 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    invalid();
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < minimum || bytes.length > maximum || bytes.toString("base64") !== value)
    invalid();
}

/** A bounded, exact JCS envelope; no lenient decoding or algorithm fallback. */
export function parseApiKeyEnvelope(
  text: string,
  envelopeVersion: number,
  encryptionKeyId: string,
): Readonly<ApiKeyEnvelopeV1> {
  try {
    if (
      typeof text !== "string" ||
      text.length > 22_500 ||
      envelopeVersion !== 1 ||
      !fingerprintPattern.test(encryptionKeyId)
    )
      invalid();
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== fields.join(",")) invalid();
    if (record.version !== 1 || record.algorithm !== "A256GCM" || record.keyId !== encryptionKeyId)
      invalid();
    base64Bytes(record.iv, 12, 12);
    base64Bytes(record.tag, 16, 16);
    base64Bytes(record.ciphertext, 1, 16_384);
    if (stableStringify(record) !== text) invalid();
    return Object.freeze(record as unknown as ApiKeyEnvelopeV1);
  } catch {
    return invalid();
  }
}

/** Phase013 encrypt/decrypt must bind these exact current-row fields as GCM AAD. */
export function apiKeyAad(record: {
  id: string;
  provider: string;
  envelopeVersion: number;
}): Buffer {
  if (
    typeof record.id !== "string" ||
    !record.id ||
    !record.id.isWellFormed() ||
    typeof record.provider !== "string" ||
    !record.provider ||
    !record.provider.isWellFormed() ||
    record.envelopeVersion !== 1
  )
    invalid();
  return Buffer.from(
    stableStringify({
      recordId: record.id,
      provider: record.provider,
      envelopeVersion: record.envelopeVersion,
    }),
    "utf8",
  );
}

/** Trim the boundary only; fingerprint the original case and interior UTF-8 bytes. */
export function apiKeyFingerprint(value: string): string {
  if (typeof value !== "string" || value.length > 32_768 || !value.isWellFormed()) invalid();
  const bytes = Buffer.from(value.trim(), "utf8");
  if (bytes.length < 1 || bytes.length > 16_384) invalid();
  return createHash("sha256").update(bytes).digest("hex");
}
