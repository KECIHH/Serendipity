import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient, type User } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normalizeEmailV1 } from "@/server/auth";
import { connectDb, DatabaseUnavailableError, db } from "@/server/db";

// This is synthetic hash-shaped test data, never a credential or an authentication fixture.
const syntheticHash = `$2b$12$${"a".repeat(53)}`;
const target = new URL(process.env.DATABASE_URL ?? "");
let createdUserIds = new Set<string>();
let fixturePrefix: string;

beforeAll(async () => {
  expect(target.hostname).toBe("127.0.0.1");
  expect(target.pathname).toMatch(
    /^\/phase(?:00[6789]|01[01234])_disposable_[a-f0-9]{12}(?:_[a-z0-9_]+)?$/,
  );
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
  const markedPhase = /^\/phase(00[789]|01[01234])_disposable_([a-f0-9]{12})(?:_[a-z0-9_]+)?$/.exec(
    target.pathname,
  );
  if (markedPhase)
    expect(identity.marker).toBe(`serendipity-phase${markedPhase[1]}-disposable:${markedPhase[2]}`);
});
beforeEach(() => {
  createdUserIds = new Set<string>();
  fixturePrefix = randomUUID().replaceAll("-", "");
});

afterEach(async () => {
  if (createdUserIds.size > 0) {
    await db.user.deleteMany({ where: { id: { in: [...createdUserIds] } } });
    createdUserIds.clear();
  }
});

afterAll(async () => {
  await db.$disconnect();
});

async function insertRaw(email: string, revision = 0, sessionVersion = 0): Promise<string> {
  const id = randomUUID();
  await db.$executeRaw`INSERT INTO "User" (id, email, "passwordHash", revision, "sessionVersion", "updatedAt") VALUES (${id}, ${email}, ${syntheticHash}, ${revision}, ${sessionVersion}, NOW())`;
  createdUserIds.add(id);
  return id;
}

async function createUser(data: Prisma.UserCreateInput): Promise<User> {
  const user = await db.user.create({ data });
  createdUserIds.add(user.id);
  return user;
}

async function countFixtureUsers(): Promise<number> {
  return db.user.count({ where: { id: { in: [...createdUserIds] } } });
}

describe("real PostgreSQL User contract", () => {
  it("schema: User retains its required enum/index/field inventory as later models are added", async () => {
    const models = Prisma.dmmf.datamodel.models;
    const userModel = models.find(({ name }) => name === "User");
    expect(userModel).toBeDefined();
    expect(
      userModel?.fields
        .filter(({ kind }) => kind !== "object")
        .map(({ name }) => name)
        .sort(),
    ).toEqual(
      [
        "id",
        "email",
        "phone",
        "name",
        "avatarUrl",
        "passwordHash",
        "role",
        "status",
        "sessionVersion",
        "revision",
        "lastLoginAt",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
    const tables = await db.$queryRaw<
      Array<{ tablename: string }>
    >`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
    expect(tables.map(({ tablename }) => tablename)).toEqual(
      expect.arrayContaining(["User", "_prisma_migrations"]),
    );
    const roles = await db.$queryRaw<
      Array<{ value: string }>
    >`SELECT e.enumlabel AS value FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='Role' ORDER BY e.enumsortorder`;
    const statuses = await db.$queryRaw<
      Array<{ value: string }>
    >`SELECT e.enumlabel AS value FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='UserStatus' ORDER BY e.enumsortorder`;
    expect(roles.map(({ value }) => value)).toEqual(["USER", "ADMIN"]);
    expect(statuses.map(({ value }) => value)).toEqual(["ACTIVE", "DISABLED"]);
    const indexes = await db.$queryRaw<
      Array<{ indexname: string; indexdef: string }>
    >`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='User' ORDER BY indexname`;
    const includesAdmin = models.some(({ name }) => name === "AdminCommandReceipt");
    expect(indexes.map(({ indexname }) => indexname)).toEqual(
      [
        "User_email_key",
        "User_pkey",
        "User_status_idx",
        ...(includesAdmin ? ["User_createdAt_id_idx", "User_role_status_id_idx"] : []),
      ].sort(),
    );
    if (includesAdmin) {
      expect(
        indexes.find(({ indexname }) => indexname === "User_createdAt_id_idx")?.indexdef,
      ).toContain('USING btree ("createdAt", id)');
      expect(
        indexes.find(({ indexname }) => indexname === "User_role_status_id_idx")?.indexdef,
      ).toContain("USING btree (role, status, id)");
    }
    expect(indexes.find(({ indexname }) => indexname === "User_email_key")?.indexdef).toContain(
      "UNIQUE",
    );
    expect(indexes.filter(({ indexdef }) => indexdef.includes("(email)"))).toHaveLength(1);
  });

  it("revision: defaults to zero independently of sessions and role", async () => {
    const user = await createUser({
      email: normalizeEmailV1(` Fixture.${fixturePrefix}@EXAMPLE.INVALID `),
      passwordHash: syntheticHash,
    });
    expect(user).toMatchObject({
      email: `fixture.${fixturePrefix}@example.invalid`,
      role: "USER",
      status: "ACTIVE",
      revision: 0,
      sessionVersion: 0,
      phone: null,
      name: null,
      avatarUrl: null,
      lastLoginAt: null,
      passwordHash: syntheticHash,
    });
    expect(user.id).toMatch(/^c[a-z0-9]+$/);
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);
  });

  it("revision: timestamps do not silently increment the management revision", async () => {
    const initial = new Date("2020-01-01T00:00:00.000Z");
    const user = await createUser({
      email: `timestamps.${fixturePrefix}@example.invalid`,
      passwordHash: syntheticHash,
      updatedAt: initial,
    });
    const changed = await db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date("2026-01-01T00:00:00.000Z") },
    });
    expect(changed.updatedAt.getTime()).toBeGreaterThan(initial.getTime());
    expect(changed.revision).toBe(0);
    expect(changed.sessionVersion).toBe(0);
    const explicit = await db.user.update({
      where: { id: user.id },
      data: { revision: { increment: 1 } },
    });
    expect(explicit.revision).toBe(1);
    expect(explicit.sessionVersion).toBe(0);
  });

  it("revision: database rejects negative revision and sessionVersion", async () => {
    await expect(
      insertRaw(`negative-revision.${fixturePrefix}@example.invalid`, -1),
    ).rejects.toMatchObject({
      code: "P2010",
      meta: { code: "23514" },
    });
    await expect(
      insertRaw(`negative-session.${fixturePrefix}@example.invalid`, 0, -1),
    ).rejects.toMatchObject({
      code: "P2010",
      meta: { code: "23514" },
    });
    expect(await countFixtureUsers()).toBe(0);
    const id = await insertRaw(`positive.${fixturePrefix}@example.invalid`, 2, 3);
    const user = await db.user.findUniqueOrThrow({ where: { id } });
    await expect(
      db.$executeRaw`UPDATE "User" SET revision=-1 WHERE id=${user.id}`,
    ).rejects.toMatchObject({ code: "P2010", meta: { code: "23514" } });
    await expect(
      db.$executeRaw`UPDATE "User" SET "sessionVersion"=-1 WHERE id=${user.id}`,
    ).rejects.toMatchObject({ code: "P2010", meta: { code: "23514" } });
    expect(await db.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({
      revision: 2,
      sessionVersion: 3,
    });
  });

  it("email-unique: equivalent casing and IDNA inputs cannot create two rows", async () => {
    const first = normalizeEmailV1(` User.${fixturePrefix}@例え.テスト `);
    const equivalent = normalizeEmailV1(
      `USER.${fixturePrefix.toUpperCase()}@XN--R8JZ45G.XN--ZCKZAH`,
    );
    expect(first).toBe(equivalent);
    await insertRaw(first);
    await expect(insertRaw(equivalent)).rejects.toMatchObject({
      code: "P2010",
      meta: { code: "23505" },
    });
    expect(await countFixtureUsers()).toBe(1);
  });

  it("email-unique: concurrent canonical registrations have one database winner", async () => {
    const email = normalizeEmailV1(`RACE.${fixturePrefix}@faß.de`);
    const results = await Promise.allSettled([
      createUser({ email, passwordHash: syntheticHash }),
      createUser({
        email: normalizeEmailV1(` race.${fixturePrefix.toUpperCase()}@XN--FA-HIA.DE `),
        passwordHash: syntheticHash,
      }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "P2002" });
    expect(await countFixtureUsers()).toBe(1);
  });

  it.each([
    "User@example.invalid",
    " user@example.invalid",
    "user@example.invalid ",
    "user@EXAMPLE.INVALID",
    "user@例え.テスト",
    "用户@example.invalid",
    ".a@example.invalid",
    "a.@example.invalid",
    "a..b@example.invalid",
    "a b@example.invalid",
    "a@example.invalid\n",
    "a@-label.invalid",
    "a@label-.invalid",
    "a@label..invalid",
    "a@example.invalid.",
    "a@bad_label.invalid",
    "a@@example.invalid",
    "a@example.invalid/path",
    "a@",
    "@example.invalid",
    `${"a".repeat(65)}@example.invalid`,
    `a@${"b".repeat(64)}.invalid`,
    `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`,
  ])("email-check: rejects noncanonical direct database value %j", async (email) => {
    await expect(insertRaw(email)).rejects.toMatchObject({
      code: "P2010",
      meta: { code: "23514" },
    });
    expect(await countFixtureUsers()).toBe(0);
  });

  it("email-check: accepts maximum canonical lengths and all allowed local atoms", async () => {
    const boundary = `${fixturePrefix}${"a".repeat(32)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    await insertRaw(normalizeEmailV1(boundary));
    await insertRaw(normalizeEmailV1(`!#$%&'*+/=?^_\`{|}~-.${fixturePrefix}@example.invalid`));
    await insertRaw(normalizeEmailV1(`number.${fixturePrefix}@127.1`));
    expect(await countFixtureUsers()).toBe(3);
  });

  it("failure: a real refused connection crosses only the redacted boundary", async () => {
    const refused = new URL(target);
    refused.port = "1";
    refused.searchParams.set("connect_timeout", "1");
    // Explicit driver fault injection in a test only; product consumers use the db singleton.
    const client = new PrismaClient({ datasourceUrl: refused.toString(), log: [] });
    try {
      await expect(connectDb(client)).rejects.toBeInstanceOf(DatabaseUnavailableError);
      const error = await connectDb(client).catch((failure: Error) => failure);
      expect(error).toMatchObject({ message: "Database is unavailable" });
      expect((error as Error).cause).toBeUndefined();
    } finally {
      await client.$disconnect();
    }
  });
});
