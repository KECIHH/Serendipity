// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import { compare, getRounds } from "bcryptjs";
import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { stableStringify } from "@/lib/json";
import { SEED_CONFIG_DEFAULTS, SEED_SOURCE_MARKER } from "@/server/seed-input";
import {
  childCommand,
  fixtureConfig,
  rowSnapshot,
  runSeed,
  syntheticSeedEnv,
  withSeedDatabase,
} from "../phase010/seed-fixture";
import { apiKeyFixture } from "../phase010/api-key-fixture";

const enabled = Boolean(process.env.PHASE010_FIXTURE_CONFIG);
describe.skipIf(!enabled)("seed real CLI", () => {
  it.each(["stdout", "stderr"] as const)(
    "secret-privilege: successful nested CLI cannot disclose sensitive bytes through %s",
    async (stream) => {
      const env = syntheticSeedEnv(fixtureConfig().appUrl);
      const envelope = apiKeyFixture().encryptedKey;
      const payloads = [
        ["sk", randomBytes(24).toString("hex")].join("-"),
        envelope,
        inspect(JSON.parse(envelope)),
        JSON.stringify({ stdout: JSON.stringify({ encryptedKey: envelope }) }),
        env.ADMIN_INITIAL_PASSWORD!,
      ];
      for (const payload of payloads) {
        await expect(
          childCommand(["-e", `process.${stream}.write(${JSON.stringify(payload)})`], env),
        ).rejects.toThrow("SECRET_SCAN_REJECTED");
      }
      const harmless = await childCommand(
        ["-e", 'process.stdout.write("safe-fixture-output")'],
        env,
      );
      expect(harmless.exitCode).toBe(0);
      expect(harmless.stdout).toBe("safe-fixture-output");
    },
  );
  it("first-seed: creates one verified admin, three internal defaults and four transactional audits", async () => {
    await withSeedDatabase(async ({ app, url }) => {
      const env = syntheticSeedEnv(url);
      env.ADMIN_EMAIL = ` ${env.ADMIN_EMAIL!.toUpperCase()} `;
      const result = await runSeed(env);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        status: "SEEDED",
        administratorCreated: 1,
        configsCreated: 3,
        auditsCreated: 4,
        retries: 0,
      });
      const users = await app.user.findMany();
      expect(users.length).toBe(1);
      const user = users[0];
      expect(user.email === env.ADMIN_EMAIL.trim().toLowerCase()).toBe(true);
      expect([user.role, user.status, user.revision, user.sessionVersion]).toEqual([
        "ADMIN",
        "ACTIVE",
        0,
        0,
      ]);
      expect(user.passwordHash === env.ADMIN_INITIAL_PASSWORD).toBe(false);
      expect(getRounds(user.passwordHash)).toBe(12);
      expect(await compare(env.ADMIN_INITIAL_PASSWORD!, user.passwordHash)).toBe(true);
      const configs = await app.systemConfig.findMany({ orderBy: { key: "asc" } });
      expect(
        configs.map(({ key, valueJson, isPublic, group }) => ({ key, valueJson, isPublic, group })),
      ).toEqual(
        [...SEED_CONFIG_DEFAULTS]
          .sort((a, b) => a.key.localeCompare(b.key))
          .map(({ key, valueJson, isPublic, group }) => ({ key, valueJson, isPublic, group })),
      );
      expect(await app.auditLog.count()).toBe(4);
      expect(await app.apiKeyConfig.count()).toBe(0);
      const audits = await app.auditLog.findMany();
      expect(audits.every((row) => row.actorId === null && row.actorEmailSnapshot === null)).toBe(
        true,
      );
      expect(
        audits.every(
          (row) => (row.detailJson as { systemActor: string }).systemActor === "MIGRATION",
        ),
      ).toBe(true);
      const serialized = JSON.stringify(audits);
      expect(serialized.includes(env.ADMIN_INITIAL_PASSWORD!)).toBe(false);
      expect(serialized.includes(user.passwordHash)).toBe(false);
    });
  }, 60_000);

  it("repeated-seed: identical input preserves every business/audit byte and creates no rows", async () => {
    await withSeedDatabase(async ({ app, url }) => {
      const env = syntheticSeedEnv(url);
      expect((await runSeed(env)).exitCode).toBe(0);
      const before = await rowSnapshot(app);
      const result = await runSeed(env);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        status: "UNCHANGED",
        administratorCreated: 0,
        configsCreated: 0,
        auditsCreated: 0,
        retries: 0,
      });
      expect(await rowSnapshot(app)).toBe(before);
      const differentPassword = {
        ...env,
        ADMIN_INITIAL_PASSWORD: `${randomBytes(24).toString("base64url")}Aa1!`,
      };
      expect((await runSeed(differentPassword)).exitCode).not.toBe(0);
      expect(await rowSnapshot(app)).toBe(before);
      expect(
        (
          await runSeed({
            ...env,
            ADMIN_EMAIL: `different-${randomBytes(4).toString("hex")}@example.invalid`,
          })
        ).exitCode,
      ).not.toBe(0);
      expect(await rowSnapshot(app)).toBe(before);
    });
  }, 60_000);

  it("repeated-seed: detects changed persisted administrator fingerprint without resetting it", async () => {
    await withSeedDatabase(async ({ app, url }) => {
      const env = syntheticSeedEnv(url);
      expect((await runSeed(env)).exitCode).toBe(0);
      await app.user.updateMany({ data: { revision: 1, sessionVersion: 1 } });
      const before = await rowSnapshot(app);
      expect((await runSeed(env)).exitCode).not.toBe(0);
      expect(await rowSnapshot(app)).toBe(before);
    });
  }, 60_000);

  it.each(["SOURCE_MARKER", "SEED_RUN_ID", "FINGERPRINT", "ROLE", "STATUS"] as const)(
    "repeated-seed: a previously valid seed rejects isolated %s corruption",
    async (kind) => {
      await withSeedDatabase(async ({ admin, app, url, config }) => {
        const env = syntheticSeedEnv(url);
        expect((await runSeed(env)).exitCode).toBe(0);
        let user = await app.user.findUniqueOrThrow({ where: { email: env.ADMIN_EMAIL! } });
        const audit = await app.auditLog.findFirstOrThrow({
          where: { action: "SEED_ADMIN_CREATE" },
        });
        const detail = { ...(audit.detailJson as Record<string, string>) };
        if (kind === "SOURCE_MARKER") detail.sourceMarker = "ANOTHER_SYNTHETIC_SOURCE";
        if (kind === "SEED_RUN_ID") detail.seedRunId = "phase010_000000000000";
        if (kind === "FINGERPRINT") detail.seedFingerprint = "0".repeat(64);
        if (kind === "ROLE" || kind === "STATUS") {
          user = await app.user.update({
            where: { id: user.id },
            data: kind === "ROLE" ? { role: "USER" } : { status: "DISABLED" },
          });
          // Rebind the synthetic provenance so only the explicit privilege/status guard rejects it.
          detail.seedFingerprint = createHash("sha256")
            .update(
              stableStringify({
                sourceMarker: SEED_SOURCE_MARKER,
                seedRunId: `phase010_${config.runId}`,
                id: user.id,
                email: user.email,
                passwordHash: user.passwordHash,
                role: user.role,
                status: user.status,
                revision: user.revision,
                sessionVersion: user.sessionVersion,
                createdAt: user.createdAt.toISOString(),
              }),
            )
            .digest("hex");
        }
        // Only the disposable database owner can build this corrupted historical fixture.
        await admin.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('ALTER TABLE "AuditLog" DISABLE TRIGGER USER');
          await tx.auditLog.update({ where: { id: audit.id }, data: { detailJson: detail } });
          await tx.$executeRawUnsafe('ALTER TABLE "AuditLog" ENABLE TRIGGER USER');
        });
        const before = await rowSnapshot(app);
        expect((await runSeed(env)).exitCode).not.toBe(0);
        expect(await rowSnapshot(app)).toBe(before);
      });
    },
    60_000,
  );

  it.each(["value", "group", "public"] as const)(
    "repeated-seed: conflicting existing config %s never overwrites the seed",
    async (kind) => {
      await withSeedDatabase(async ({ app, url }) => {
        const env = syntheticSeedEnv(url);
        expect((await runSeed(env)).exitCode).toBe(0);
        const patch =
          kind === "value"
            ? { valueJson: 99 }
            : kind === "group"
              ? { group: "AI" as const }
              : { isPublic: true };
        await app.systemConfig.update({ where: { key: SEED_CONFIG_DEFAULTS[0].key }, data: patch });
        const before = await rowSnapshot(app);
        expect((await runSeed(env)).exitCode).not.toBe(0);
        expect(await rowSnapshot(app)).toBe(before);
      });
    },
    60_000,
  );

  it("concurrent-seed: independent processes resolve an actual conflict into one consistent seed", async () => {
    await withSeedDatabase(async ({ admin, app, url }) => {
      await admin.$executeRawUnsafe(
        "CREATE FUNCTION seed_insert_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2); RETURN NEW; END; $$",
      );
      await admin.$executeRawUnsafe(
        'CREATE TRIGGER seed_insert_barrier BEFORE INSERT ON "User" FOR EACH ROW EXECUTE FUNCTION seed_insert_barrier()',
      );
      const env = syntheticSeedEnv(url);
      const results = await Promise.all([runSeed(env), runSeed(env)]);
      expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
      const summaries = results.map(
        (result) =>
          JSON.parse(result.stdout) as {
            administratorCreated: number;
            configsCreated: number;
            auditsCreated: number;
            retries: number;
          },
      );
      expect(summaries.reduce((sum, r) => sum + r.administratorCreated, 0)).toBe(1);
      expect(summaries.reduce((sum, r) => sum + r.configsCreated, 0)).toBe(3);
      expect(summaries.reduce((sum, r) => sum + r.auditsCreated, 0)).toBe(4);
      expect(summaries.some((result) => result.retries > 0 && result.retries <= 3)).toBe(true);
      expect(await app.user.count()).toBe(1);
      expect(await app.systemConfig.count()).toBe(3);
      expect(await app.auditLog.count()).toBe(4);
    });
  }, 60_000);

  it("concurrent-seed: only three retries then read-only reconciliation; exhausted conflicts leave no rows", async () => {
    await withSeedDatabase(async ({ admin, app, url }) => {
      await admin.$executeRawUnsafe("CREATE SEQUENCE seed_conflict_count");
      await admin.$executeRawUnsafe(
        "GRANT USAGE, SELECT ON SEQUENCE seed_conflict_count TO phase010_app",
      );
      await admin.$executeRawUnsafe(
        "CREATE FUNCTION seed_conflict() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('seed_conflict_count'); RAISE EXCEPTION 'Synthetic serialization conflict' USING ERRCODE='40001'; END; $$",
      );
      await admin.$executeRawUnsafe(
        'CREATE TRIGGER seed_conflict BEFORE INSERT ON "User" FOR EACH ROW EXECUTE FUNCTION seed_conflict()',
      );
      const result = await runSeed(syntheticSeedEnv(url));
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.includes("RETRY_EXHAUSTED")).toBe(true);
      const [counter] = await admin.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT last_value AS count FROM seed_conflict_count`;
      expect(Number(counter.count)).toBe(4);
      expect(await app.user.count()).toBe(0);
      expect(await app.systemConfig.count()).toBe(0);
      expect(await app.auditLog.count()).toBe(0);
    });
  }, 60_000);

  it.each(["USER", "DISABLED", "UNPROVEN_ADMIN", "OTHER_MARKER", "CONFLICTING_CONFIG"] as const)(
    "secret-privilege: create-only pre-existing %s remains untouched",
    async (kind) => {
      await withSeedDatabase(async ({ app, url, config }) => {
        const env = syntheticSeedEnv(url);
        if (kind === "CONFLICTING_CONFIG")
          await app.systemConfig.create({ data: { ...SEED_CONFIG_DEFAULTS[0], valueJson: 99 } });
        else {
          const row = await app.user.create({
            data: {
              email: env.ADMIN_EMAIL!,
              passwordHash: "synthetic-unusable-fixture",
              role: kind === "USER" ? "USER" : "ADMIN",
              status: kind === "DISABLED" ? "DISABLED" : "ACTIVE",
            },
          });
          if (kind === "OTHER_MARKER")
            await app.auditLog.create({
              data: {
                action: "SEED_ADMIN_CREATE",
                targetType: "User",
                targetId: row.id,
                detailJson: {
                  seedRunId: `phase010_${config.runId}`,
                  sourceMarker: "DIFFERENT_FIXTURE",
                  seedFingerprint: "0".repeat(64),
                  systemActor: "MIGRATION",
                },
              },
            });
        }
        const before = await rowSnapshot(app);
        const result = await runSeed(env);
        expect(result.exitCode).not.toBe(0);
        expect(await rowSnapshot(app)).toBe(before);
      });
    },
    60_000,
  );

  it("secret-privilege: production guard rejects even a valid disposable fixture without writes", async () => {
    await withSeedDatabase(async ({ app, url }) => {
      const before = await rowSnapshot(app);
      const result = await runSeed({ ...syntheticSeedEnv(url), NODE_ENV: "production" });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.includes("UNSAFE_TARGET")).toBe(true);
      expect(await rowSnapshot(app)).toBe(before);
    });
  }, 60_000);

  it("first-seed: audit failure rolls back the administrator and all configuration writes", async () => {
    await withSeedDatabase(async ({ admin, app, url }) => {
      await admin.$executeRawUnsafe('REVOKE INSERT ON "AuditLog" FROM phase010_app');
      const before = await rowSnapshot(app);
      const result = await runSeed(syntheticSeedEnv(url));
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.includes("DATABASE_FAILURE")).toBe(true);
      expect(await rowSnapshot(app)).toBe(before);
    });
  }, 60_000);

  it.each(["MIGRATION_DRIFT", "MARKER", "OWNER"] as const)(
    "first-seed: rejects %s before business writes",
    async (kind) => {
      await withSeedDatabase(async ({ admin, app, url, database, config }) => {
        if (kind === "MIGRATION_DRIFT")
          await admin.$executeRawUnsafe(
            "UPDATE \"_prisma_migrations\" SET checksum=repeat('0',64)",
          );
        if (kind === "MARKER")
          await admin.$executeRawUnsafe(`COMMENT ON DATABASE "${database}" IS 'synthetic-unowned'`);
        const owner = new URL(config.url);
        owner.pathname = `/${database}`;
        const env = syntheticSeedEnv(kind === "OWNER" ? owner.toString() : url);
        const before = await rowSnapshot(app);
        const result = await runSeed(env);
        expect(result.exitCode).not.toBe(0);
        expect(await rowSnapshot(app)).toBe(before);
      });
    },
    60_000,
  );

  it("secret-privilege: missing/weak/invalid command inputs exit nonzero with no credential output", async () => {
    await withSeedDatabase(async ({ app, url }) => {
      const env = syntheticSeedEnv(url),
        before = await rowSnapshot(app);
      for (const overrides of [
        { ADMIN_EMAIL: undefined },
        { ADMIN_INITIAL_PASSWORD: undefined },
        { ADMIN_EMAIL: "invalid" },
        { ADMIN_INITIAL_PASSWORD: "weak" },
        { NODE_ENV: undefined },
      ]) {
        expect((await runSeed({ ...env, ...overrides })).exitCode).not.toBe(0);
        expect(await rowSnapshot(app)).toBe(before);
      }
    });
  }, 60_000);
});
