// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseApiKeyEnvelope } from "@/server/api-key-envelope";
import {
  createKeyResolver,
  decryptSecret,
  encryptSecret,
  generateFingerprint,
  SecretDecryptError,
} from "@/server/security/secret-envelope";
import { withSeedDatabase } from "../phase010/seed-fixture";

function fixture(plainKey = `fixture-only::${randomBytes(24).toString("hex")}`) {
  const master = randomBytes(32).toString("base64");
  const resolver = createKeyResolver(master);
  const identity = { id: `fixture-${randomUUID()}`, provider: "synthetic-crypto" };
  const row = {
    ...identity,
    name: "Synthetic crypto fixture",
    ...encryptSecret({ ...identity, plainKey }, resolver),
  };
  const envelope = parseApiKeyEnvelope(row.encryptedKey, 1, row.encryptionKeyId);
  const config = process.env.PHASE013_FIXTURE_CONFIG;
  const file = config
    ? path.join(path.dirname(path.resolve(config)), "crypto-canaries.jsonl")
    : path.resolve(".scaffold/phase013/crypto-canaries.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      master,
      plainKey,
      encryptedKey: row.encryptedKey,
      ciphertext: envelope.ciphertext,
      fingerprint: row.keyFingerprint,
    })}\n`,
  );
  return { plainKey, resolver, row };
}

async function rejected(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch {
    return true;
  }
}

describe.skipIf(!process.env.PHASE013_FIXTURE_CONFIG)(
  "[crypto-redaction] secret-envelope PostgreSQL",
  () => {
    it("service envelopes round-trip through PostgreSQL exact schema", async () => {
      await withSeedDatabase(async ({ app }) => {
        for (const plainKey of [
          `fixture-only::${randomBytes(24).toString("hex")}`,
          ` 合成密钥🚀::${randomBytes(12).toString("hex")} `,
          `fixture-only::${randomBytes(24).toString("hex")}`.padEnd(16_384, "x"),
        ]) {
          const value = fixture(plainKey);
          const created = await app.apiKeyConfig.create({ data: value.row });
          const stored = await app.apiKeyConfig.findUniqueOrThrow({ where: { id: created.id } });
          const parsed = parseApiKeyEnvelope(
            stored.encryptedKey,
            stored.envelopeVersion,
            stored.encryptionKeyId,
          );
          expect(parsed.version).toBe(1);
          expect(stored.encryptedKey === value.row.encryptedKey).toBe(true);
          expect(stored.encryptionKeyId === value.resolver.currentKeyId).toBe(true);
          expect(decryptSecret(stored, value.resolver) === plainKey.trim()).toBe(true);
          expect(stored.keyFingerprint === generateFingerprint(plainKey)).toBe(true);
          let aadRejected = false;
          try {
            decryptSecret({ ...stored, provider: "changed-provider" }, value.resolver);
          } catch (error) {
            aadRejected =
              error instanceof SecretDecryptError && error.code === "SECRET_DECRYPT_FAILED";
          }
          expect(aadRejected).toBe(true);
        }
        expect(await app.apiKeyConfig.count()).toBe(3);
      });
    }, 60_000);

    it("database fingerprint uniqueness preserves the original secret row", async () => {
      await withSeedDatabase(async ({ app }) => {
        const value = fixture();
        const original = await app.apiKeyConfig.create({ data: value.row });
        const second = fixture(` \n${value.plainKey}\t `);
        expect(second.row.keyFingerprint === original.keyFingerprint).toBe(true);
        expect(second.row.encryptedKey !== original.encryptedKey).toBe(true);
        expect(await rejected(() => app.apiKeyConfig.create({ data: second.row }))).toBe(true);
        const stored = await app.apiKeyConfig.findUniqueOrThrow({ where: { id: original.id } });
        expect(stored.encryptedKey === original.encryptedKey).toBe(true);
        expect(decryptSecret(stored, value.resolver) === value.plainKey).toBe(true);
        expect(await app.apiKeyConfig.count()).toBe(1);
      });
    }, 60_000);

    it("database lifecycle updates cannot replace encrypted bytes", async () => {
      await withSeedDatabase(async ({ app }) => {
        const value = fixture();
        const original = await app.apiKeyConfig.create({ data: value.row });
        const replacement = fixture();
        expect(
          await rejected(() =>
            app.apiKeyConfig.update({
              where: { id: original.id },
              data: {
                encryptedKey: replacement.row.encryptedKey,
                encryptionKeyId: replacement.row.encryptionKeyId,
                keyFingerprint: replacement.row.keyFingerprint,
              },
            }),
          ),
        ).toBe(true);
        const disabled = await app.apiKeyConfig.update({
          where: { id: original.id, revision: 0 },
          data: { status: "DISABLED", revision: { increment: 1 } },
        });
        expect(disabled.encryptedKey === original.encryptedKey).toBe(true);
        const revoked = await app.apiKeyConfig.update({
          where: { id: original.id, revision: 1 },
          data: { status: "REVOKED", revokedAt: new Date(), revision: { increment: 1 } },
        });
        expect(revoked.encryptedKey === original.encryptedKey).toBe(true);
        expect(
          await rejected(() =>
            app.apiKeyConfig.update({
              where: { id: original.id, revision: 2 },
              data: { status: "ACTIVE", revokedAt: null, revision: { increment: 1 } },
            }),
          ),
        ).toBe(true);
        const stored = await app.apiKeyConfig.findUniqueOrThrow({ where: { id: original.id } });
        expect(stored.status).toBe("REVOKED");
        expect(stored.revision).toBe(2);
        expect(stored.encryptedKey === original.encryptedKey).toBe(true);
        expect(await app.apiKeyConfig.count()).toBe(1);
      });
    }, 60_000);
  },
);
