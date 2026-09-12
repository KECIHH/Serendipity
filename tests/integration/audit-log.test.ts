// @vitest-environment node
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuditContext, hashAuditIp } from "@/server/audit-log";
import {
  writeAuditLog,
  runAuditedTransaction,
  type AuditTransactionClient,
} from "@/server/services/audit-log-service";
import {
  AUDIT_FIELDS,
  AUDIT_INDEXES,
  AuditFixture,
  connectPhase009Database,
  readPhase009Target,
  rejectsOperation,
  sensitiveCanary,
  systemInput,
} from "../phase009/audit-fixture";

const databaseUrl = process.env.PHASE009_DATABASE_URL;
const runtimeUrl = process.env.PHASE009_RUNTIME_DATABASE_URL;
let admin: PrismaClient;
let app: PrismaClient;
let fixture: AuditFixture;
let databasePhase: "009" | "010" | "011" | "012" | "013" | "014";

function indexNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(indexNames);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record["Index Name"] === "string" ? [record["Index Name"]] : []),
    ...Object.values(record).flatMap(indexNames),
  ];
}

describe.skipIf(!databaseUrl)("audit-log real PostgreSQL contract", () => {
  beforeAll(async () => {
    databasePhase = readPhase009Target(runtimeUrl, true).phase;
    ({ admin, app } = await connectPhase009Database(databaseUrl, runtimeUrl));
  });
  beforeEach(() => {
    fixture = new AuditFixture(admin, app);
  });
  afterEach(async () => {
    await fixture.cleanup();
  });
  afterAll(async () => {
    await app?.$disconnect();
    await admin?.$disconnect();
  });

  it("transaction: global delegate wrappers and cloned clients cannot escape rollback", async () => {
    const config = await fixture.createConfig();
    for (const global of [true, false]) {
      const failed = await rejectsOperation(() =>
        runAuditedTransaction(async (tx) => {
          await tx.systemConfig.update({
            where: { id: config.id },
            data: { revision: { increment: 1 } },
          });
          const source = global ? app : tx;
          const wrapped = { $queryRaw: source.$queryRaw.bind(source), auditLog: source.auditLog };
          await Reflect.apply(writeAuditLog, undefined, [wrapped, systemInput(config.id)]);
        }),
      );
      expect(failed).toBe(true);
      expect(
        (await app.systemConfig.findUniqueOrThrow({ where: { id: config.id } })).revision,
      ).toBe(0);
      expect(await app.auditLog.count({ where: { targetId: config.id } })).toBe(0);
    }
  });

  it("transaction: catching invalid clients after an earlier audit rolls back both business writes", async () => {
    const first = await fixture.createConfig();
    const second = await fixture.createConfig();
    for (const global of [true, false]) {
      const failed = await rejectsOperation(() =>
        runAuditedTransaction(async (tx) => {
          await tx.systemConfig.update({ where: { id: first.id }, data: { revision: 1 } });
          await writeAuditLog(tx, systemInput(first.id));
          await tx.systemConfig.update({ where: { id: second.id }, data: { revision: 1 } });
          const source = global ? app : tx;
          try {
            await Reflect.apply(writeAuditLog, undefined, [
              { $queryRaw: source.$queryRaw.bind(source), auditLog: source.auditLog },
              systemInput(second.id),
            ]);
          } catch {
            /* Reproduce the independent reviewer's two-write, one-audit bypass. */
          }
          return "must not commit";
        }),
      );
      expect(failed).toBe(true);
      for (const id of [first.id, second.id]) {
        expect((await app.systemConfig.findUniqueOrThrow({ where: { id } })).revision).toBe(0);
        expect(await app.auditLog.count({ where: { targetId: id } })).toBe(0);
      }
    }
  });

  it("transaction: failure poisoning stays within its own concurrent async scope", async () => {
    const failing = await fixture.createConfig();
    const successful = await fixture.createConfig();
    const results = await Promise.allSettled(
      [false, true].map((success) =>
        runAuditedTransaction(async (tx) => {
          const config = success ? successful : failing;
          await tx.systemConfig.update({ where: { id: config.id }, data: { revision: 1 } });
          await writeAuditLog(tx, systemInput(config.id));
          if (!success) {
            try {
              await Reflect.apply(writeAuditLog, undefined, [
                { auditLog: app.auditLog },
                systemInput(config.id),
              ]);
            } catch {
              /* The other transaction must remain independently committable. */
            }
          }
        }),
      ),
    );
    expect(results.map(({ status }) => status)).toEqual(["rejected", "fulfilled"]);
    for (const [id, count] of [
      [failing.id, 0],
      [successful.id, 1],
    ] as const) {
      expect((await app.systemConfig.findUniqueOrThrow({ where: { id } })).revision).toBe(count);
      expect(await app.auditLog.count({ where: { targetId: id } })).toBe(count);
    }
  });

  it("transaction: nested audited transactions cannot commit a separate inner write", async () => {
    const first = await fixture.createConfig();
    const second = await fixture.createConfig();
    const failed = await rejectsOperation(() =>
      runAuditedTransaction(async (tx) => {
        await tx.systemConfig.update({ where: { id: first.id }, data: { revision: 1 } });
        await writeAuditLog(tx, systemInput(first.id));
        try {
          await runAuditedTransaction(async (inner) => {
            await inner.systemConfig.update({ where: { id: second.id }, data: { revision: 1 } });
            await writeAuditLog(inner, systemInput(second.id));
          });
        } catch {
          /* A nested boundary failure must also abort its parent. */
        }
      }),
    );
    expect(failed).toBe(true);
    for (const id of [first.id, second.id]) {
      expect((await app.systemConfig.findUniqueOrThrow({ where: { id } })).revision).toBe(0);
      expect(await app.auditLog.count({ where: { targetId: id } })).toBe(0);
    }
  });

  it("transaction: caught audit failures and missing audits still prevent a business commit", async () => {
    const config = await fixture.createConfig();
    for (const mode of ["validation", "database", "missing"] as const) {
      const failed = await rejectsOperation(() =>
        runAuditedTransaction(async (tx) => {
          await tx.systemConfig.update({
            where: { id: config.id },
            data: { revision: { increment: 1 } },
          });
          if (mode === "missing") return;
          try {
            await writeAuditLog(
              tx,
              mode === "validation"
                ? {
                    ...systemInput(config.id),
                    detailJson: { message: sensitiveCanary("exception") },
                  }
                : {
                    actor: {
                      kind: "USER",
                      id: "missing-actor",
                      emailSnapshot: "missing@example.invalid",
                    },
                    action: "CONFIG_UPDATE",
                    targetType: "SystemConfig",
                    targetId: config.id,
                  },
            );
          } catch {
            /* Deliberately emulate a forbidden best-effort caller. */
          }
        }),
      );
      expect(failed).toBe(true);
      expect(
        (await app.systemConfig.findUniqueOrThrow({ where: { id: config.id } })).revision,
      ).toBe(0);
      expect(await app.auditLog.count({ where: { targetId: config.id } })).toBe(0);
    }
  });

  it("transaction: an enrolled transaction cannot be reused after its callback ends", async () => {
    let expired: AuditTransactionClient | undefined;
    const targetId = fixture.id();
    await runAuditedTransaction(async (tx) => {
      expired = tx;
      return writeAuditLog(tx, systemInput(targetId));
    });
    await expect(
      Reflect.apply(writeAuditLog, undefined, [expired, systemInput(targetId)]),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await app.auditLog.count({ where: { targetId } })).toBe(1);
  });

  it("recursive-redaction: private text in a key name rejects the whole audited write", async () => {
    const config = await fixture.createConfig();
    const secret = sensitiveCanary("database");
    await expect(
      runAuditedTransaction(async (tx) => {
        await tx.systemConfig.update({ where: { id: config.id }, data: { revision: 1 } });
        return writeAuditLog(tx, {
          ...systemInput(config.id),
          detailJson: { metadata: { [`apiKey_${secret}`]: false } },
        });
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await app.systemConfig.findUniqueOrThrow({ where: { id: config.id } })).revision).toBe(
      0,
    );
    expect(await app.auditLog.count({ where: { targetId: config.id } })).toBe(0);
  });

  it("schema: exact fields, five indexes, optional FK and database column limits match", async () => {
    const model = Prisma.dmmf.datamodel.models.find(({ name }) => name === "AuditLog");
    expect(model?.fields.filter(({ kind }) => kind !== "object").map(({ name }) => name)).toEqual(
      AUDIT_FIELDS,
    );
    const expectedModels = ["AuditLog", "ChatMessage", "SystemConfig", "TravelRecord", "User"];
    if (Prisma.dmmf.datamodel.models.some(({ name }) => name === "ApiKeyConfig"))
      expectedModels.unshift("ApiKeyConfig");
    if (Prisma.dmmf.datamodel.models.some(({ name }) => name === "AuthSession"))
      expectedModels.push("AuthLoginAttempt", "AuthSession");
    if (Prisma.dmmf.datamodel.models.some(({ name }) => name === "AdminCommandReceipt"))
      expectedModels.push("AdminCommandReceipt", "KeyRotationRun");
    expectedModels.sort();
    expect(Prisma.dmmf.datamodel.models.map(({ name }) => name).sort()).toEqual(expectedModels);
    const columns = await admin.$queryRaw<
      Array<{
        name: string;
        nullable: string;
        type: string;
        length: number | null;
        defaultValue: string | null;
      }>
    >`
      SELECT column_name AS name, is_nullable AS nullable, data_type AS type,
             character_maximum_length AS length, column_default AS "defaultValue"
      FROM information_schema.columns WHERE table_schema='public' AND table_name='AuditLog' ORDER BY ordinal_position
    `;
    expect(columns.map(({ name }) => name)).toEqual(AUDIT_FIELDS);
    expect(columns.filter(({ nullable }) => nullable === "NO").map(({ name }) => name)).toEqual([
      "id",
      "action",
      "targetType",
      "createdAt",
    ]);
    for (const [name, length] of Object.entries({
      actorEmailSnapshot: 254,
      action: 64,
      targetType: 64,
      targetId: 128,
      requestId: 36,
      traceId: 36,
      ipHash: 64,
      userAgentSummary: 256,
    }))
      expect(columns.find((column) => column.name === name)?.length).toBe(length);
    expect(columns.find(({ name }) => name === "createdAt")).toMatchObject({
      type: "timestamp with time zone",
      defaultValue: "CURRENT_TIMESTAMP",
    });
    expect(columns.find(({ name }) => name === "detailJson")?.type).toBe("jsonb");
    const indexes = await admin.$queryRaw<
      Array<{ name: string; definition: string }>
    >`SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname='public' AND tablename='AuditLog' ORDER BY indexname`;
    expect(indexes.map(({ name }) => name)).toEqual([...AUDIT_INDEXES, "AuditLog_pkey"].sort());
    expect(
      indexes.find(({ name }) => name === "AuditLog_actorId_createdAt_idx")?.definition,
    ).toContain('("actorId", "createdAt")');
    expect(
      indexes.find(({ name }) => name === "AuditLog_targetType_targetId_createdAt_idx")?.definition,
    ).toContain('("targetType", "targetId", "createdAt")');
    const foreignKeys = await admin.$queryRaw<
      Array<{ definition: string }>
    >`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='"AuditLog"'::regclass AND contype='f'`;
    expect(foreignKeys).toEqual([
      {
        definition:
          'FOREIGN KEY ("actorId") REFERENCES "User"(id) ON UPDATE RESTRICT ON DELETE SET NULL',
      },
    ]);
    const triggers = await admin.$queryRaw<
      Array<{ name: string }>
    >`SELECT tgname AS name FROM pg_trigger WHERE tgrelid='"AuditLog"'::regclass AND NOT tgisinternal ORDER BY tgname`;
    expect(triggers.map(({ name }) => name)).toEqual([
      "AuditLog_append_only",
      "AuditLog_no_truncate",
    ]);
  });

  it("schema: database rejects malformed metadata even through raw delegate writes", async () => {
    const data = {
      action: "CONFIG_UPDATE",
      targetType: "SystemConfig",
      detailJson: { systemActor: "SCHEDULER" },
    };
    for (const extra of [
      { action: "lowercase" },
      { action: "X".repeat(65) },
      { targetType: "invalid target" },
      { targetId: "x".repeat(129) },
      { requestId: "inbound" },
      { traceId: "0".repeat(36) },
      { ipHash: "192.0.2.9" },
      { ipHash: "A".repeat(64) },
      { userAgentSummary: "x".repeat(257) },
      { userAgentSummary: "has\ncontrol" },
      { detailJson: Prisma.DbNull },
      { detailJson: { systemActor: "UNKNOWN" } },
      { detailJson: { systemActor: "SCHEDULER", secret: "x".repeat(32769) } },
    ])
      expect(
        await rejectsOperation(() => app.auditLog.create({ data: { ...data, ...extra } })),
      ).toBe(true);
  });

  it("append-only: runtime role has INSERT/SELECT without ownership, mutation or DDL privilege", async () => {
    const [role] = await app.$queryRaw<
      Array<{
        name: string;
        superuser: boolean;
        createRole: boolean;
        createDb: boolean;
        bypass: boolean;
        owner: boolean;
        update: boolean;
        delete: boolean;
        truncate: boolean;
        insert: boolean;
        select: boolean;
        createSchema: boolean;
      }>
    >`
      SELECT current_user AS name, r.rolsuper AS superuser, r.rolcreaterole AS "createRole", r.rolcreatedb AS "createDb", r.rolbypassrls AS bypass,
        pg_get_userbyid(c.relowner)=current_user AS owner,
        has_table_privilege(current_user, c.oid, 'UPDATE') AS update,
        has_table_privilege(current_user, c.oid, 'DELETE') AS delete,
        has_table_privilege(current_user, c.oid, 'TRUNCATE') AS truncate,
        has_table_privilege(current_user, c.oid, 'INSERT') AS insert,
        has_table_privilege(current_user, c.oid, 'SELECT') AS select,
        has_schema_privilege(current_user, 'public', 'CREATE') AS "createSchema"
      FROM pg_roles r, pg_class c WHERE r.rolname=current_user AND c.oid='"AuditLog"'::regclass
    `;
    expect(role).toEqual({
      name: `phase${databasePhase}_app`,
      superuser: false,
      createRole: false,
      createDb: false,
      bypass: false,
      owner: false,
      update: false,
      delete: false,
      truncate: false,
      insert: true,
      select: true,
      createSchema: false,
    });
    const ref = await runAuditedTransaction((tx) => writeAuditLog(tx, systemInput(fixture.id())));
    expect(await app.auditLog.findUnique({ where: { id: ref.id } })).not.toBeNull();
    for (const operation of [
      () => app.auditLog.update({ where: { id: ref.id }, data: { action: "USER_DISABLE" } }),
      () => app.auditLog.delete({ where: { id: ref.id } }),
      () => app.$executeRaw`TRUNCATE TABLE "AuditLog"`,
      () => app.$executeRaw`ALTER TABLE "AuditLog" DISABLE TRIGGER "AuditLog_append_only"`,
      () => app.$executeRaw`DROP TRIGGER "AuditLog_append_only" ON "AuditLog"`,
      () =>
        databasePhase === "014"
          ? app.$executeRaw`SET ROLE phase014_runner`
          : databasePhase === "013"
            ? app.$executeRaw`SET ROLE phase013_runner`
            : databasePhase === "012"
              ? app.$executeRaw`SET ROLE phase012_runner`
              : databasePhase === "011"
                ? app.$executeRaw`SET ROLE phase011_runner`
                : databasePhase === "010"
                  ? app.$executeRaw`SET ROLE phase010_runner`
                  : app.$executeRaw`SET ROLE phase009_runner`,
    ])
      expect(await rejectsOperation(operation)).toBe(true);
  });

  for (const operation of ["UPDATE", "DELETE", "TRUNCATE"] as const) {
    it(`append-only: trigger rejects ${operation} even after accidental DML grants`, async () => {
      const ref = await runAuditedTransaction((tx) => writeAuditLog(tx, systemInput(fixture.id())));
      if (databasePhase === "014")
        await admin.$executeRaw`GRANT UPDATE, DELETE, TRUNCATE ON TABLE "AuditLog" TO phase014_app`;
      else if (databasePhase === "013")
        await admin.$executeRaw`GRANT UPDATE, DELETE, TRUNCATE ON TABLE "AuditLog" TO phase013_app`;
      else if (databasePhase === "012")
        await admin.$executeRaw`GRANT UPDATE, DELETE, TRUNCATE ON TABLE "AuditLog" TO phase012_app`;
      else if (databasePhase === "011")
        await admin.$executeRaw`GRANT UPDATE, DELETE, TRUNCATE ON TABLE "AuditLog" TO phase011_app`;
      else if (databasePhase === "010")
        await admin.$executeRaw`GRANT UPDATE, DELETE, TRUNCATE ON TABLE "AuditLog" TO phase010_app`;
      else
        await admin.$executeRaw`GRANT UPDATE, DELETE, TRUNCATE ON TABLE "AuditLog" TO phase009_app`;
      try {
        const rejected = await rejectsOperation(() =>
          operation === "UPDATE"
            ? app.auditLog.update({ where: { id: ref.id }, data: { targetId: "tampered" } })
            : operation === "DELETE"
              ? app.auditLog.delete({ where: { id: ref.id } })
              : app.$executeRaw`TRUNCATE TABLE "AuditLog"`,
        );
        expect(rejected).toBe(true);
        expect(await app.auditLog.findUnique({ where: { id: ref.id } })).not.toBeNull();
      } finally {
        if (databasePhase === "014")
          await admin.$executeRaw`REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "AuditLog" FROM phase014_app`;
        else if (databasePhase === "013")
          await admin.$executeRaw`REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "AuditLog" FROM phase013_app`;
        else if (databasePhase === "012")
          await admin.$executeRaw`REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "AuditLog" FROM phase012_app`;
        else if (databasePhase === "011")
          await admin.$executeRaw`REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "AuditLog" FROM phase011_app`;
        else if (databasePhase === "010")
          await admin.$executeRaw`REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "AuditLog" FROM phase010_app`;
        else
          await admin.$executeRaw`REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "AuditLog" FROM phase009_app`;
      }
    });
  }

  it("append-only: actual User deletion nulls only its FK while retaining the snapshot", async () => {
    const user = await fixture.createUser();
    const ref = await runAuditedTransaction((tx) =>
      writeAuditLog(tx, {
        actor: { kind: "USER", id: user.id, emailSnapshot: user.email },
        action: "USER_DISABLE",
        targetType: "User",
        targetId: user.id,
      }),
    );
    const before = await app.auditLog.findUniqueOrThrow({ where: { id: ref.id } });
    expect(
      await rejectsOperation(() =>
        admin.auditLog.update({ where: { id: ref.id }, data: { actorId: null } }),
      ),
    ).toBe(true);
    expect(
      await rejectsOperation(() =>
        app.user.update({ where: { id: user.id }, data: { id: fixture.id() } }),
      ),
    ).toBe(true);
    await app.user.delete({ where: { id: user.id } });
    const after = await app.auditLog.findUniqueOrThrow({ where: { id: ref.id } });
    expect(after).toEqual({ ...before, actorId: null });
    expect(after.actorEmailSnapshot).toBe(user.email);
  });

  it("system-actor: USER and every closed SYSTEM actor support safe references and nullable targets", async () => {
    const user = await fixture.createUser();
    const userRef = await runAuditedTransaction((tx) =>
      writeAuditLog(tx, {
        actor: { kind: "USER", id: user.id, emailSnapshot: user.email },
        action: "USER_DISABLE",
        targetType: "User",
      }),
    );
    const userRow = await app.auditLog.findUniqueOrThrow({ where: { id: userRef.id } });
    expect(userRow).toMatchObject({
      actorId: user.id,
      actorEmailSnapshot: user.email,
      targetId: null,
      detailJson: null,
    });
    for (const systemActor of ["MIGRATION", "SCHEDULER", "MAINTENANCE"] as const) {
      const ref = await runAuditedTransaction((tx) =>
        writeAuditLog(tx, { ...systemInput(), actor: { kind: "SYSTEM", systemActor } }),
      );
      expect(Object.keys(ref).sort()).toEqual(["action", "createdAt", "id"]);
      expect(ref.id).toMatch(/^c[a-z0-9]{24}$/);
      expect(ref.createdAt).toBeInstanceOf(Date);
      expect(await app.auditLog.findUnique({ where: { id: ref.id } })).toMatchObject({
        actorId: null,
        actorEmailSnapshot: null,
        targetId: null,
        requestId: null,
        traceId: null,
        detailJson: { result: "SUCCESS", systemActor },
      });
    }
  });

  it("system-actor: ambiguous identities and spoofed registry/context values insert nothing", async () => {
    const targetId = fixture.id();
    for (const extra of [
      { actor: { kind: "SYSTEM", systemActor: "WORKER_UNREGISTERED" } },
      {
        actor: {
          kind: "SYSTEM",
          systemActor: "SCHEDULER",
          emailSnapshot: "invalid@example.invalid",
        },
      },
      { actor: { kind: "USER", id: "missing" } },
      { action: "ROTATE_API_KEY" },
      { targetType: "User" },
      { context: { ...createAuditContext({ trace: true }) } },
    ]) {
      await expect(
        runAuditedTransaction((tx) =>
          Reflect.apply(writeAuditLog, undefined, [tx, { ...systemInput(targetId), ...extra }]),
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(await app.auditLog.count({ where: { targetId } })).toBe(0);
  });

  it("transaction: successful business writes and audits are paired under concurrency", async () => {
    const config = await fixture.createConfig();
    const context = createAuditContext({ trace: true });
    const refs = await Promise.all(
      Array.from({ length: 12 }, () =>
        runAuditedTransaction(async (tx) => {
          const updated = await tx.systemConfig.update({
            where: { id: config.id },
            data: { revision: { increment: 1 } },
          });
          return writeAuditLog(tx, {
            ...systemInput(config.id),
            context,
            detailJson: { revision: updated.revision, result: "SUCCESS" },
          });
        }),
      ),
    );
    expect(new Set(refs.map(({ id }) => id)).size).toBe(12);
    const row = await app.systemConfig.findUniqueOrThrow({ where: { id: config.id } });
    expect(row.revision).toBe(12);
    expect(
      await app.auditLog.count({ where: { targetId: config.id, requestId: context.requestId } }),
    ).toBe(row.revision);
  });

  it("transaction: audit FK failure rolls back the business write and leaks no driver details", async () => {
    const config = await fixture.createConfig();
    const result = runAuditedTransaction(async (tx) => {
      await tx.systemConfig.update({
        where: { id: config.id },
        data: { revision: { increment: 1 } },
      });
      return writeAuditLog(tx, {
        actor: { kind: "USER", id: "missing-actor", emailSnapshot: "missing@example.invalid" },
        action: "CONFIG_UPDATE",
        targetType: "SystemConfig",
        targetId: config.id,
      });
    });
    await expect(result).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Audit write failed.",
    });
    expect((await app.systemConfig.findUniqueOrThrow({ where: { id: config.id } })).revision).toBe(
      0,
    );
    expect(await app.auditLog.count({ where: { targetId: config.id } })).toBe(0);
  });

  it("transaction: business failure after audit and sanitizer failure after business both roll back", async () => {
    const config = await fixture.createConfig();
    for (const businessFails of [true, false]) {
      const failed = await rejectsOperation(() =>
        runAuditedTransaction(async (tx) => {
          await tx.systemConfig.update({
            where: { id: config.id },
            data: { revision: { increment: 1 } },
          });
          await writeAuditLog(tx, {
            ...systemInput(config.id),
            detailJson: businessFails
              ? { result: "SUCCESS" }
              : { message: sensitiveCanary("exception") },
          });
          if (businessFails)
            await tx.systemConfig.create({
              data: {
                key: config.key,
                description: "Synthetic duplicate",
                group: "GENERAL",
                valueJson: {},
              },
            });
        }),
      );
      expect(failed).toBe(true);
      expect(
        (await app.systemConfig.findUniqueOrThrow({ where: { id: config.id } })).revision,
      ).toBe(0);
      expect(await app.auditLog.count({ where: { targetId: config.id } })).toBe(0);
    }
  });

  it("recursive-redaction: persistence contains only recursively sanitized summaries and network hashes", async () => {
    const secret = sensitiveCanary("database");
    const context = createAuditContext({
      trace: true,
      ipAddress: "192.0.2.9",
      hmacKey: new Uint8Array(32).fill(19),
      userAgent: "SyntheticAgent\r\n/1",
    });
    const ref = await runAuditedTransaction((tx) =>
      writeAuditLog(tx, {
        ...systemInput(fixture.id()),
        context,
        detailJson: {
          metadata: {
            items: [{ Api_Key: secret, before: { pAsS_wOrD_hAsH: secret, promptContent: secret } }],
          },
          DATABASE_URL: secret,
        },
      }),
    );
    const row = await app.auditLog.findUniqueOrThrow({ where: { id: ref.id } });
    expect(JSON.stringify(row).includes(secret)).toBe(false);
    expect(JSON.stringify(row).includes("192.0.2.9")).toBe(false);
    expect(row.ipHash).toBe(hashAuditIp("192.0.2.9", new Uint8Array(32).fill(19)));
    expect(row.userAgentSummary).toBe("SyntheticAgent/1");
    expect(row.detailJson).toEqual({
      metadata: {
        items: [{ Api_Key: "***", before: { pAsS_wOrD_hAsH: "***", promptContent: "***" } }],
      },
      DATABASE_URL: "***",
      systemActor: "SCHEDULER",
    });
  });

  it("bounded-metadata: excess detail fails atomically and normalized Unicode UA fits the database", async () => {
    const config = await fixture.createConfig();
    await expect(
      runAuditedTransaction(async (tx) => {
        await tx.systemConfig.update({ where: { id: config.id }, data: { revision: 1 } });
        return writeAuditLog(tx, {
          ...systemInput(config.id),
          detailJson: { secret: "x".repeat(16384) },
        });
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await app.systemConfig.findUniqueOrThrow({ where: { id: config.id } })).revision).toBe(
      0,
    );
    expect(await app.auditLog.count({ where: { targetId: config.id } })).toBe(0);
    const context = createAuditContext({ userAgent: "🧭".repeat(257) });
    const ref = await runAuditedTransaction((tx) =>
      writeAuditLog(tx, { ...systemInput(config.id), context }),
    );
    const row = await app.auditLog.findUniqueOrThrow({ where: { id: ref.id } });
    expect([...(row.userAgentSummary ?? "")]).toHaveLength(256);
    const [length] = await app.$queryRaw<
      Array<{ count: number }>
    >`SELECT length("userAgentSummary") AS count FROM "AuditLog" WHERE id=${ref.id}`;
    expect(length.count).toBe(256);
  });

  it("bounded-metadata: malformed write fields are rejected before the database delegate", async () => {
    const targetId = fixture.id();
    const base = systemInput(targetId);
    for (const input of [
      { ...base, action: "A".repeat(65) },
      { ...base, action: "UPDATE_CONFIG" },
      { ...base, targetType: "T".repeat(65) },
      { ...base, targetType: "User" },
      { ...base, targetId: "x".repeat(129) },
      { ...base, targetId: "has a space" },
      { ...base, actor: { kind: "USER", id: "user", emailSnapshot: "x".repeat(255) } },
      { ...base, actor: { kind: "USER", id: "user", emailSnapshot: "UPPER@example.invalid" } },
      {
        ...base,
        actor: {
          kind: "USER",
          id: "user",
          emailSnapshot: "user@example.invalid",
          systemActor: "SCHEDULER",
        },
      },
      { ...base, actor: { kind: "SYSTEM", systemActor: "UNREGISTERED" } },
      { ...base, actor: { kind: "SYSTEM", systemActor: "SCHEDULER", id: "user" } },
      { ...base, detailJson: { systemActor: "SCHEDULER" } },
      { ...base, requestId: "inbound" },
      { ...base, traceId: "inbound" },
      { ...base, context: { requestId: "x".repeat(37), traceId: null } },
      { ...base, ipHash: "192.0.2.9" },
      { ...base, actorEmailSnapshot: "user@example.invalid" },
    ]) {
      await expect(
        runAuditedTransaction((tx) => Reflect.apply(writeAuditLog, undefined, [tx, input])),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    }
    expect(await app.auditLog.count({ where: { targetId } })).toBe(0);
  });

  it("lookup: exact request trace target actor queries and EXPLAIN use all five indexes", async () => {
    const user = await fixture.createUser();
    const context = createAuditContext({ trace: true });
    const targetId = fixture.id();
    const ref = await runAuditedTransaction((tx) =>
      writeAuditLog(tx, {
        actor: { kind: "USER", id: user.id, emailSnapshot: user.email },
        action: "USER_DISABLE",
        targetType: "User",
        targetId,
        context,
      }),
    );
    for (const where of [
      { requestId: context.requestId },
      { traceId: context.traceId },
      { targetType: "User", targetId },
      { actorId: user.id },
    ])
      expect((await app.auditLog.findMany({ where })).map(({ id }) => id)).toEqual([ref.id]);
    const plans = await app.$transaction(async (tx) => {
      // This proves usable access paths without pretending a small fixture is a latency benchmark.
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return [
        await tx.$queryRaw`EXPLAIN (FORMAT JSON) SELECT * FROM "AuditLog" WHERE "requestId"=${context.requestId}`,
        await tx.$queryRaw`EXPLAIN (FORMAT JSON) SELECT * FROM "AuditLog" WHERE "traceId"=${context.traceId}`,
        await tx.$queryRaw`EXPLAIN (FORMAT JSON) SELECT * FROM "AuditLog" WHERE "targetType"='User' AND "targetId"=${targetId} ORDER BY "createdAt"`,
        await tx.$queryRaw`EXPLAIN (FORMAT JSON) SELECT * FROM "AuditLog" WHERE "actorId"=${user.id} ORDER BY "createdAt"`,
        await tx.$queryRaw`EXPLAIN (FORMAT JSON) SELECT * FROM "AuditLog" WHERE action='USER_DISABLE' ORDER BY "createdAt"`,
      ];
    });
    expect([...new Set(plans.flatMap(indexNames))].sort()).toEqual(AUDIT_INDEXES);
  });

  it("lookup: empty reads differ from an actual unavailable database", async () => {
    expect(await app.auditLog.findMany({ where: { targetId: fixture.id() } })).toEqual([]);
    const url = new URL(runtimeUrl ?? "");
    url.port = "1";
    url.searchParams.set("connect_timeout", "1");
    const unavailable = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
    try {
      const { connectDb, DatabaseUnavailableError } = await import("@/server/db");
      await expect(connectDb(unavailable)).rejects.toBeInstanceOf(DatabaseUnavailableError);
      expect(
        await rejectsOperation(() =>
          unavailable.auditLog.findMany({ where: { targetId: fixture.id() } }),
        ),
      ).toBe(true);
    } finally {
      await unavailable.$disconnect();
    }
  });
});
