// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
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
import { hashAnonymousToken } from "@/server/anonymous-owner";
import {
  CHAT_MESSAGE_FIELDS,
  connectPhase008Database,
  DATABASE_NULL,
  DataFixture,
  SQL_CHECK_ERROR,
  SQL_FOREIGN_KEY_ERROR,
  SQL_REQUIRED_ERROR,
  TRAVEL_RECORD_FIELDS,
  TRAVEL_STATUSES,
} from "../phase008/data-fixture";

const databaseUrl = process.env.PHASE008_DATABASE_URL;
const fixtures = new Map<string, DataFixture>();
let database: PrismaClient | undefined;
let repository: typeof import("@/server/repositories/travel-record");

function getDatabase(): PrismaClient {
  if (!database) throw new Error("Phase008 database has not passed its identity guard");
  return database;
}

function getFixture(context: TestContext): DataFixture {
  const fixture = fixtures.get(context.task.id);
  if (!fixture) throw new Error("Phase008 test has no registered fixture");
  return fixture;
}

function anonymousOwner() {
  return { anonTokenHash: hashAnonymousToken(randomBytes(32).toString("base64url")) };
}

describe.skipIf(databaseUrl === undefined)("TravelRecord real PostgreSQL contract", () => {
  beforeAll(async () => {
    database = await connectPhase008Database(databaseUrl);
    repository = await import("@/server/repositories/travel-record");
  }, 30_000);

  beforeEach((context) => {
    fixtures.set(context.task.id, new DataFixture(getDatabase()));
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

  it("ownership: anonymous and authenticated owners each persist exactly one owner", async (context) => {
    const fixture = getFixture(context);
    const owner = anonymousOwner();
    const anonymous = fixture.rememberRecord(
      await repository.createTravelRecord({ owner, title: "Synthetic anonymous journey" }),
    );
    const user = await fixture.createUser();
    const authenticated = fixture.rememberRecord(
      await repository.createTravelRecord({
        owner: { userId: user.id },
        title: "Synthetic authenticated journey",
        requirementJson: null,
      }),
    );
    expect(anonymous).toMatchObject({ userId: null, anonTokenHash: owner.anonTokenHash });
    expect(authenticated).toMatchObject({ userId: user.id, anonTokenHash: null });
    expect(anonymous.requirementJson).toBeNull();
    expect(authenticated.requirementJson).toBeNull();
    expect(await repository.getTravelRecord({ owner, travelRecordId: anonymous.id })).toEqual(
      anonymous,
    );
    expect(
      await repository.getTravelRecord({
        owner: { userId: user.id },
        travelRecordId: authenticated.id,
      }),
    ).toEqual(authenticated);
  });

  // The mutation runner removes only the XOR constraint and reruns this original assertion.
  it("ownership: ownerless rows are rejected", async (context) => {
    await expect(
      getFixture(context).insertRawRecord({ userId: null, anonTokenHash: null }),
    ).rejects.toMatchObject(SQL_CHECK_ERROR);
  });

  it("ownership: dual-owned rows are rejected", async (context) => {
    const fixture = getFixture(context);
    const user = await fixture.createUser();
    await expect(
      fixture.insertRawRecord({ userId: user.id, anonTokenHash: fixture.syntheticOwnerHash() }),
    ).rejects.toMatchObject(SQL_CHECK_ERROR);
  });

  it("ownership: owner CHECK and foreign key also reject invalid updates", async (context) => {
    const db = getDatabase();
    const fixture = getFixture(context);
    const user = await fixture.createUser();
    const record = await fixture.createRecord({ userId: user.id });
    await expect(
      db.$executeRaw`UPDATE "TravelRecord" SET "userId" = NULL WHERE id = ${record.id}`,
    ).rejects.toMatchObject(SQL_CHECK_ERROR);
    await expect(
      db.$executeRaw`UPDATE "TravelRecord" SET "anonTokenHash" = ${fixture.syntheticOwnerHash()} WHERE id = ${record.id}`,
    ).rejects.toMatchObject(SQL_CHECK_ERROR);
    await expect(
      fixture.insertRawRecord({ userId: randomUUID(), anonTokenHash: null }),
    ).rejects.toMatchObject(SQL_FOREIGN_KEY_ERROR);
    expect(await db.travelRecord.findUniqueOrThrow({ where: { id: record.id } })).toMatchObject({
      userId: user.id,
      anonTokenHash: null,
    });
  });

  it("ownership: wrong and missing owners cannot read a known record", async (context) => {
    const fixture = getFixture(context);
    const owner = anonymousOwner();
    const otherOwner = anonymousOwner();
    const user = await fixture.createUser();
    const record = await fixture.createRecord({ anonTokenHash: owner.anonTokenHash });
    for (const wrongOwner of [otherOwner, { userId: user.id }]) {
      await expect(
        repository.getTravelRecord({ owner: wrongOwner, travelRecordId: record.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(
      repository.getTravelRecord({ owner, travelRecordId: randomUUID() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      repository.getTravelRecord({ owner: {} as never, travelRecordId: record.id }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("ownership: transfer atomically replaces the anonymous owner and preserves history", async (context) => {
    const fixture = getFixture(context);
    const owner = anonymousOwner();
    const user = await fixture.createUser();
    const record = await fixture.createRecord({ anonTokenHash: owner.anonTokenHash });
    const message = await fixture.createMessage(record.id);
    const transferred = await repository.transferAnonymousTravelRecordToUser({
      owner,
      travelRecordId: record.id,
      userId: user.id,
    });
    expect(transferred).toMatchObject({
      id: record.id,
      userId: user.id,
      anonTokenHash: null,
      version: 0,
    });
    await expect(
      repository.getTravelRecord({ owner, travelRecordId: record.id }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      await repository.getTravelRecord({ owner: { userId: user.id }, travelRecordId: record.id }),
    ).toMatchObject({ id: record.id });
    expect(
      await getDatabase().chatMessage.findUnique({ where: { id: message.id } }),
    ).not.toBeNull();
  });

  it("ownership: failed transfer leaves the original owner and messages unchanged", async (context) => {
    const fixture = getFixture(context);
    const owner = anonymousOwner();
    const record = await fixture.createRecord({ anonTokenHash: owner.anonTokenHash });
    const message = await fixture.createMessage(record.id);
    await expect(
      repository.transferAnonymousTravelRecordToUser({
        owner,
        travelRecordId: record.id,
        userId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(
      repository.transferAnonymousTravelRecordToUser({
        owner: anonymousOwner(),
        travelRecordId: record.id,
        userId: (await fixture.createUser()).id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await repository.getTravelRecord({ owner, travelRecordId: record.id })).toMatchObject({
      userId: null,
      anonTokenHash: owner.anonTokenHash,
      version: 0,
    });
    expect(await getDatabase().chatMessage.findUnique({ where: { id: message.id } })).toEqual(
      message,
    );
  });

  it("ownership: concurrent transfers have only one authenticated owner", async (context) => {
    const fixture = getFixture(context);
    const owner = anonymousOwner();
    const record = await fixture.createRecord({ anonTokenHash: owner.anonTokenHash });
    const users = await Promise.all([fixture.createUser(), fixture.createUser()]);
    const results = await Promise.allSettled(
      users.map((user) =>
        repository.transferAnonymousTravelRecordToUser({
          owner,
          travelRecordId: record.id,
          userId: user.id,
        }),
      ),
    );
    const succeeded = results.filter((result) => result.status === "fulfilled");
    const failed = results.filter((result) => result.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toMatchObject({ code: "NOT_FOUND" });
    expect(
      await getDatabase().travelRecord.findUniqueOrThrow({ where: { id: record.id } }),
    ).toMatchObject({
      userId: succeeded[0].value.userId,
      anonTokenHash: null,
    });
  });

  it("lifecycle-version: the two baseline migrations and one additive migration are applied", async () => {
    const migrations = await getDatabase().$queryRaw<
      Array<{ name: string; finished: Date | null; rolledBack: Date | null; steps: number }>
    >`
      SELECT migration_name AS name, finished_at AS finished, rolled_back_at AS "rolledBack",
             applied_steps_count AS steps FROM "_prisma_migrations" ORDER BY migration_name
    `;
    expect(migrations).toHaveLength(3);
    expect(migrations[0].name).toBe("20260910000000_init_user");
    expect(migrations[1].name).toBe("20260910172735_system_config");
    expect(migrations[2].name).toMatch(/^\d{14}_travel_record_chat_message$/);
    for (const migration of migrations) {
      expect(migration.finished).toBeInstanceOf(Date);
      expect(migration.rolledBack).toBeNull();
      expect(migration.steps).toBe(1);
    }
  });

  it("lifecycle-version: model inventory and generated fields contain only current producers", async () => {
    const models = Prisma.dmmf.datamodel.models;
    expect(models.map(({ name }) => name).sort()).toEqual([
      "ChatMessage",
      "SystemConfig",
      "TravelRecord",
      "User",
    ]);
    for (const [modelName, expectedFields] of [
      ["TravelRecord", TRAVEL_RECORD_FIELDS],
      ["ChatMessage", CHAT_MESSAGE_FIELDS],
    ] as const) {
      const model = models.find(({ name }) => name === modelName);
      expect(model?.fields.filter(({ kind }) => kind !== "object").map(({ name }) => name)).toEqual(
        expectedFields,
      );
    }
    const tables = await getDatabase().$queryRaw<Array<{ name: string }>>`
      SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `;
    expect(tables.map(({ name }) => name)).toEqual([
      "ChatMessage",
      "SystemConfig",
      "TravelRecord",
      "User",
      "_prisma_migrations",
    ]);
  });

  it("lifecycle-version: TravelRecord SQL types nullability defaults and timestamps are exact", async () => {
    const columns = await getDatabase().$queryRaw<
      Array<{
        name: string;
        type: string;
        nullable: string;
        precision: number | null;
        length: number | null;
        defaultValue: string | null;
      }>
    >`
      SELECT column_name AS name, data_type AS type, is_nullable AS nullable,
             datetime_precision AS precision, character_maximum_length AS length,
             column_default AS "defaultValue"
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'TravelRecord' ORDER BY ordinal_position
    `;
    expect(columns.map(({ name }) => name)).toEqual(TRAVEL_RECORD_FIELDS);
    for (const column of columns) {
      expect(column.nullable).toBe(
        ["userId", "anonTokenHash", "requirementJson"].includes(column.name) ? "YES" : "NO",
      );
    }
    expect(columns.find(({ name }) => name === "anonTokenHash")).toMatchObject({
      type: "character",
      length: 64,
    });
    expect(columns.find(({ name }) => name === "title")?.type).toBe("text");
    expect(columns.find(({ name }) => name === "requirementJson")?.type).toBe("jsonb");
    expect(columns.find(({ name }) => name === "status")).toMatchObject({
      type: "USER-DEFINED",
      defaultValue: "'DRAFT'::\"TravelStatus\"",
    });
    expect(columns.find(({ name }) => name === "version")).toMatchObject({
      type: "integer",
      defaultValue: "0",
    });
    for (const name of ["createdAt", "updatedAt"]) {
      expect(columns.find((column) => column.name === name)).toMatchObject({
        type: "timestamp with time zone",
        precision: 3,
      });
    }
    expect(columns.find(({ name }) => name === "createdAt")?.defaultValue).toBe(
      "CURRENT_TIMESTAMP",
    );
  });

  it("lifecycle-version: all three new enum inventories match their exact contracts", async () => {
    const rows = await getDatabase().$queryRaw<Array<{ name: string; value: string }>>`
      SELECT t.typname AS name, e.enumlabel AS value FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' ORDER BY t.typname, e.enumsortorder
    `;
    expect([...new Set(rows.map(({ name }) => name))]).toEqual([
      "ChatMessageKind",
      "MessageRole",
      "Role",
      "TravelStatus",
      "UserStatus",
    ]);
    expect(rows.filter(({ name }) => name === "TravelStatus").map(({ value }) => value)).toEqual(
      TRAVEL_STATUSES,
    );
    expect(rows.filter(({ name }) => name === "MessageRole").map(({ value }) => value)).toEqual([
      "USER",
      "ASSISTANT",
      "SYSTEM",
    ]);
    expect(rows.filter(({ name }) => name === "ChatMessageKind").map(({ value }) => value)).toEqual(
      ["TEXT", "STRUCTURED"],
    );
  });

  it("lifecycle-version: owner and status query indexes and CHECK constraints exist", async () => {
    const db = getDatabase();
    const indexes = await db.$queryRaw<Array<{ name: string; definition: string }>>`
      SELECT indexname AS name, indexdef AS definition FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'TravelRecord' ORDER BY indexname
    `;
    expect(indexes.map(({ name }) => name)).toEqual([
      "TravelRecord_anonTokenHash_createdAt_id_idx",
      "TravelRecord_pkey",
      "TravelRecord_status_updatedAt_id_idx",
      "TravelRecord_userId_createdAt_id_idx",
    ]);
    expect(
      indexes.find(({ name }) => name === "TravelRecord_userId_createdAt_id_idx")?.definition,
    ).toContain('("userId", "createdAt", id)');
    expect(
      indexes.find(({ name }) => name === "TravelRecord_anonTokenHash_createdAt_id_idx")
        ?.definition,
    ).toContain('("anonTokenHash", "createdAt", id)');
    expect(
      indexes.find(({ name }) => name === "TravelRecord_status_updatedAt_id_idx")?.definition,
    ).toContain('(status, "updatedAt", id)');
    const checks = await db.$queryRaw<Array<{ name: string }>>`
      SELECT conname AS name FROM pg_constraint
      WHERE conrelid = '"TravelRecord"'::regclass AND contype = 'c' ORDER BY conname
    `;
    expect(checks.map(({ name }) => name)).toEqual([
      "TravelRecord_anonTokenHash_format",
      "TravelRecord_owner_xor",
      "TravelRecord_version_nonnegative",
    ]);
  });

  it.for(TRAVEL_STATUSES)(
    "lifecycle-version: status %s round-trips without implying transition rules",
    async (status, context) => {
      const fixture = getFixture(context);
      const row = await fixture.createRecord({ status });
      expect(
        (await getDatabase().travelRecord.findUniqueOrThrow({ where: { id: row.id } })).status,
      ).toBe(status);
    },
  );

  it("lifecycle-version: a fresh record starts at DRAFT version zero with no requirement", async (context) => {
    const row = await getFixture(context).createRecord();
    expect(row).toMatchObject({ status: "DRAFT", version: 0, requirementJson: null, userId: null });
    expect(row.id).toMatch(/^c[a-z0-9]+$/);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
    expect(Object.keys(row)).toEqual(TRAVEL_RECORD_FIELDS);
  });

  it("lifecycle-version: updating a title advances updatedAt without incrementing version", async (context) => {
    const fixture = getFixture(context);
    const initial = new Date("2020-01-01T00:00:00.000Z");
    const row = await fixture.createRecord({ updatedAt: initial });
    const changed = await getDatabase().travelRecord.update({
      where: { id: row.id },
      data: { title: "Updated synthetic title" },
    });
    expect(changed.updatedAt.getTime()).toBeGreaterThan(initial.getTime());
    expect(changed.createdAt).toEqual(row.createdAt);
    expect(changed.version).toBe(0);
  });

  it("lifecycle-version: the repository persists a cleaned display title without adding identity fields", async (context) => {
    const fixture = getFixture(context);
    const row = fixture.rememberRecord(
      await repository.createTravelRecord({
        owner: anonymousOwner(),
        title: "  <b>Synthetic\u0000 title</b>\n  ",
      }),
    );
    expect(row.title).toBe("Synthetic title");
    expect(row.version).toBe(0);
    expect(Object.keys(row)).toEqual(TRAVEL_RECORD_FIELDS);
  });

  it("lifecycle-version: negative versions fail INSERT and UPDATE with no partial write", async (context) => {
    const fixture = getFixture(context);
    await expect(fixture.insertRawRecord({ version: -1 })).rejects.toMatchObject(SQL_CHECK_ERROR);
    const row = await fixture.createRecord();
    await expect(
      getDatabase().$executeRaw`UPDATE "TravelRecord" SET version = -1 WHERE id = ${row.id}`,
    ).rejects.toMatchObject(SQL_CHECK_ERROR);
    expect(
      (await getDatabase().travelRecord.findUniqueOrThrow({ where: { id: row.id } })).version,
    ).toBe(0);
  });

  it.for(["title", "status", "version"] as const)(
    "lifecycle-version: required %s rejects SQL NULL",
    async (field, context) => {
      await expect(getFixture(context).insertRawRecord({ [field]: null })).rejects.toMatchObject(
        SQL_REQUIRED_ERROR,
      );
    },
  );

  it("lifecycle-version: nullable JSON schema storage is separate from unavailable product validation", async (context) => {
    const fixture = getFixture(context);
    const row = await fixture.createRecord({ requirementJson: DATABASE_NULL });
    expect(row.requirementJson).toBeNull();
    // This direct Prisma fixture verifies storage only; Phase017 has not validated this value.
    const changed = await getDatabase().travelRecord.update({
      where: { id: row.id },
      data: { requirementJson: { syntheticStorageProbe: true } },
    });
    expect(changed.requirementJson).toEqual({ syntheticStorageProbe: true });
    const reset = await getDatabase().travelRecord.update({
      where: { id: row.id },
      data: { requirementJson: DATABASE_NULL },
    });
    expect(reset.requirementJson).toBeNull();
  });

  it("lifecycle-version: unavailable JSON schema fails closed without creating a record", async (context) => {
    const fixture = getFixture(context);
    const owner = anonymousOwner();
    for (const requirementJson of [{}, [], "unvalidated", { destinations: [] }]) {
      await expect(
        repository
          .createTravelRecord({
            owner,
            title: fixture.uniqueLabel(),
            requirementJson: requirementJson as never,
          })
          .then((row) => fixture.rememberRecord(row)),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(
      await getDatabase().travelRecord.count({ where: { anonTokenHash: owner.anonTokenHash } }),
    ).toBe(0);
  });

  it("hash: malformed hash values fail the real database format CHECK", async (context) => {
    const fixture = getFixture(context);
    for (const anonTokenHash of [
      "",
      "a".repeat(63),
      "A".repeat(64),
      "g".repeat(64),
      `${"a".repeat(63)} `,
      `${"a".repeat(63)}\n`,
    ]) {
      await expect(fixture.insertRawRecord({ anonTokenHash })).rejects.toMatchObject(
        SQL_CHECK_ERROR,
      );
    }
    const row = await fixture.createRecord();
    await expect(
      getDatabase()
        .$executeRaw`UPDATE "TravelRecord" SET "anonTokenHash" = ${"A".repeat(64)} WHERE id = ${row.id}`,
    ).rejects.toMatchObject(SQL_CHECK_ERROR);
    expect(
      (await getDatabase().travelRecord.findUniqueOrThrow({ where: { id: row.id } })).anonTokenHash,
    ).toBe(row.anonTokenHash);
  });

  it("hash: the fixed-width column rejects oversized input rather than silently truncating it", async (context) => {
    await expect(
      getFixture(context).insertRawRecord({ anonTokenHash: "a".repeat(65) }),
    ).rejects.toMatchObject({ code: "P2010", meta: { code: "22001" } });
  });

  it("ownership: a failed CHECK rolls back earlier writes and stops later writes", async (context) => {
    const fixture = getFixture(context);
    const record = await fixture.createRecord();
    const messageId = randomUUID();
    let reachedAfterFailure = false;
    await expect(
      getDatabase().$transaction(async (tx) => {
        await tx.travelRecord.update({
          where: { id: record.id },
          data: { title: "Should roll back" },
        });
        await tx.$executeRaw`UPDATE "TravelRecord" SET "anonTokenHash" = NULL WHERE id = ${record.id}`;
        reachedAfterFailure = true;
        await tx.chatMessage.create({
          data: {
            id: messageId,
            travelRecordId: record.id,
            sequence: 1,
            role: "SYSTEM",
            kind: "TEXT",
            content: "Must never be persisted",
          },
        });
      }),
    ).rejects.toMatchObject(SQL_CHECK_ERROR);
    expect(reachedAfterFailure).toBe(false);
    expect(
      (await getDatabase().travelRecord.findUniqueOrThrow({ where: { id: record.id } })).title,
    ).toBe(record.title);
    expect(await getDatabase().chatMessage.findUnique({ where: { id: messageId } })).toBeNull();
  });
});
