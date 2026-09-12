// @vitest-environment node
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type TestContext,
} from "vitest";
import { parseSystemConfigGroup } from "@/lib/schemas/system-config";
import { ADMIN_USER_SELECT } from "@/server/projections/admin-user";
import { PUBLIC_USER_SELECT } from "@/server/projections/public-user";
import {
  ConfigFixture,
  EXPECTED_ADMIN_USER_FIELDS,
  EXPECTED_PUBLIC_USER_FIELDS,
} from "../phase007/config-fixture";

const databaseUrl = process.env.PHASE007_DATABASE_URL;
const fixtures = new Map<string, ConfigFixture>();
let database: PrismaClient | undefined;

function readDisposableTarget(value: string | undefined): {
  target: URL;
  runId: string;
  phase: string;
} {
  let target: URL;
  try {
    if (value === undefined) throw new Error();
    target = new URL(value);
  } catch {
    throw new Error("PHASE007_DATABASE_URL must identify this run's disposable database");
  }
  const name = /^\/phase(00[789]|01[012])_disposable_([a-f0-9]{12})(?:_[a-z0-9_]+)?$/.exec(
    target.pathname,
  );
  const allowedOptions = new Set(["schema", "connect_timeout", "pool_timeout", "connection_limit"]);
  if (
    !["postgresql:", "postgres:"].includes(target.protocol) ||
    target.hostname !== "127.0.0.1" ||
    target.hash !== "" ||
    !name ||
    [...target.searchParams.keys()].some((key) => !allowedOptions.has(key)) ||
    (target.searchParams.has("schema") && target.searchParams.get("schema") !== "public")
  ) {
    throw new Error("Phase007 database guard rejected an unowned target");
  }
  return { target, runId: name[2], phase: name[1] };
}

function getDatabase(): PrismaClient {
  if (!database) throw new Error("Phase007 database has not passed its identity guard");
  return database;
}

function getFixture(context: TestContext): ConfigFixture {
  const fixture = fixtures.get(context.task.id);
  if (!fixture) throw new Error("Phase007 test has no registered fixture");
  return fixture;
}

describe.skipIf(databaseUrl === undefined)("SystemConfig real PostgreSQL contract", () => {
  beforeAll(async () => {
    const { target, runId, phase } = readDisposableTarget(databaseUrl);
    process.env.DATABASE_URL = target.toString();
    const { connectDb, db } = await import("@/server/db");
    database = db;
    await connectDb();
    const [identity] = await db.$queryRaw<
      Array<{ name: string; version: string; marker: string | null }>
    >`
      SELECT d.datname AS name, current_setting('server_version') AS version,
             shobj_description(d.oid, 'pg_database') AS marker
      FROM pg_database d WHERE d.datname = current_database()
    `;
    expect(identity.name).toBe(target.pathname.slice(1));
    expect(identity.version).toMatch(/^17\./);
    expect(identity.marker).toBe(`serendipity-phase${phase}-disposable:${runId}`);
  }, 30_000);

  beforeEach((context) => {
    fixtures.set(context.task.id, new ConfigFixture(getDatabase()));
  });

  afterEach(async (context) => {
    const fixture = fixtures.get(context.task.id);
    if (fixture) {
      await fixture.cleanup();
      fixtures.delete(context.task.id);
    }
  }, 30_000);

  afterAll(async () => {
    await database?.$disconnect();
  }, 30_000);

  it("migration: User and SystemConfig baseline migrations remain applied as current models evolve", async () => {
    const migrations = await getDatabase().$queryRaw<
      Array<{ name: string; finished: Date | null; rolledBack: Date | null; steps: number }>
    >`
      SELECT migration_name AS name, finished_at AS finished, rolled_back_at AS "rolledBack",
             applied_steps_count AS steps
      FROM "_prisma_migrations" ORDER BY migration_name
    `;
    const includesTravelLayer = Prisma.dmmf.datamodel.models.some(
      ({ name }) => name === "TravelRecord",
    );
    const includesAudit = Prisma.dmmf.datamodel.models.some(({ name }) => name === "AuditLog");
    const includesApiKey = Prisma.dmmf.datamodel.models.some(({ name }) => name === "ApiKeyConfig");
    const includesAuth = Prisma.dmmf.datamodel.models.some(({ name }) => name === "AuthSession");
    const includesAdminCommands = Prisma.dmmf.datamodel.models.some(
      ({ name }) => name === "AdminCommandReceipt",
    );
    expect(migrations).toHaveLength(
      includesAdminCommands
        ? 7
        : includesAuth
          ? 6
          : includesApiKey
            ? 5
            : includesAudit
              ? 4
              : includesTravelLayer
                ? 3
                : 2,
    );
    if (includesAdminCommands) expect(migrations[6].name).toMatch(/^\d{14}_admin_commands$/);
    if (includesAuth) expect(migrations[5].name).toMatch(/^\d{14}_auth_session_login_attempt$/);
    if (includesApiKey) expect(migrations[4].name).toMatch(/^\d{14}_api_key_config$/);
    if (includesAudit) expect(migrations[3].name).toMatch(/^\d{14}_audit_log$/);
    expect(migrations[0].name).toBe("20260910000000_init_user");
    expect(migrations[1].name).toBe("20260910172735_system_config");
    if (includesTravelLayer)
      expect(migrations[2].name).toMatch(/^\d{14}_travel_record_chat_message$/);
    for (const migration of migrations) {
      expect(migration.finished).toBeInstanceOf(Date);
      expect(migration.rolledBack).toBeNull();
      expect(migration.steps).toBe(1);
    }
  });

  it("schema: model and database inventories contain only the frozen fields and tables", async () => {
    const db = getDatabase();
    const models = Prisma.dmmf.datamodel.models;
    const expectedModels = models.some(({ name }) => name === "TravelRecord")
      ? ["ChatMessage", "SystemConfig", "TravelRecord", "User"]
      : ["SystemConfig", "User"];
    if (models.some(({ name }) => name === "AuditLog")) expectedModels.unshift("AuditLog");
    if (models.some(({ name }) => name === "ApiKeyConfig")) expectedModels.unshift("ApiKeyConfig");
    if (models.some(({ name }) => name === "AuthSession"))
      expectedModels.push("AuthLoginAttempt", "AuthSession");
    if (models.some(({ name }) => name === "AdminCommandReceipt"))
      expectedModels.push("AdminCommandReceipt", "KeyRotationRun");
    expectedModels.sort();
    expect(models.map(({ name }) => name).sort()).toEqual(expectedModels);
    const model = models.find(({ name }) => name === "SystemConfig");
    const fieldNames = [
      "id",
      "key",
      "valueJson",
      "description",
      "group",
      "isPublic",
      "revision",
      "updatedBy",
      "createdAt",
      "updatedAt",
    ];
    expect(model?.fields.filter(({ kind }) => kind !== "object").map(({ name }) => name)).toEqual(
      fieldNames,
    );
    expect(model?.fields.find(({ name }) => name === "group")).toMatchObject({
      kind: "scalar",
      type: "String",
      isRequired: true,
    });
    const tables = await db.$queryRaw<Array<{ name: string }>>`
      SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `;
    expect(tables.map(({ name }) => name)).toEqual([...expectedModels, "_prisma_migrations"]);
    const columns = await db.$queryRaw<
      Array<{
        name: string;
        type: string;
        nullable: string;
        precision: number | null;
        defaultValue: string | null;
      }>
    >`
      SELECT column_name AS name, data_type AS type, is_nullable AS nullable,
             datetime_precision AS precision, column_default AS "defaultValue"
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'SystemConfig' ORDER BY ordinal_position
    `;
    expect(columns.map(({ name }) => name)).toEqual(fieldNames);
    for (const column of columns) {
      expect(column.nullable).toBe(column.name === "updatedBy" ? "YES" : "NO");
    }
    expect(columns.find(({ name }) => name === "valueJson")?.type).toBe("jsonb");
    expect(columns.find(({ name }) => name === "group")?.type).toBe("text");
    expect(columns.find(({ name }) => name === "revision")).toMatchObject({
      type: "integer",
      defaultValue: "0",
    });
    expect(columns.find(({ name }) => name === "isPublic")).toMatchObject({
      type: "boolean",
      defaultValue: "false",
    });
    for (const name of ["createdAt", "updatedAt"]) {
      expect(columns.find((column) => column.name === name)).toMatchObject({
        type: "timestamp with time zone",
        precision: 3,
      });
    }
  });

  it("schema: group listing, actor lookup, uniqueness and CHECK constraints are indexed", async () => {
    const db = getDatabase();
    const indexes = await db.$queryRaw<Array<{ name: string; definition: string }>>`
      SELECT indexname AS name, indexdef AS definition FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'SystemConfig' ORDER BY indexname
    `;
    expect(indexes.map(({ name }) => name)).toEqual([
      "SystemConfig_group_key_idx",
      "SystemConfig_key_key",
      "SystemConfig_pkey",
      "SystemConfig_updatedBy_idx",
    ]);
    expect(indexes.find(({ name }) => name === "SystemConfig_group_key_idx")?.definition).toMatch(
      /\("group", key\)/,
    );
    expect(indexes.find(({ name }) => name === "SystemConfig_updatedBy_idx")?.definition).toContain(
      '("updatedBy")',
    );
    expect(indexes.find(({ name }) => name === "SystemConfig_key_key")?.definition).toContain(
      "UNIQUE",
    );
    const checks = await db.$queryRaw<Array<{ name: string }>>`
      SELECT conname AS name FROM pg_constraint
      WHERE conrelid = '"SystemConfig"'::regclass AND contype = 'c' ORDER BY conname
    `;
    expect(checks.map(({ name }) => name)).toEqual([
      "SystemConfig_group_check",
      "SystemConfig_revision_nonnegative",
    ]);
  });

  it.for(["key", "valueJson", "description", "group", "revision"] as const)(
    "schema: required %s rejects SQL NULL",
    async (field, context) => {
      await expect(getFixture(context).insertRawConfig({ [field]: null })).rejects.toMatchObject({
        code: "P2010",
        meta: { code: "23502" },
      });
    },
  );

  it("schema: JSON round-trips and timestamps do not advance revision implicitly", async (context) => {
    const db = getDatabase();
    const fixture = getFixture(context);
    const initial = new Date("2020-01-01T00:00:00.000Z");
    const valueJson = { enabled: false, displayCount: 3, items: ["compact", 2, null] };
    const row = await fixture.createConfig({ valueJson, updatedAt: initial });
    expect(row.id).toMatch(/^c[a-z0-9]+$/);
    expect(row.valueJson).toEqual(valueJson);
    expect(row.createdAt).toBeInstanceOf(Date);
    const changed = await db.systemConfig.update({
      where: { id: row.id },
      data: { valueJson: { enabled: true } },
    });
    expect(changed.updatedAt.getTime()).toBeGreaterThan(initial.getTime());
    expect(changed.revision).toBe(0);
    expect(changed.createdAt).toEqual(row.createdAt);
    await expect(fixture.insertRawConfig({ revision: -1 })).rejects.toMatchObject({
      code: "P2010",
      meta: { code: "23514" },
    });
    await expect(
      db.$executeRaw`UPDATE "SystemConfig" SET revision = -1 WHERE id = ${row.id}`,
    ).rejects.toMatchObject({ code: "P2010", meta: { code: "23514" } });
    expect((await db.systemConfig.findUniqueOrThrow({ where: { id: row.id } })).revision).toBe(0);
  });

  it("default-private: omitted visibility reads back false with revision zero and no actor", async (context) => {
    const fixture = getFixture(context);
    const row = await fixture.createConfig();
    const stored = await getDatabase().systemConfig.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.isPublic).toBe(false);
    expect(stored.revision).toBe(0);
    expect(stored.updatedBy).toBeNull();
    const rawId = await fixture.insertRawConfig();
    const rawStored = await getDatabase().systemConfig.findUniqueOrThrow({ where: { id: rawId } });
    expect(rawStored.isPublic).toBe(false);
    expect(rawStored.revision).toBe(0);
    expect(rawStored.updatedBy).toBeNull();
  });

  it("key-uniqueness: a duplicate key is rejected across groups with P2002", async (context) => {
    const fixture = getFixture(context);
    const first = await fixture.createConfig({ group: "GENERAL" });
    await expect(fixture.createConfig({ key: first.key, group: "UI" })).rejects.toMatchObject({
      code: "P2002",
    });
    expect(await getDatabase().systemConfig.count({ where: { key: first.key } })).toBe(1);
  });

  it("key-uniqueness: concurrent insertion records only the one successful owner ID", async (context) => {
    const fixture = getFixture(context);
    const key = fixture.createKey();
    const results = await Promise.allSettled([
      fixture.createConfig({ key, group: "GENERAL" }),
      fixture.createConfig({ key, group: "UI" }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure?.reason).toMatchObject({ code: "P2002" });
    expect(fixture.configIds).toHaveLength(1);
    expect(await getDatabase().systemConfig.count({ where: { key } })).toBe(1);
  });

  it.for(["AI", "UI", "EXPORT", "SECURITY", "GENERAL"])(
    "group-validation: the parser and database accept %s",
    async (group, context) => {
      const row = await getFixture(context).createConfig({ group: parseSystemConfigGroup(group) });
      expect(row.group).toBe(group);
    },
  );

  it("group-validation: unknown values fail the parser and direct SQL INSERT/UPDATE CHECK", async (context) => {
    const fixture = getFixture(context);
    expect(() => parseSystemConfigGroup("UNKNOWN")).toThrow(TypeError);
    await expect(fixture.insertRawConfig({ group: "UNKNOWN" })).rejects.toMatchObject({
      code: "P2010",
      meta: { code: "23514" },
    });
    const row = await fixture.createConfig();
    await expect(
      getDatabase().$executeRaw`UPDATE "SystemConfig" SET "group" = 'UNKNOWN' WHERE id = ${row.id}`,
    ).rejects.toMatchObject({ code: "P2010", meta: { code: "23514" } });
    expect(
      (await getDatabase().systemConfig.findUniqueOrThrow({ where: { id: row.id } })).group,
    ).toBe("GENERAL");
  });

  it("user-fk: unknown actors fail Prisma and direct SQL foreign-key validation", async (context) => {
    const fixture = getFixture(context);
    const updatedBy = randomUUID();
    await expect(fixture.createConfig({ updatedBy })).rejects.toMatchObject({ code: "P2003" });
    await expect(fixture.insertRawConfig({ updatedBy })).rejects.toMatchObject({
      code: "P2010",
      meta: { code: "23503" },
    });
  });

  it("user-fk: deleting the actor sets updatedBy to null and preserves the configuration", async (context) => {
    const fixture = getFixture(context);
    const user = await fixture.createUser();
    const row = await fixture.createConfig({ updatedBy: user.id });
    expect(row.updatedBy).toBe(user.id);
    await fixture.deleteUser(user.id);
    expect(
      await getDatabase().systemConfig.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({
      key: row.key,
      valueJson: row.valueJson,
      updatedBy: null,
    });
  });

  it("user-fk: updating an actor ID cascades and the generated inverse relation is exact", async (context) => {
    const fixture = getFixture(context);
    const user = await fixture.createUser();
    const row = await fixture.createConfig({ updatedBy: user.id });
    const updatedId = await fixture.updateUserId(user.id);
    expect(
      (await getDatabase().systemConfig.findUniqueOrThrow({ where: { id: row.id } })).updatedBy,
    ).toBe(updatedId);
    const model = Prisma.dmmf.datamodel.models.find(({ name }) => name === "SystemConfig");
    expect(model?.fields.find(({ name }) => name === "updatedByUser")).toMatchObject({
      kind: "object",
      type: "User",
      isRequired: false,
      relationFromFields: ["updatedBy"],
      relationToFields: ["id"],
      relationOnDelete: "SetNull",
      relationOnUpdate: "Cascade",
    });
    const relation = await getDatabase().user.findUniqueOrThrow({
      where: { id: updatedId },
      select: { updatedSystemConfigs: { select: { id: true } } },
    });
    expect(relation.updatedSystemConfigs).toEqual([{ id: row.id }]);
  });

  it("projection: real Prisma selects return exactly public eight and admin nine safe fields", async (context) => {
    const user = await getFixture(context).createUser({
      name: "Synthetic account",
      avatarUrl: "https://example.invalid/avatar.png",
      phone: "synthetic-phone",
      sessionVersion: 37,
      revision: 11,
      lastLoginAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const publicUser = await getDatabase().user.findUniqueOrThrow({
      where: { id: user.id },
      select: PUBLIC_USER_SELECT,
    });
    const adminUser = await getDatabase().user.findUniqueOrThrow({
      where: { id: user.id },
      select: ADMIN_USER_SELECT,
    });
    for (const field of ["passwordHash", "sessionVersion", "phone"]) {
      expect(publicUser, `Public projection must omit ${field}`).not.toHaveProperty(field);
      expect(adminUser, `Admin projection must omit ${field}`).not.toHaveProperty(field);
    }
    expect(Object.keys(publicUser).sort()).toEqual([...EXPECTED_PUBLIC_USER_FIELDS].sort());
    expect(Object.keys(adminUser).sort()).toEqual([...EXPECTED_ADMIN_USER_FIELDS].sort());
    for (const field of EXPECTED_PUBLIC_USER_FIELDS) {
      expect(publicUser[field]).toEqual(user[field]);
      expect(adminUser[field]).toEqual(user[field]);
    }
    expect(adminUser.revision).toBe(11);
    expect(publicUser).not.toHaveProperty("revision");
  });

  describe("cleanup ownership isolation", () => {
    let sentinel: ConfigFixture;
    let sentinelUserId: string;
    let sentinelConfigId: string;
    const peers = new Map<string, { userId: string; configId: string }>();
    let signalReady: () => void;
    let signalFirstCleanup: () => void;
    const bothCreated = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const firstCleaned = new Promise<void>((resolve) => {
      signalFirstCleanup = resolve;
    });

    beforeAll(async () => {
      sentinel = new ConfigFixture(getDatabase());
      const user = await sentinel.createUser();
      const config = await sentinel.createConfig({ updatedBy: user.id });
      sentinelUserId = user.id;
      sentinelConfigId = config.id;
    });

    afterAll(async () => {
      await sentinel?.cleanup();
    });

    it.concurrent.for(["first", "second"])(
      "cleanup: parallel %s test removes only its successful IDs and preserves the fixture",
      { timeout: 30_000 },
      async (owner, context) => {
        const fixture = getFixture(context);
        const db = getDatabase();
        const user = await fixture.createUser();
        const row = await fixture.createConfig({ updatedBy: user.id });
        peers.set(owner, { userId: user.id, configId: row.id });
        if (peers.size === 2) signalReady();
        await bothCreated;
        if (owner === "second") await firstCleaned;
        try {
          expect(await db.user.findUnique({ where: { id: user.id } })).not.toBeNull();
          expect(await db.systemConfig.findUnique({ where: { id: row.id } })).not.toBeNull();
          await fixture.cleanup();
          expect(await db.user.findUnique({ where: { id: user.id } })).toBeNull();
          expect(await db.systemConfig.findUnique({ where: { id: row.id } })).toBeNull();
          expect(await db.user.findUnique({ where: { id: sentinelUserId } })).not.toBeNull();
          expect(
            await db.systemConfig.findUnique({ where: { id: sentinelConfigId } }),
          ).toMatchObject({
            updatedBy: sentinelUserId,
          });
          if (owner === "first") {
            const peer = peers.get("second");
            if (!peer) throw new Error("The parallel peer has not created its fixture");
            expect(await db.user.findUnique({ where: { id: peer.userId } })).not.toBeNull();
            expect(
              await db.systemConfig.findUnique({ where: { id: peer.configId } }),
            ).not.toBeNull();
          }
        } finally {
          if (owner === "first") signalFirstCleanup();
        }
      },
    );
  });
});
