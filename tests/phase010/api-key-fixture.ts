import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { stableStringify } from "@/lib/json";
import { apiKeyAad, apiKeyFingerprint } from "@/server/api-key-envelope";

export const API_KEY_FIELDS = [
  "id",
  "name",
  "provider",
  "encryptedKey",
  "encryptionKeyId",
  "envelopeVersion",
  "keyFingerprint",
  "status",
  "lastUsedAt",
  "revokedAt",
  "createdAt",
  "updatedAt",
  "revision",
];

/** All bytes are ephemeral synthetic fixture data; no adapter credential is generated. */
export function apiKeyFixture(size = 32): Prisma.ApiKeyConfigCreateInput {
  const id = `synthetic-${randomUUID()}`;
  const master = randomBytes(32),
    iv = randomBytes(12),
    plaintext = randomBytes(size);
  const provider = "synthetic-fixture";
  const encryptionKeyId = createHash("sha256").update(master).digest("hex");
  const cipher = createCipheriv("aes-256-gcm", master, iv);
  cipher.setAAD(apiKeyAad({ id, provider, envelopeVersion: 1 }));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    id,
    name: "Synthetic fixture",
    provider,
    encryptionKeyId,
    envelopeVersion: 1,
    keyFingerprint: apiKeyFingerprint(plaintext.toString("hex").slice(0, 16_384)),
    encryptedKey: stableStringify({
      version: 1,
      keyId: encryptionKeyId,
      algorithm: "A256GCM",
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    }),
  };
}

export function malformedEnvelopes(row: Prisma.ApiKeyConfigCreateInput): string[] {
  const good = JSON.parse(row.encryptedKey) as Record<string, unknown>;
  const serialized = (patch: Record<string, unknown>) => stableStringify({ ...good, ...patch });
  const missing = { ...good };
  delete missing.tag;
  return [
    "not-json",
    "null",
    "[]",
    "{}",
    `${row.encryptedKey}\n`,
    JSON.stringify(good, null, 2),
    JSON.stringify({ version: 1, ...good }),
    stableStringify(missing),
    serialized({ extra: true }),
    serialized({ algorithm: "A128GCM" }),
    serialized({ version: 2 }),
    serialized({ version: "1" }),
    serialized({ iv: Buffer.alloc(11).toString("base64") }),
    serialized({ iv: Buffer.alloc(13).toString("base64") }),
    serialized({ tag: Buffer.alloc(15).toString("base64") }),
    serialized({ tag: Buffer.alloc(17).toString("base64") }),
    serialized({ ciphertext: "" }),
    serialized({ ciphertext: Buffer.alloc(16_385).toString("base64") }),
    serialized({ ciphertext: "YQ" }),
    serialized({ ciphertext: "YR==" }),
    serialized({ ciphertext: "YQ==\n" }),
    serialized({ ciphertext: "_w==" }),
    serialized({ tag: null }),
    serialized({ iv: 12 }),
    row.encryptedKey.replace('"version":1', '"version":1.0'),
    row.encryptedKey.replace('"version":1', '"version":1,"version":1'),
    row.encryptedKey.replace('"algorithm"', '"\\u0061lgorithm"'),
  ];
}
