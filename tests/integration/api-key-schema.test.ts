// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { apiKeyFixture, API_KEY_FIELDS, malformedEnvelopes } from "../phase010/api-key-fixture";
import { withSeedDatabase } from "../phase010/seed-fixture";

async function rejects(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch {
    return true;
  }
}
describe.skipIf(!process.env.PHASE010_FIXTURE_CONFIG)("api-key-schema PostgreSQL", () => {
  it("migration: exact field, enum, type, check and index inventory", async () => {
    const model = Prisma.dmmf.datamodel.models.find((model) => model.name === "ApiKeyConfig")!;
    expect(model.fields.map((field) => field.name)).toEqual(API_KEY_FIELDS);
    expect(
      Prisma.dmmf.datamodel.enums
        .find((value) => value.name === "ApiKeyStatus")
        ?.values.map((value) => value.name),
    ).toEqual(["ACTIVE", "DISABLED", "REVOKED"]);
    await withSeedDatabase(async ({ app }) => {
      const columns = await app.$queryRaw<
        Array<{ name: string; type: string; maximum: number | null; nullable: string }>
      >`SELECT column_name AS name, data_type AS type, character_maximum_length AS maximum, is_nullable AS nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='ApiKeyConfig' ORDER BY ordinal_position`;
      expect(columns.map((column) => column.name)).toEqual(API_KEY_FIELDS);
      expect(columns.find((column) => column.name === "encryptedKey")?.type).toBe("text");
      expect(columns.find((column) => column.name === "keyFingerprint")?.maximum).toBe(64);
      expect(
        columns
          .filter((column) => column.nullable === "YES")
          .map((column) => column.name)
          .sort(),
      ).toEqual(["lastUsedAt", "revokedAt"]);
      const indexes = await app.$queryRaw<
        Array<{ name: string }>
      >`SELECT indexname AS name FROM pg_indexes WHERE schemaname='public' AND tablename='ApiKeyConfig' ORDER BY indexname`;
      expect(indexes.map((index) => index.name)).toEqual([
        "ApiKeyConfig_keyFingerprint_key",
        "ApiKeyConfig_pkey",
        "ApiKeyConfig_provider_status_idx",
      ]);
      const checks = await app.$queryRaw<
        Array<{ name: string }>
      >`SELECT conname AS name FROM pg_constraint WHERE conrelid='"ApiKeyConfig"'::regclass AND contype='c' ORDER BY conname`;
      expect(checks.map((check) => check.name)).toEqual([
        "ApiKeyConfig_envelope",
        "ApiKeyConfig_fingerprint",
        "ApiKeyConfig_revision",
        "ApiKeyConfig_revocation",
      ]);
    });
  }, 60_000);

  it("migration: SQL rejects the full malformed envelope matrix and column mismatches", async () => {
    await withSeedDatabase(async ({ app }) => {
      const row = apiKeyFixture();
      for (const encryptedKey of malformedEnvelopes(row))
        expect(
          await rejects(() => app.apiKeyConfig.create({ data: { ...row, encryptedKey } })),
        ).toBe(true);
      for (const patch of [
        { envelopeVersion: 2 },
        { encryptionKeyId: "0".repeat(64) },
        { keyFingerprint: "x".repeat(64) },
        { keyFingerprint: "A".repeat(64) },
        { keyFingerprint: "a".repeat(63) },
        { revision: -1 },
        { status: "REVOKED" as const, revokedAt: null },
        { status: "ACTIVE" as const, revokedAt: new Date() },
        { status: "DISABLED" as const, revokedAt: new Date() },
      ])
        expect(await rejects(() => app.apiKeyConfig.create({ data: { ...row, ...patch } }))).toBe(
          true,
        );
      expect(await app.apiKeyConfig.count()).toBe(0);
      for (const size of [1, 16_384])
        expect(await rejects(() => app.apiKeyConfig.create({ data: apiKeyFixture(size) }))).toBe(
          false,
        );
    });
  }, 60_000);

  it("migration: fingerprint is globally unique and immutable content cannot be overwritten", async () => {
    await withSeedDatabase(async ({ app }) => {
      const row = await app.apiKeyConfig.create({ data: apiKeyFixture() });
      expect(
        await rejects(() =>
          app.apiKeyConfig.create({
            data: { ...apiKeyFixture(), keyFingerprint: row.keyFingerprint },
          }),
        ),
      ).toBe(true);
      for (const patch of [
        { encryptedKey: apiKeyFixture().encryptedKey },
        { provider: "another-provider" },
        { id: randomUUID() },
        { encryptionKeyId: "0".repeat(64) },
        { envelopeVersion: 2 },
        { keyFingerprint: createHash("sha256").update(randomUUID()).digest("hex") },
        { createdAt: new Date(0) },
      ])
        expect(
          await rejects(() => app.apiKeyConfig.update({ where: { id: row.id }, data: patch })),
        ).toBe(true);
      expect(
        (await app.apiKeyConfig.findUniqueOrThrow({ where: { id: row.id } })).encryptedKey ===
          row.encryptedKey,
      ).toBe(true);
    });
  }, 60_000);

  it("migration: real changes increment revision once and REVOKED cannot recover", async () => {
    await withSeedDatabase(async ({ app }) => {
      const row = await app.apiKeyConfig.create({ data: apiKeyFixture() });
      expect(
        await rejects(() =>
          app.apiKeyConfig.update({ where: { id: row.id }, data: { name: "Changed" } }),
        ),
      ).toBe(true);
      const renamed = await app.apiKeyConfig.update({
        where: { id: row.id, revision: 0 },
        data: { name: "Changed", revision: { increment: 1 } },
      });
      expect(renamed.revision).toBe(1);
      expect(
        await rejects(() =>
          app.apiKeyConfig.update({
            where: { id: row.id, revision: 0 },
            data: { name: "Stale", revision: { increment: 1 } },
          }),
        ),
      ).toBe(true);
      const noChange = await app.apiKeyConfig.update({
        where: { id: row.id },
        data: { name: "Changed", lastUsedAt: new Date() },
      });
      expect(noChange.revision).toBe(1);
      expect(
        await rejects(() =>
          app.apiKeyConfig.update({ where: { id: row.id }, data: { revision: { increment: 1 } } }),
        ),
      ).toBe(true);
      await app.apiKeyConfig.update({
        where: { id: row.id },
        data: { status: "DISABLED", revision: { increment: 1 } },
      });
      await app.apiKeyConfig.update({
        where: { id: row.id },
        data: { status: "ACTIVE", revision: { increment: 1 } },
      });
      await app.apiKeyConfig.update({
        where: { id: row.id },
        data: { status: "REVOKED", revokedAt: new Date(), revision: { increment: 1 } },
      });
      for (const status of ["ACTIVE", "DISABLED"] as const)
        expect(
          await rejects(() =>
            app.apiKeyConfig.update({
              where: { id: row.id },
              data: { status, revokedAt: null, revision: { increment: 1 } },
            }),
          ),
        ).toBe(true);
      expect(
        await rejects(() =>
          app.apiKeyConfig.update({ where: { id: row.id }, data: { revokedAt: new Date(0) } }),
        ),
      ).toBe(true);
    });
  }, 60_000);

  it("governance-absence: only produced models exist and migrations create no key rows", async () => {
    const expected = [
      "ApiKeyConfig",
      "AuditLog",
      "ChatMessage",
      "SystemConfig",
      "TravelRecord",
      "User",
    ];
    if (Prisma.dmmf.datamodel.models.some((model) => model.name === "AuthSession"))
      expected.push("AuthLoginAttempt", "AuthSession");
    expected.sort();
    expect(Prisma.dmmf.datamodel.models.map((model) => model.name).sort()).toEqual(expected);
    await withSeedDatabase(async ({ app }) => {
      const tables = await app.$queryRaw<
        Array<{ name: string }>
      >`SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
      expect(tables.map((table) => table.name)).toEqual([...expected, "_prisma_migrations"]);
      expect(await app.apiKeyConfig.count()).toBe(0);
    });
  }, 60_000);
});
