import "server-only";

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { compare, getRounds, hash as hashPassword } from "bcryptjs";
import type { User } from "@prisma/client";
import type { EnvValue } from "@/lib/env-schema";
import { stableStringify } from "@/lib/json";
import { AuditLogError } from "@/server/audit-log";
import {
  parseSeedInput,
  SEED_CONFIG_DEFAULTS,
  SEED_RETRY_DELAYS_MS,
  SEED_SOURCE_MARKER,
  SeedError,
  type SeedErrorCode,
  type SeedInput,
} from "@/server/seed-input";
import {
  AuditTransactionConflictError,
  openAuditedSeedDatabase,
  writeAuditLog,
  type AuditTransactionClient,
} from "@/server/services/audit-log-service";

export interface SeedResult {
  status: "SEEDED" | "UNCHANGED";
  administratorCreated: number;
  configsCreated: number;
  auditsCreated: number;
  retries: number;
}

// A no-op deliberately aborts a transaction containing only validated reads. It never relaxes
// the audit boundary's rule that every COMMIT must include successful, awaited audit writes.
class SeedNoChanges extends AuditLogError {}
class SeedRejected extends AuditLogError {
  constructor(readonly seedCode: SeedErrorCode) {
    super("VALIDATION_ERROR");
  }
}
function reject(code: SeedErrorCode): never {
  throw new SeedRejected(code);
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function localMigrations(): Array<{ name: string; checksum: string }> {
  try {
    const directory = path.resolve("prisma/migrations");
    const migrations = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    if (
      !migrations.length ||
      migrations.some((entry) => !/^[0-9]{14}_[a-z0-9_]+$/.test(entry.name))
    )
      throw new Error();
    return migrations
      .map((entry) => ({
        name: entry.name,
        checksum: sha256(
          fs.readFileSync(path.join(directory, entry.name, "migration.sql"), "utf8"),
        ),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    throw new SeedError("MIGRATION_DRIFT");
  }
}

async function checkDatabase(
  tx: AuditTransactionClient,
  input: SeedInput,
  migrations: ReturnType<typeof localMigrations>,
): Promise<void> {
  const [identity] = await tx.$queryRaw<
    Array<{
      database: string;
      role: string;
      version: string;
      marker: string | null;
      unsafe: boolean;
    }>
  >`
    SELECT d.datname AS database, current_user AS role, current_setting('server_version') AS version,
           shobj_description(d.oid, 'pg_database') AS marker,
           (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls OR d.datdba = r.oid) AS unsafe
    FROM pg_database d JOIN pg_roles r ON r.rolname = current_user WHERE d.datname = current_database()
  `;
  if (
    !identity ||
    identity.database !== input.database ||
    identity.role !== input.databaseRole ||
    !/^17\./.test(identity.version) ||
    identity.marker !== input.databaseMarker ||
    identity.unsafe
  )
    reject("UNSAFE_TARGET");
  const applied = await tx.$queryRaw<
    Array<{ name: string; checksum: string; finished: boolean; rolledBack: boolean }>
  >`
    SELECT migration_name AS name, checksum, finished_at IS NOT NULL AS finished,
           rolled_back_at IS NOT NULL AS "rolledBack" FROM "_prisma_migrations" ORDER BY migration_name
  `;
  if (
    applied.length !== migrations.length ||
    applied.some(
      (entry, index) =>
        !entry.finished ||
        entry.rolledBack ||
        entry.name !== migrations[index].name ||
        entry.checksum !== migrations[index].checksum,
    )
  )
    reject("MIGRATION_DRIFT");
}

function administratorFingerprint(row: User, input: SeedInput): string {
  return sha256(
    stableStringify({
      sourceMarker: SEED_SOURCE_MARKER,
      seedRunId: input.seedRunId,
      id: row.id,
      email: row.email,
      passwordHash: row.passwordHash,
      role: row.role,
      status: row.status,
      revision: row.revision,
      sessionVersion: row.sessionVersion,
      createdAt: row.createdAt.toISOString(),
    }),
  );
}

async function applySeed(
  tx: AuditTransactionClient,
  input: SeedInput,
  migrations: ReturnType<typeof localMigrations>,
  passwordHash: string,
  readonly: boolean,
): Promise<Omit<SeedResult, "retries">> {
  await checkDatabase(tx, input, migrations);
  const administrator = await tx.user.findUnique({ where: { email: input.email } });
  const provenance = await tx.auditLog.findMany({
    where: {
      action: "SEED_ADMIN_CREATE",
      targetType: "User",
      detailJson: { path: ["seedRunId"], equals: input.seedRunId },
    },
    take: 2,
  });
  if (administrator) {
    const audit = provenance[0];
    const marker = audit?.detailJson;
    if (
      administrator.role !== "ADMIN" ||
      administrator.status !== "ACTIVE" ||
      provenance.length !== 1 ||
      audit.targetId !== administrator.id ||
      audit.actorId !== null ||
      audit.actorEmailSnapshot !== null ||
      !marker ||
      typeof marker !== "object" ||
      Array.isArray(marker) ||
      marker.systemActor !== "MIGRATION" ||
      marker.sourceMarker !== SEED_SOURCE_MARKER ||
      marker.seedFingerprint !== administratorFingerprint(administrator, input) ||
      getRounds(administrator.passwordHash) !== 12 ||
      !(await compare(input.password, administrator.passwordHash))
    )
      reject("EXISTING_DATA_CONFLICT");
  } else if (provenance.length) reject("EXISTING_DATA_CONFLICT");
  const configs = await tx.systemConfig.findMany({
    where: { key: { in: SEED_CONFIG_DEFAULTS.map((entry) => entry.key) } },
  });
  for (const config of configs) {
    const definition = SEED_CONFIG_DEFAULTS.find((entry) => entry.key === config.key);
    if (
      !definition ||
      stableStringify(config.valueJson) !== stableStringify(definition.valueJson) ||
      config.group !== definition.group ||
      config.isPublic !== false
    )
      reject("EXISTING_DATA_CONFLICT");
  }
  const missing = SEED_CONFIG_DEFAULTS.filter(
    (definition) => !configs.some((config) => config.key === definition.key),
  );
  if (administrator && missing.length === 0) throw new SeedNoChanges("VALIDATION_ERROR");
  if (readonly) reject("RETRY_EXHAUSTED");
  let administratorCreated = 0;
  if (!administrator) {
    const created = await tx.user.create({
      data: { email: input.email, passwordHash, role: "ADMIN", status: "ACTIVE" },
    });
    await writeAuditLog(tx, {
      actor: { kind: "SYSTEM", systemActor: "MIGRATION" },
      action: "SEED_ADMIN_CREATE",
      targetType: "User",
      targetId: created.id,
      detailJson: {
        result: "SUCCESS",
        sourceMarker: SEED_SOURCE_MARKER,
        seedRunId: input.seedRunId,
        seedFingerprint: administratorFingerprint(created, input),
      },
    });
    administratorCreated = 1;
  }
  for (const definition of missing) {
    const created = await tx.systemConfig.create({ data: definition });
    await writeAuditLog(tx, {
      actor: { kind: "SYSTEM", systemActor: "MIGRATION" },
      action: "SEED_CONFIG_CREATE",
      targetType: "SystemConfig",
      targetId: created.id,
      detailJson: {
        result: "SUCCESS",
        sourceMarker: SEED_SOURCE_MARKER,
        seedRunId: input.seedRunId,
        count: 1,
        isPublic: false,
      },
    });
  }
  return {
    status: "SEEDED",
    administratorCreated,
    configsCreated: missing.length,
    auditsCreated: administratorCreated + missing.length,
  };
}

/** Only serialization/unique conflicts retry. Every replay revalidates ownership and content. */
export async function seedDatabase(env: Readonly<Record<string, EnvValue>>): Promise<SeedResult> {
  const input = parseSeedInput(env);
  const migrations = localMigrations();
  const database = openAuditedSeedDatabase(input.databaseUrl);
  let retries = 0;
  try {
    const passwordHash = await hashPassword(input.password, 12);
    for (;;) {
      try {
        const result = await database.transaction((tx) =>
          applySeed(tx, input, migrations, passwordHash, false),
        );
        return { ...result, retries };
      } catch (error: unknown) {
        if (error instanceof SeedNoChanges)
          return {
            status: "UNCHANGED",
            administratorCreated: 0,
            configsCreated: 0,
            auditsCreated: 0,
            retries,
          };
        if (!(error instanceof AuditTransactionConflictError)) throw error;
        if (retries === SEED_RETRY_DELAYS_MS.length) break;
        await delay(SEED_RETRY_DELAYS_MS[retries++]);
      }
    }
    // One final read-only reconciliation covers a winner that committed after our last retry.
    try {
      await database.transaction((tx) => applySeed(tx, input, migrations, passwordHash, true));
    } catch (error: unknown) {
      if (error instanceof SeedNoChanges)
        return {
          status: "UNCHANGED",
          administratorCreated: 0,
          configsCreated: 0,
          auditsCreated: 0,
          retries,
        };
      throw error;
    }
    throw new SeedError("RETRY_EXHAUSTED");
  } catch (error: unknown) {
    if (error instanceof SeedError) throw error;
    if (error instanceof SeedRejected) throw new SeedError(error.seedCode);
    if (error instanceof AuditTransactionConflictError) throw new SeedError("RETRY_EXHAUSTED");
    throw new SeedError("DATABASE_FAILURE");
  } finally {
    await database.disconnect().catch(() => {
      throw new SeedError("DATABASE_FAILURE");
    });
  }
}
