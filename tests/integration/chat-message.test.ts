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
} from "../phase008/data-fixture";

const databaseUrl = process.env.PHASE008_DATABASE_URL;
const fixtures = new Map<string, DataFixture>();
let database: PrismaClient | undefined;
let repository: typeof import("@/server/repositories/chat-message");

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

function textInput(
  travelRecordId: string,
  owner: ReturnType<typeof anonymousOwner>,
  sequence: number,
) {
  return {
    owner,
    travelRecordId,
    sequence,
    role: "USER" as const,
    kind: "TEXT" as const,
    content: "Synthetic client payload",
  };
}

describe.skipIf(databaseUrl === undefined)("ChatMessage real PostgreSQL contract", () => {
  beforeAll(async () => {
    database = await connectPhase008Database(databaseUrl);
    repository = await import("@/server/repositories/chat-message");
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

  it("ordered-messages: ChatMessage fields SQL nullability timestamps and indexes are exact", async () => {
    const db = getDatabase();
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
      WHERE table_schema = 'public' AND table_name = 'ChatMessage' ORDER BY ordinal_position
    `;
    expect(columns.map(({ name }) => name)).toEqual(CHAT_MESSAGE_FIELDS);
    for (const column of columns) {
      expect(column.nullable).toBe(
        ["contentJson", "clientMessageId", "replyToMessageId"].includes(column.name) ? "YES" : "NO",
      );
    }
    expect(columns.find(({ name }) => name === "content")?.type).toBe("text");
    expect(columns.find(({ name }) => name === "contentJson")?.type).toBe("jsonb");
    expect(columns.find(({ name }) => name === "sequence")).toMatchObject({
      type: "integer",
      defaultValue: null,
    });
    expect(columns.find(({ name }) => name === "createdAt")).toMatchObject({
      type: "timestamp with time zone",
      precision: 3,
      defaultValue: "CURRENT_TIMESTAMP",
    });
    const indexes = await db.$queryRaw<Array<{ name: string; definition: string }>>`
      SELECT indexname AS name, indexdef AS definition FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'ChatMessage' ORDER BY indexname
    `;
    expect(indexes.map(({ name }) => name)).toEqual([
      "ChatMessage_pkey",
      "ChatMessage_replyToMessageId_idx",
      "ChatMessage_travelRecordId_clientMessageId_key",
      "ChatMessage_travelRecordId_sequence_key",
    ]);
    expect(
      indexes.find(({ name }) => name === "ChatMessage_travelRecordId_sequence_key")?.definition,
    ).toMatch(/UNIQUE.*\("travelRecordId", sequence\)/);
    expect(
      indexes.find(({ name }) => name === "ChatMessage_travelRecordId_clientMessageId_key")
        ?.definition,
    ).toMatch(/UNIQUE.*\("travelRecordId", "clientMessageId"\)/);
    expect(
      indexes.find(({ name }) => name === "ChatMessage_replyToMessageId_idx")?.definition,
    ).toContain('("replyToMessageId")');
    const checks = await db.$queryRaw<Array<{ name: string }>>`
      SELECT conname AS name FROM pg_constraint
      WHERE conrelid = '"ChatMessage"'::regclass AND contype = 'c' ORDER BY conname
    `;
    expect(checks.map(({ name }) => name)).toEqual(["ChatMessage_sequence_positive"]);
  });

  // This original rejection is rerun against a separate database with only sequence uniqueness removed.
  it("ordered-messages: duplicate sequence is rejected", async (context) => {
    const fixture = getFixture(context);
    const record = await fixture.createRecord();
    await fixture.createMessage(record.id, { sequence: 1 });
    await expect(fixture.createMessage(record.id, { sequence: 1 })).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("ordered-messages: concurrent equal sequences have one database winner", async (context) => {
    const fixture = getFixture(context);
    const record = await fixture.createRecord();
    const results = await Promise.allSettled([
      fixture.createMessage(record.id, { sequence: 5, content: "First concurrent write" }),
      fixture.createMessage(record.id, { sequence: 5, content: "Second concurrent write" }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")?.reason).toMatchObject({
      code: "P2002",
    });
    expect(fixture.messageIds).toHaveLength(1);
    expect(
      await getDatabase().chatMessage.count({ where: { travelRecordId: record.id, sequence: 5 } }),
    ).toBe(1);
  });

  it("ordered-messages: sequence is required positive and unique only within its record", async (context) => {
    const fixture = getFixture(context);
    const first = await fixture.createRecord();
    const second = await fixture.createRecord();
    for (const sequence of [0, -1]) {
      await expect(fixture.insertRawMessage(first.id, { sequence })).rejects.toMatchObject(
        SQL_CHECK_ERROR,
      );
    }
    await expect(fixture.insertRawMessage(first.id, { sequence: null })).rejects.toMatchObject(
      SQL_REQUIRED_ERROR,
    );
    const message = await fixture.createMessage(first.id, { sequence: 1 });
    await fixture.createMessage(second.id, { sequence: 1 });
    await expect(
      getDatabase().$executeRaw`UPDATE "ChatMessage" SET sequence = 0 WHERE id = ${message.id}`,
    ).rejects.toMatchObject(SQL_CHECK_ERROR);
    expect(
      (await getDatabase().chatMessage.findUniqueOrThrow({ where: { id: message.id } })).sequence,
    ).toBe(1);
  });

  it("ordered-messages: same-millisecond messages paginate by sequence without skips or duplicates", async (context) => {
    const fixture = getFixture(context);
    const owner = anonymousOwner();
    const record = await fixture.createRecord({ anonTokenHash: owner.anonTokenHash });
    const createdAt = new Date("2026-01-01T00:00:00.123Z");
    const rows = await Promise.all(
      [3, 1, 2].map((sequence) => fixture.createMessage(record.id, { sequence, createdAt })),
    );
    expect(new Set(rows.map((row) => row.createdAt.getTime())).size).toBe(1);
    const first = await repository.listChatMessages({ owner, travelRecordId: record.id, limit: 1 });
    expect(first.messages.map(({ sequence }) => sequence)).toEqual([1]);
    expect(first.nextCursor).toBeTypeOf("string");
    expect(repository.decodeChatMessageCursor(first.nextCursor!)).toEqual({
      travelRecordId: record.id,
      sequence: 1,
      id: first.messages[0].id,
    });
    const second = await repository.listChatMessages({
      owner,
      travelRecordId: record.id,
      limit: 1,
      cursor: first.nextCursor,
    });
    const third = await repository.listChatMessages({
      owner,
      travelRecordId: record.id,
      limit: 1,
      cursor: second.nextCursor,
    });
    expect(second.messages.map(({ sequence }) => sequence)).toEqual([2]);
    expect(third.messages.map(({ sequence }) => sequence)).toEqual([3]);
    expect(third.nextCursor).toBeNull();
    const returned = [...first.messages, ...second.messages, ...third.messages];
    expect(new Set(returned.map(({ id }) => id)).size).toBe(3);
    expect(returned.map(({ id }) => id).sort()).toEqual(rows.map(({ id }) => id).sort());
    const all = await repository.listChatMessages({ owner, travelRecordId: record.id });
    expect(all.messages.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
  });

  it("ordered-messages: cursor verifies its record and persisted sequence-id anchor", async (context) => {
    const fixture = getFixture(context);
    const owner = anonymousOwner();
    const first = await fixture.createRecord({ anonTokenHash: owner.anonTokenHash });
    const second = await fixture.createRecord({ anonTokenHash: owner.anonTokenHash });
    const message = await fixture.createMessage(first.id, { sequence: 3 });
    const cursor = repository.encodeChatMessageCursor({
      travelRecordId: first.id,
      sequence: 3,
      id: message.id,
    });
    await expect(
      repository.listChatMessages({ owner, travelRecordId: second.id, cursor }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    for (const anchor of [
      { travelRecordId: first.id, sequence: 2, id: message.id },
      { travelRecordId: first.id, sequence: 3, id: randomUUID() },
    ]) {
      await expect(
        repository.listChatMessages({
          owner,
          travelRecordId: first.id,
          cursor: repository.encodeChatMessageCursor(anchor),
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    await expect(
      repository.listChatMessages({ owner: anonymousOwner(), travelRecordId: first.id, cursor }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("ordered-messages: an authorized empty history is empty while missing or foreign records are errors", async (context) => {
    const fixture = getFixture(context);
    const owner = anonymousOwner();
    const record = await fixture.createRecord({ anonTokenHash: owner.anonTokenHash });
    expect(await repository.listChatMessages({ owner, travelRecordId: record.id })).toEqual({
      messages: [],
      nextCursor: null,
    });
    await expect(
      repository.listChatMessages({ owner, travelRecordId: randomUUID() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      repository.listChatMessages({ owner: anonymousOwner(), travelRecordId: record.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("ordered-messages: PostgreSQL text accepts a long message without truncation", async (context) => {
    const fixture = getFixture(context);
    const owner = anonymousOwner();
    const record = await fixture.createRecord({ anonTokenHash: owner.anonTokenHash });
    const content = "Synthetic travel discussion 目的地、日期与预算。\n".repeat(2048);
    expect(content.length).toBeGreaterThan(255);
    const { message } = await repository.appendChatMessage({
      ...textInput(record.id, owner, 1),
      content,
    });
    fixture.rememberMessage(message);
    expect(message.content).toBe(content);
    expect(
      (await getDatabase().chatMessage.findUniqueOrThrow({ where: { id: message.id } })).content,
    ).toBe(content);
  });

  it.for(["role", "kind", "content"] as const)(
    "ordered-messages: required %s rejects SQL NULL",
    async (field, context) => {
      const fixture = getFixture(context);
      const record = await fixture.createRecord();
      await expect(fixture.insertRawMessage(record.id, { [field]: null })).rejects.toMatchObject(
        SQL_REQUIRED_ERROR,
      );
    },
  );

  it("ordered-messages: a missing parent record fails the real foreign key", async (context) => {
    await expect(getFixture(context).insertRawMessage(randomUUID())).rejects.toMatchObject(
      SQL_FOREIGN_KEY_ERROR,
    );
  });

  // This original rejection is rerun against a separate database with only client-id uniqueness removed.
  it("client-idempotency: duplicate client id is rejected", async (context) => {
    const fixture = getFixture(context);
    const record = await fixture.createRecord();
    const clientMessageId = fixture.uniqueLabel();
    await fixture.createMessage(record.id, { sequence: 1, clientMessageId });
    await expect(
      fixture.createMessage(record.id, { sequence: 2, clientMessageId }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("client-idempotency: concurrent duplicate client ids have one database winner", async (context) => {
    const fixture = getFixture(context);
    const record = await fixture.createRecord();
    const clientMessageId = fixture.uniqueLabel();
    const results = await Promise.allSettled([
      fixture.createMessage(record.id, { sequence: 1, clientMessageId }),
      fixture.createMessage(record.id, { sequence: 2, clientMessageId }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")?.reason).toMatchObject({
      code: "P2002",
    });
    expect(fixture.messageIds).toHaveLength(1);
    expect(
      await getDatabase().chatMessage.count({
        where: { travelRecordId: record.id, clientMessageId },
      }),
    ).toBe(1);
  });

  it("client-idempotency: null ids can repeat and non-null ids are scoped to one record", async (context) => {
    const fixture = getFixture(context);
    const first = await fixture.createRecord();
    const second = await fixture.createRecord();
    const clientMessageId = fixture.uniqueLabel();
    await fixture.createMessage(first.id, { sequence: 1, clientMessageId: null });
    await fixture.createMessage(first.id, { sequence: 2, clientMessageId: null });
    await fixture.createMessage(first.id, { sequence: 3, clientMessageId });
    await fixture.createMessage(second.id, { sequence: 1, clientMessageId });
    expect(
      await getDatabase().chatMessage.count({
        where: { travelRecordId: first.id, clientMessageId: null },
      }),
    ).toBe(2);
    expect(
      await getDatabase().chatMessage.count({
        where: { travelRecordId: { in: [first.id, second.id] }, clientMessageId },
      }),
    ).toBe(2);
  });

  it("client-idempotency: concurrent equal payload retries replay the persisted message", async (context) => {
    const fixture = getFixture(context);
    const owner = anonymousOwner();
    const record = await fixture.createRecord({ anonTokenHash: owner.anonTokenHash });
    const clientMessageId = fixture.uniqueLabel();
    const results = await Promise.all(
      [1, 2].map(async (sequence) => {
        const result = await repository.appendChatMessage({
          ...textInput(record.id, owner, sequence),
          clientMessageId,
        });
        fixture.rememberMessage(result.message);
        return result;
      }),
    );
    expect(results.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    expect(results[0].message).toEqual(results[1].message);
    expect(await getDatabase().chatMessage.count({ where: { travelRecordId: record.id } })).toBe(1);
    expect(fixture.messageIds).toHaveLength(1);
  });

  it("client-idempotency: retries ignore new scheduling sequence while preserving id and timestamp", async (context) => {
    const fixture = getFixture(context);
    const owner = anonymousOwner();
    const record = await fixture.createRecord({ anonTokenHash: owner.anonTokenHash });
    const clientMessageId = fixture.uniqueLabel();
    const original = await fixture.createMessage(record.id, {
      sequence: 3,
      clientMessageId,
      content: "Synthetic client payload",
      createdAt: new Date("2020-01-01T00:00:00.123Z"),
    });
    const replay = await repository.appendChatMessage({
      ...textInput(record.id, owner, 99),
      clientMessageId,
      contentJson: null,
      replyToMessageId: null,
    });
    fixture.rememberMessage(replay.message);
    expect(replay).toEqual({ message: original, replayed: true });
    expect(await getDatabase().chatMessage.count({ where: { travelRecordId: record.id } })).toBe(1);
  });

  it("client-idempotency: payload mismatches conflict without extra messages or record updates", async (context) => {
    const fixture = getFixture(context);
    const owner = anonymousOwner();
    const record = await fixture.createRecord({ anonTokenHash: owner.anonTokenHash });
    const target = await fixture.createMessage(record.id, { sequence: 1 });
    const clientMessageId = fixture.uniqueLabel();
    const first = await repository.appendChatMessage({
      ...textInput(record.id, owner, 2),
      clientMessageId,
    });
    fixture.rememberMessage(first.message);
    const mismatches = [
      { role: "ASSISTANT" as const },
      { content: "Different client payload" },
      { replyToMessageId: target.id },
    ];
    for (const mismatch of mismatches) {
      await expect(
        repository
          .appendChatMessage({ ...textInput(record.id, owner, 3), clientMessageId, ...mismatch })
          .then((result) => ({ ...result, message: fixture.rememberMessage(result.message) })),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    }
    expect(await getDatabase().chatMessage.count({ where: { travelRecordId: record.id } })).toBe(2);
    expect(
      await getDatabase().travelRecord.findUniqueOrThrow({ where: { id: record.id } }),
    ).toEqual(record);
  });

  it("client-idempotency: repositories preserve null semantics and allow the same key on another record", async (context) => {
    const fixture = getFixture(context);
    const owner = anonymousOwner();
    const records = await Promise.all([
      fixture.createRecord({ anonTokenHash: owner.anonTokenHash }),
      fixture.createRecord({ anonTokenHash: owner.anonTokenHash }),
    ]);
    const clientMessageId = fixture.uniqueLabel();
    for (const record of records) {
      for (const [sequence, key] of [
        [1, clientMessageId],
        [2, null],
        [3, null],
      ] as const) {
        const result = await repository.appendChatMessage({
          ...textInput(record.id, owner, sequence),
          clientMessageId: key,
        });
        fixture.rememberMessage(result.message);
        expect(result.replayed).toBe(false);
      }
    }
    expect(fixture.messageIds).toHaveLength(6);
  });

  it("client-idempotency: structured or unvalidated JSON input fails closed before a replay or write", async (context) => {
    const fixture = getFixture(context);
    const owner = anonymousOwner();
    const record = await fixture.createRecord({ anonTokenHash: owner.anonTokenHash });
    const clientMessageId = fixture.uniqueLabel();
    const original = await fixture.createMessage(record.id, {
      sequence: 1,
      clientMessageId,
      content: "Synthetic client payload",
      contentJson: DATABASE_NULL,
    });
    for (const change of [
      { kind: "STRUCTURED" as const },
      { contentJson: {} },
      { contentJson: [] },
      { contentJson: "unvalidated" },
    ]) {
      await expect(
        repository
          .appendChatMessage({
            ...textInput(record.id, owner, 2),
            clientMessageId,
            ...change,
          } as never)
          .then((result) => ({ ...result, message: fixture.rememberMessage(result.message) })),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(
      await getDatabase().chatMessage.findMany({ where: { travelRecordId: record.id } }),
    ).toEqual([original]);
  });

  it("client-idempotency: a unique failure rolls back prior work and stops following writes", async (context) => {
    const fixture = getFixture(context);
    const record = await fixture.createRecord();
    await fixture.createMessage(record.id, { sequence: 1 });
    const laterId = randomUUID();
    let reachedAfterFailure = false;
    await expect(
      getDatabase().$transaction(async (tx) => {
        await tx.travelRecord.update({
          where: { id: record.id },
          data: { title: "Must roll back" },
        });
        await tx.chatMessage.create({
          data: {
            travelRecordId: record.id,
            sequence: 1,
            role: "SYSTEM",
            kind: "TEXT",
            content: "Rejected duplicate",
          },
        });
        reachedAfterFailure = true;
        await tx.chatMessage.create({
          data: {
            id: laterId,
            travelRecordId: record.id,
            sequence: 2,
            role: "SYSTEM",
            kind: "TEXT",
            content: "Must not run",
          },
        });
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(reachedAfterFailure).toBe(false);
    expect(await getDatabase().chatMessage.findUnique({ where: { id: laterId } })).toBeNull();
    expect(await getDatabase().chatMessage.count({ where: { travelRecordId: record.id } })).toBe(1);
    expect(
      await getDatabase().travelRecord.findUniqueOrThrow({ where: { id: record.id } }),
    ).toEqual(record);
  });

  it("reply-relation: missing reply targets fail the actual self foreign key", async (context) => {
    const fixture = getFixture(context);
    const record = await fixture.createRecord();
    await expect(
      fixture.insertRawMessage(record.id, { replyToMessageId: randomUUID() }),
    ).rejects.toMatchObject(SQL_FOREIGN_KEY_ERROR);
    expect(await getDatabase().chatMessage.count({ where: { travelRecordId: record.id } })).toBe(0);
  });

  it("reply-relation: valid same-record replies are readable from both relation directions", async (context) => {
    const fixture = getFixture(context);
    const owner = anonymousOwner();
    const record = await fixture.createRecord({ anonTokenHash: owner.anonTokenHash });
    const target = await fixture.createMessage(record.id, { sequence: 1 });
    const result = await repository.appendChatMessage({
      ...textInput(record.id, owner, 2),
      replyToMessageId: target.id,
    });
    fixture.rememberMessage(result.message);
    const reply = await getDatabase().chatMessage.findUniqueOrThrow({
      where: { id: result.message.id },
      include: { replyTo: true },
    });
    expect(reply.replyTo).toEqual(target);
    const inverse = await getDatabase().chatMessage.findUniqueOrThrow({
      where: { id: target.id },
      include: { replies: true },
    });
    expect(inverse.replies).toEqual([result.message]);
  });

  it("reply-relation: repository rejects missing and cross-record targets with no later writes", async (context) => {
    const fixture = getFixture(context);
    const owner = anonymousOwner();
    const record = await fixture.createRecord({ anonTokenHash: owner.anonTokenHash });
    const other = await fixture.createRecord({ anonTokenHash: owner.anonTokenHash });
    const foreignTarget = await fixture.createMessage(other.id);
    for (const replyToMessageId of [randomUUID(), foreignTarget.id]) {
      await expect(
        repository
          .appendChatMessage({
            ...textInput(record.id, owner, 1),
            clientMessageId: fixture.uniqueLabel(),
            replyToMessageId,
          })
          .then((result) => ({ ...result, message: fixture.rememberMessage(result.message) })),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(await getDatabase().chatMessage.count({ where: { travelRecordId: record.id } })).toBe(0);
    expect(await getDatabase().chatMessage.findUnique({ where: { id: foreignTarget.id } })).toEqual(
      foreignTarget,
    );
    expect(
      await getDatabase().travelRecord.findUniqueOrThrow({ where: { id: record.id } }),
    ).toEqual(record);
  });

  it("reply-relation: the record lock rechecks current ownership before appending a reply", async (context) => {
    const db = getDatabase();
    const fixture = getFixture(context);
    const owner = anonymousOwner();
    const user = await fixture.createUser();
    const record = await fixture.createRecord({ anonTokenHash: owner.anonTokenHash });
    const target = await fixture.createMessage(record.id);
    let signalLocked!: (pid: number) => void;
    const locked = new Promise<number>((resolve) => {
      signalLocked = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transfer = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "TravelRecord" WHERE id = ${record.id} FOR UPDATE`;
        const [backend] = await tx.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        signalLocked(backend.pid);
        await released;
        await tx.travelRecord.update({
          where: { id: record.id },
          data: { userId: user.id, anonTokenHash: null },
        });
      },
      { timeout: 10_000 },
    );
    const blockerPid = await locked;
    const append = repository
      .appendChatMessage({ ...textInput(record.id, owner, 2), replyToMessageId: target.id })
      .then(
        (result) => ({
          success: true as const,
          result: { ...result, message: fixture.rememberMessage(result.message) },
        }),
        (error: unknown) => ({ success: false as const, error }),
      );
    let observedLock = false;
    try {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const [blocked] = await db.$queryRaw<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND ${blockerPid} = ANY(pg_blocking_pids(pid))
        `;
        if (blocked.count > 0) {
          observedLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      release();
      await transfer;
    }
    const result = await append;
    expect(observedLock).toBe(true);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatchObject({ code: "NOT_FOUND" });
    expect(await db.chatMessage.count({ where: { travelRecordId: record.id } })).toBe(1);
    expect(await db.travelRecord.findUniqueOrThrow({ where: { id: record.id } })).toMatchObject({
      userId: user.id,
      anonTokenHash: null,
    });
  }, 15_000);

  it("delete-policy: User Restrict record Cascade and reply SetNull are exact foreign-key policies", async () => {
    const models = Prisma.dmmf.datamodel.models;
    const recordModel = models.find(({ name }) => name === "TravelRecord");
    expect(
      recordModel?.fields.find(({ relationFromFields }) => relationFromFields?.includes("userId")),
    ).toMatchObject({ type: "User", relationOnDelete: "Restrict", relationOnUpdate: "Cascade" });
    const messageModel = models.find(({ name }) => name === "ChatMessage");
    expect(
      messageModel?.fields.find(({ relationFromFields }) =>
        relationFromFields?.includes("travelRecordId"),
      ),
    ).toMatchObject({
      type: "TravelRecord",
      relationOnDelete: "Cascade",
      relationOnUpdate: "Cascade",
    });
    expect(messageModel?.fields.find(({ name }) => name === "replyTo")).toMatchObject({
      type: "ChatMessage",
      relationFromFields: ["replyToMessageId"],
      relationToFields: ["id"],
      relationOnDelete: "SetNull",
      relationOnUpdate: "Cascade",
    });
    const constraints = await getDatabase().$queryRaw<
      Array<{ name: string; onDelete: string; onUpdate: string }>
    >`
      SELECT conname AS name, confdeltype::text AS "onDelete", confupdtype::text AS "onUpdate" FROM pg_constraint
      WHERE conrelid IN ('"TravelRecord"'::regclass, '"ChatMessage"'::regclass) AND contype = 'f'
      ORDER BY conname
    `;
    expect(constraints).toEqual([
      { name: "ChatMessage_replyToMessageId_fkey", onDelete: "n", onUpdate: "c" },
      { name: "ChatMessage_travelRecordId_fkey", onDelete: "c", onUpdate: "c" },
      { name: "TravelRecord_userId_fkey", onDelete: "r", onUpdate: "c" },
    ]);
  });

  it("delete-policy: deleting an owning user is restricted and preserves its travel history", async (context) => {
    const fixture = getFixture(context);
    const user = await fixture.createUser();
    const record = await fixture.createRecord({ userId: user.id });
    const message = await fixture.createMessage(record.id);
    await expect(fixture.deleteUser(user.id)).rejects.toMatchObject({ code: "P2003" });
    expect(await getDatabase().user.findUnique({ where: { id: user.id } })).not.toBeNull();
    expect(await getDatabase().travelRecord.findUnique({ where: { id: record.id } })).toEqual(
      record,
    );
    expect(await getDatabase().chatMessage.findUnique({ where: { id: message.id } })).toEqual(
      message,
    );
  });

  it("delete-policy: exact fixture record purge cascades only that record's messages", async (context) => {
    const fixture = getFixture(context);
    const first = await fixture.createRecord();
    const second = await fixture.createRecord();
    const deletedMessages = await Promise.all([
      fixture.createMessage(first.id, { sequence: 1 }),
      fixture.createMessage(first.id, { sequence: 2 }),
    ]);
    const survivor = await fixture.createMessage(second.id);
    await fixture.purgeRecord(first.id);
    expect(
      await getDatabase().chatMessage.count({
        where: { id: { in: deletedMessages.map(({ id }) => id) } },
      }),
    ).toBe(0);
    expect(await getDatabase().chatMessage.findUnique({ where: { id: survivor.id } })).toEqual(
      survivor,
    );
    expect(await getDatabase().travelRecord.findUnique({ where: { id: second.id } })).toEqual(
      second,
    );
  });

  it("delete-policy: deleting a reply target sets its reply links to null without deleting replies", async (context) => {
    const fixture = getFixture(context);
    const record = await fixture.createRecord();
    const target = await fixture.createMessage(record.id);
    const reply = await fixture.createMessage(record.id, {
      sequence: 2,
      replyToMessageId: target.id,
    });
    await fixture.deleteReplyTarget(target.id);
    expect(await getDatabase().chatMessage.findUniqueOrThrow({ where: { id: reply.id } })).toEqual({
      ...reply,
      replyToMessageId: null,
    });
    expect(await getDatabase().travelRecord.findUnique({ where: { id: record.id } })).toEqual(
      record,
    );
  });

  it("delete-policy: business repository exposes no individual deletion or sequence allocator", () => {
    expect(Object.keys(repository).sort()).toEqual([
      "appendChatMessage",
      "decodeChatMessageCursor",
      "encodeChatMessageCursor",
      "listChatMessages",
    ]);
  });

  it("delete-policy: concurrent fixtures clean only their recorded IDs and preserve every other fixture", async (context) => {
    const db = getDatabase();
    const sentinel = getFixture(context);
    const sentinelUser = await sentinel.createUser();
    const sentinelRecord = await sentinel.createRecord({ userId: sentinelUser.id });
    const sentinelMessage = await sentinel.createMessage(sentinelRecord.id);
    const peers = [new DataFixture(db), new DataFixture(db)];
    try {
      const rows = await Promise.all(
        peers.map(async (fixture) => {
          const user = await fixture.createUser();
          const record = await fixture.createRecord({ userId: user.id });
          const message = await fixture.createMessage(record.id);
          return { user, record, message };
        }),
      );
      expect(
        new Set([...sentinel.userIds, ...peers.flatMap((fixture) => fixture.userIds)]).size,
      ).toBe(3);
      await Promise.all(peers.map((fixture) => fixture.cleanup()));
      for (const row of rows) {
        expect(await db.user.findUnique({ where: { id: row.user.id } })).toBeNull();
        expect(await db.travelRecord.findUnique({ where: { id: row.record.id } })).toBeNull();
        expect(await db.chatMessage.findUnique({ where: { id: row.message.id } })).toBeNull();
      }
      expect(await db.user.findUnique({ where: { id: sentinelUser.id } })).toEqual(sentinelUser);
      expect(await db.travelRecord.findUnique({ where: { id: sentinelRecord.id } })).toEqual(
        sentinelRecord,
      );
      expect(await db.chatMessage.findUnique({ where: { id: sentinelMessage.id } })).toEqual(
        sentinelMessage,
      );
      await expect(peers[0].purgeRecord(sentinelRecord.id)).rejects.toThrow(
        "Fixture does not own this record",
      );
    } finally {
      await Promise.all(peers.map((fixture) => fixture.cleanup()));
    }
  });
});
