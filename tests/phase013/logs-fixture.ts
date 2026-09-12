import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { Prisma } from "@prisma/client";
import { env } from "@/lib/env";
import { createAuditContext } from "@/server/audit-log";
import { authCookieSettings, encodeAuthCookie } from "@/server/auth/cookie";
import { createKeyResolver, encryptSecret } from "@/server/security/secret-envelope";
import {
  openAuditedAdminDatabase,
  writeAuditLog,
  type AuditLogInput,
  type AuditLogRef,
} from "@/server/services/audit-log-service";
import {
  issueSession,
  registerCanary,
  startApiKeyWorker,
  withApiKeyDatabase,
  type ApiKeyFixture,
} from "./api-key-fixture";

export type LogsSession = Awaited<ReturnType<typeof issueSession>>;
export type LogsWorker = Awaited<ReturnType<typeof startApiKeyWorker>>;
export type LogsResponse = Awaited<ReturnType<LogsWorker["request"]>>;

export interface LogsHarness {
  fixture: ApiKeyFixture;
  actor: LogsSession;
  worker: LogsWorker;
}

export async function withLogsTransport(operation: (harness: LogsHarness) => Promise<void>) {
  return withApiKeyDatabase(async (fixture) => {
    const actor = await issueSession(fixture, fixture.seed.userId);
    const worker = await startApiKeyWorker(fixture);
    try {
      await operation({ fixture, actor, worker });
    } finally {
      await worker.close();
    }
  });
}

/** Real helper writes; an optional owned fixture clock makes timestamp ties deterministic. */
export async function appendAudits(
  fixture: ApiKeyFixture,
  inputs: readonly AuditLogInput[],
  options: { at?: Date } = {},
): Promise<AuditLogRef[]> {
  const database = openAuditedAdminDatabase(fixture.url);
  let clockInstalled = false;
  try {
    if (options.at) {
      assert(options.at instanceof Date && Number.isFinite(options.at.getTime()));
      await fixture.admin.$executeRawUnsafe(
        `CREATE FUNCTION public.phase013_fixture_audit_time() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW."createdAt" := '${options.at.toISOString()}'::timestamptz; RETURN NEW; END; $$`,
      );
      await fixture.admin.$executeRawUnsafe(
        'CREATE TRIGGER phase013_fixture_audit_time BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION public.phase013_fixture_audit_time()',
      );
      clockInstalled = true;
    }
    const records = await database.transaction(async (tx) => {
      const result: AuditLogRef[] = [];
      for (const input of inputs) result.push(await writeAuditLog(tx, input));
      return result;
    });
    await fixture.setClock(
      new Date(Math.max(Date.now(), ...records.map((row) => row.createdAt.getTime())) + 1),
    );
    return records;
  } finally {
    await database.disconnect();
    if (clockInstalled) {
      await fixture.admin.$executeRawUnsafe(
        'DROP TRIGGER phase013_fixture_audit_time ON "AuditLog"',
      );
      await fixture.admin.$executeRawUnsafe("DROP FUNCTION public.phase013_fixture_audit_time()");
    }
  }
}

export function adminAudit(
  fixture: ApiKeyFixture,
  targetId: string,
  detailJson: unknown = { result: "SUCCESS", reasonCode: "KEY_CREATED" },
): AuditLogInput {
  return {
    actor: { kind: "USER", id: fixture.seed.userId, emailSnapshot: fixture.seed.email },
    action: "API_KEY_CREATE",
    targetType: "ApiKeyConfig",
    targetId,
    context: createAuditContext({ trace: true }),
    detailJson,
  };
}

/** Owner-only legacy/fault fixture: deliberately bypass the helper, never the actual read service. */
export async function insertLegacyAudit(
  fixture: ApiKeyFixture,
  options: { targetId: string; detailJson: Prisma.InputJsonValue; createdAt?: Date },
) {
  const context = createAuditContext({ trace: true });
  const row = await fixture.admin.auditLog.create({
    data: {
      id: `audit-fixture-${randomUUID()}`,
      actorId: fixture.seed.userId,
      actorEmailSnapshot: fixture.seed.email,
      action: "API_KEY_CREATE",
      targetType: "ApiKeyConfig",
      targetId: options.targetId,
      requestId: context.requestId,
      traceId: context.traceId,
      detailJson: options.detailJson,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    },
    select: { id: true, createdAt: true },
  });
  await fixture.setClock(new Date(Math.max(Date.now(), row.createdAt.getTime()) + 1));
  return row;
}

/** Values stay in task-owned canaries; assertions compare booleans so reports cannot echo them. */
export function logSecrets() {
  const master = randomBytes(32).toString("base64");
  const plainKey = `fixture-only::${randomBytes(24).toString("hex")}`;
  const row = encryptSecret(
    { id: `log-secret-${randomUUID()}`, provider: "synthetic-logs", plainKey },
    createKeyResolver(master),
  );
  const ciphertext = String((JSON.parse(row.encryptedKey) as { ciphertext: string }).ciphertext);
  const secretHash = createHash("sha256").update(randomBytes(32)).digest("hex");
  const values = {
    plainKey,
    master,
    encryptedKey: row.encryptedKey,
    ciphertext,
    keyFingerprint: row.keyFingerprint,
    secretHash,
  };
  registerCanary(values);
  return values;
}

export function containsNoSecrets(
  value: unknown,
  secrets: Readonly<Record<string, string>>,
): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Object.values(secrets).every((secret) => !text.includes(secret));
}

export async function logSnapshot(fixture: ApiKeyFixture): Promise<string> {
  const rows = await fixture.admin.$queryRaw<Array<{ relation: string; digest: string }>>`
    SELECT 'User' AS relation,encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') AS digest FROM "User" t
    UNION ALL SELECT 'AuthSession',encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') FROM "AuthSession" t
    UNION ALL SELECT 'AuditLog',encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') FROM "AuditLog" t
    UNION ALL SELECT 'ApiKeyConfig',encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') FROM "ApiKeyConfig" t
    UNION ALL SELECT 'AdminCommandReceipt',encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') FROM "AdminCommandReceipt" t
    UNION ALL SELECT 'KeyRotationRun',encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') FROM "KeyRotationRun" t ORDER BY 1,2
  `;
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/** Direct-service races still use a real Auth.js cookie and a current PostgreSQL session. */
export async function directLogsRequest(
  session: LogsSession,
  query = "limit=100",
): Promise<Request> {
  const name = authCookieSettings().sessionToken.name;
  const value = await encodeAuthCookie({
    token: {
      opaqueToken: session.opaqueToken,
      absoluteExpiresAt: new Date(session.expiresAt).getTime(),
    },
    secret: env.AUTH_SECRET,
    salt: name,
  });
  registerCanary({ cookie: value });
  return new Request(new URL(`/api/admin/logs?${query}`, env.AUTH_URL), {
    headers: { cookie: `${name}=${encodeURIComponent(value)}` },
  });
}

/** Finish a real revocation before the selected query event releases the awaiting service. */
export function revokeDuringRead(fixture: ApiKeyFixture, session: LogsSession): boolean {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { PrismaClient } from '@prisma/client';
    const client = new PrismaClient({ datasourceUrl: process.env.PHASE013_RACE_DATABASE_URL, log: [] });
    try {
      const [{ now }] = await client.$queryRawUnsafe('SELECT public.auth_now() AS now');
      const result = await client.authSession.updateMany({
        where: { tokenHash: process.env.PHASE013_RACE_TOKEN_HASH, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: now },
      });
      process.exitCode = result.count === 1 ? 0 : 3;
    } catch { process.exitCode = 4; }
    finally { await client.$disconnect(); }
  `,
    ],
    {
      cwd: process.cwd(),
      windowsHide: true,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        PHASE013_RACE_DATABASE_URL: fixture.ownerUrl,
        PHASE013_RACE_TOKEN_HASH: createHash("sha256").update(session.opaqueToken).digest("hex"),
      },
    },
  );
  assert(
    containsNoSecrets(`${result.stdout ?? ""}${result.stderr ?? ""}`, {
      databaseUrl: fixture.ownerUrl,
      opaqueToken: session.opaqueToken,
    }),
    "Race subprocess emitted unsafe diagnostics",
  );
  return result.status === 0 && result.stdout === "" && result.stderr === "";
}
