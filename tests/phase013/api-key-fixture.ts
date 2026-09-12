import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { PrismaClient, type Role, type UserStatus } from "@prisma/client";
import { createKeyResolver, type KeyResolver } from "@/server/security/secret-envelope";
import { env } from "@/lib/env";
import { stableStringify } from "@/lib/json";
import { authCookieSettings, encodeAuthCookie } from "@/server/auth/cookie";
import { createKeyCandidateClient } from "@/server/admin/key-candidate-client";
import {
  KeyLifecycleError,
  type KeyConnectionTarget,
  type KeyReference,
  type KeyReferenceAdapter,
  type KeyReferenceCandidate,
} from "@/server/admin/key-reference";

export interface ApiKeyFixtureConfig {
  phase: "012" | "013" | "014";
  runId: string;
  database: string;
  user: string;
  appUser: string;
  password: string;
  appPassword: string;
  url: string;
  appUrl: string;
  authSecret: string;
  encryptionKey: string;
}

export function fixtureConfig(): ApiKeyFixtureConfig {
  const file = process.env.PHASE013_FIXTURE_CONFIG;
  assert(file, "Phase013 requires its task-owned database configuration");
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as ApiKeyFixtureConfig;
  assert.match(config.runId, /^[a-f0-9]{12}$/);
  const match = /^phase(012|013|014)_disposable_([a-f0-9]{12})$/.exec(config.database);
  assert(match, "Admin regression requires an owned Phase013 or Phase013 database");
  const phase = match[1] as ApiKeyFixtureConfig["phase"];
  assert.equal(config.database, `phase${phase}_disposable_${config.runId}`);
  assert.equal(config.user, `phase${phase}_runner`);
  assert.equal(config.appUser, `phase${phase}_app`);
  config.phase = phase;
  for (const [value, role] of [
    [config.url, config.user],
    [config.appUrl, config.appUser],
  ]) {
    const url = new URL(value);
    assert.equal(url.protocol, "postgresql:");
    assert.equal(url.hostname, "127.0.0.1");
    assert(url.port);
    assert.equal(url.pathname, `/${config.database}`);
    assert.equal(url.username, role);
  }
  assert(config.authSecret.length >= 32);
  assert.equal(Buffer.from(config.encryptionKey, "base64").length, 32);
  return config;
}

export function registerCanary(values: Record<string, string>): void {
  const file = process.env.PHASE013_FIXTURE_CONFIG;
  assert(file);
  fs.appendFileSync(
    path.join(path.dirname(file), "api-key-canaries.jsonl"),
    `${JSON.stringify(values)}\n`,
  );
}

/** IPC response data is private test input; only stdout/stderr may become diagnostics. */
function scanDiagnostics(value: string): void {
  const config = fixtureConfig();
  const secrets = [config.password, config.appPassword, config.authSecret, config.encryptionKey];
  const file = path.join(
    path.dirname(process.env.PHASE013_FIXTURE_CONFIG!),
    "api-key-canaries.jsonl",
  );
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean))
      secrets.push(...Object.values(JSON.parse(line) as Record<string, string>));
  }
  assert(!secrets.some((secret) => secret && value.includes(secret)), "SECRET_SCAN_REJECTED");
  assert(!/postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@/i.test(value), "SECRET_SCAN_REJECTED");
}

export async function runAdminCommand(
  args: string[],
  options: {
    env?: Partial<NodeJS.ProcessEnv>;
    cwd?: string;
    stdin?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        CHECKPOINT_DISABLE: "1",
        NEXT_TELEMETRY_DISABLED: "1",
        ...options.env,
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Admin fixture command timed out"));
    }, options.timeoutMs ?? 90_000);
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? "");
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      try {
        scanDiagnostics(stdout);
        scanDiagnostics(stderr);
        resolve({ exitCode, stdout, stderr });
      } catch {
        reject(new Error("SECRET_SCAN_REJECTED"));
      }
    });
  });
}

export interface ApiKeyFixture {
  config: ApiKeyFixtureConfig;
  database: string;
  url: string;
  ownerUrl: string;
  admin: PrismaClient;
  app: PrismaClient;
  clock: Date;
  resolver: KeyResolver;
  seed: { email: string; password: string; userId: string };
  setClock(value: Date): Promise<void>;
}

/** A fresh marked PG17 database, the real migration history and the real base seed per test. */
export async function withApiKeyDatabase<T>(
  operation: (fixture: ApiKeyFixture) => Promise<T>,
): Promise<T> {
  const config = fixtureConfig();
  const database = `${config.database}_u${randomBytes(5).toString("hex")}`;
  assert.match(database, /^phase(?:012|013|014)_disposable_[a-f0-9]{12}_u[a-f0-9]{10}$/);
  const control = new PrismaClient({ datasourceUrl: config.url, log: [] });
  const [identity] = await control.$queryRaw<
    Array<{ name: string; version: string; marker: string }>
  >`
    SELECT current_database() AS name,current_setting('server_version') AS version,
    shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()
  `;
  assert.equal(identity.name, config.database);
  assert.equal(identity.marker, `serendipity-phase${config.phase}-disposable:${config.runId}`);
  assert.match(identity.version, /^17\./);
  await control.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
  const owner = new URL(config.url),
    runtime = new URL(config.appUrl);
  owner.pathname = runtime.pathname = `/${database}`;
  runtime.searchParams.set("connection_limit", "5");
  const ownerUrl = owner.toString(),
    url = runtime.toString();
  const admin = new PrismaClient({ datasourceUrl: ownerUrl, log: [] });
  const app = new PrismaClient({ datasourceUrl: url, log: [] });
  try {
    await control.$executeRawUnsafe(
      `COMMENT ON DATABASE "${database}" IS 'serendipity-phase${config.phase}-disposable:${config.runId}'`,
    );
    const migration = await runAdminCommand(
      [path.resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"],
      { env: { DATABASE_URL: ownerUrl } },
    );
    assert.equal(migration.exitCode, 0, "Admin fixture migration failed");
    for (const statement of [
      "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
      "GRANT USAGE ON SCHEMA public TO phase013_app",
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "User", "SystemConfig", "TravelRecord", "ChatMessage", "ApiKeyConfig" TO phase013_app',
      'GRANT SELECT, INSERT ON TABLE "AuditLog", "AuthSession", "AuthLoginAttempt" TO phase013_app',
      'GRANT UPDATE (status,"lastSeenAt","revokedAt") ON "AuthSession" TO phase013_app',
      'GRANT UPDATE (status,"completedAt") ON "AuthLoginAttempt" TO phase013_app',
      'GRANT SELECT, INSERT, UPDATE ON TABLE "AdminCommandReceipt", "KeyRotationRun" TO phase013_app',
      'GRANT SELECT ON "_prisma_migrations" TO phase013_app',
      "GRANT EXECUTE ON FUNCTION public.auth_now() TO phase013_app",
    ])
      await admin.$executeRawUnsafe(statement.replaceAll("phase013_app", config.appUser));
    const [role] = await app.$queryRaw<
      Array<{
        superuser: boolean;
        owner: boolean;
        createDb: boolean;
        deleteAudit: boolean;
        deleteSession: boolean;
      }>
    >`
      SELECT r.rolsuper AS superuser,(d.datdba=r.oid) AS owner,r.rolcreatedb AS "createDb",
        has_table_privilege(current_user,'"AuditLog"','DELETE') AS "deleteAudit",
        has_table_privilege(current_user,'"AuthSession"','DELETE') AS "deleteSession"
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user
    `;
    assert.deepEqual(role, {
      superuser: false,
      owner: false,
      createDb: false,
      deleteAudit: false,
      deleteSession: false,
    });
    const email = `admin-${randomBytes(8).toString("hex")}@example.invalid`;
    const password = `${randomBytes(24).toString("base64url")}Aa1!`;
    registerCanary({ email, password });
    const seeded = await runAdminCommand(
      ["--conditions=react-server", "--import", "tsx", "prisma/seed.ts"],
      {
        env: {
          NODE_ENV: "test",
          DATABASE_URL: url,
          ADMIN_EMAIL: email,
          ADMIN_INITIAL_PASSWORD: password,
        },
      },
    );
    assert.equal(seeded.exitCode, 0, "The real base seed must create the fixture administrator");
    const user = await app.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    const clock = new Date();
    const setClock = async (value: Date) => {
      assert(value instanceof Date && Number.isFinite(value.getTime()));
      await admin.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION public.auth_now() RETURNS TIMESTAMPTZ LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT '${value.toISOString()}'::timestamptz; $$`,
      );
    };
    await setClock(clock);
    return await operation({
      config,
      database,
      ownerUrl,
      url,
      admin,
      app,
      clock,
      resolver: createKeyResolver(config.encryptionKey),
      seed: { email, password, userId: user.id },
      setClock,
    });
  } finally {
    await app.$disconnect();
    await admin.$disconnect();
    // Only this exact random database created after checking the run marker is removed.
    await control.$executeRawUnsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
    await control.$disconnect();
  }
}

export async function createSubject(
  fixture: ApiKeyFixture,
  options: {
    id?: string;
    role?: Role;
    status?: UserStatus;
    createdAt?: Date;
    revision?: number;
  } = {},
) {
  const seed = await fixture.admin.user.findUniqueOrThrow({
    where: { id: fixture.seed.userId },
    select: { passwordHash: true },
  });
  const email = `subject-${randomBytes(8).toString("hex")}@example.invalid`;
  const phone = `synthetic-phone-${randomBytes(12).toString("hex")}`;
  registerCanary({ email, phone, passwordHash: seed.passwordHash });
  return fixture.admin.user.create({
    data: {
      createdAt: fixture.clock,
      ...options,
      email,
      phone,
      name: "合成用户",
      passwordHash: seed.passwordHash,
    },
  });
}

export interface FixtureSession {
  opaqueToken: string;
  userId: string;
  audience: "ADMIN" | "USER";
  expiresAt: string;
}

/** Fixtures issue real token-hash rows; the product still verifies the JWE and live database state. */
export async function issueSession(
  fixture: ApiKeyFixture,
  userId: string,
  audience: "ADMIN" | "USER" = "ADMIN",
  version?: number,
): Promise<FixtureSession> {
  const user = await fixture.admin.user.findUniqueOrThrow({
    where: { id: userId },
    select: { sessionVersion: true },
  });
  const [{ now }] = await fixture.admin.$queryRaw<
    Array<{ now: Date }>
  >`SELECT public.auth_now() AS now`;
  const opaqueToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + 43_200_000);
  registerCanary({ opaqueToken });
  await fixture.app.authSession.create({
    data: {
      userId,
      tokenHash: createHash("sha256").update(opaqueToken).digest("hex"),
      audience,
      sessionVersion: version ?? user.sessionVersion,
      issuedAt: now,
      createdAt: now,
      expiresAt,
    },
  });
  return { opaqueToken, userId, audience, expiresAt: expiresAt.toISOString() };
}

export interface WorkerRequest {
  mode?: "route" | "observed-list" | "observed-logs";
  method: "GET" | "POST" | "PATCH";
  path?: string;
  session?: FixtureSession;
  csrf?: "missing" | "mismatch";
  origin?: string;
  idempotencyKey?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}
export interface WorkerResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  queries?: string[];
}
export interface ApiKeyWorker {
  request(input: WorkerRequest): Promise<WorkerResponse>;
  close(): Promise<void>;
}

/** Persistent real Route Handler process; it can be stopped/restarted while PG receipts survive. */
export async function startApiKeyWorker(
  fixture: ApiKeyFixture,
  workerPath:
    | "tests/phase013/api-key-worker.ts"
    | "tests/phase014/worker.ts" = "tests/phase013/api-key-worker.ts",
): Promise<ApiKeyWorker> {
  const child = spawn(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", workerPath],
    {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: fixture.url,
        AUTH_SECRET: fixture.config.authSecret,
        AUTH_URL: "http://127.0.0.1:3000",
        AUTH_TRUSTED_PROXY_CIDRS: "",
        NEXT_TELEMETRY_DISABLED: "1",
        CHECKPOINT_DISABLE: "1",
        ENCRYPTION_KEY: fixture.config.encryptionKey,
        AI_API_KEY: "",
        AI_BASE_URL: "https://provider.invalid",
        AI_MODEL: "synthetic-phase013",
        AI_MOCK: "true",
        AI_TIMEOUT_MS: "60000",
        AI_DAILY_COST_LIMIT: "5",
      },
    },
  );
  let stdout = "",
    stderr = "",
    sequence = 0,
    closed = false;
  child.stdout!.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr!.on("data", (chunk) => (stderr += chunk.toString()));
  const pending = new Map<
    number,
    { resolve(value: WorkerResponse): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const readyTimer = setTimeout(() => {
    child.kill();
    readyReject(new Error("Admin worker startup timed out"));
  }, 30_000);
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", () => {
      clearTimeout(readyTimer);
      readyReject(new Error("Admin worker could not start"));
      reject(new Error("Admin worker could not start"));
    });
    child.once("close", (code) => {
      clearTimeout(readyTimer);
      closed = true;
      const failure = new Error("Admin worker exited before completing a request");
      readyReject(failure);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(failure);
      }
      pending.clear();
      try {
        scanDiagnostics(stdout);
        scanDiagnostics(stderr);
        assert.equal(code, 0, "Admin worker failed");
        resolve();
      } catch {
        reject(new Error("Admin worker failed or emitted unsafe diagnostics"));
      }
    });
  });
  // Request failures surface at their own awaited boundary, including startup failures.
  void done.catch(() => {});
  child.on(
    "message",
    (message: { type: string; id?: number; response?: WorkerResponse; errorName?: string }) => {
      if (message.type === "ready") {
        clearTimeout(readyTimer);
        readyResolve();
        return;
      }
      const entry = message.id === undefined ? undefined : pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(message.id!);
      if (message.type === "response" && message.response) entry.resolve(message.response);
      else
        entry.reject(
          new Error(`Admin worker rejected request: ${message.errorName ?? "UnknownError"}`),
        );
    },
  );
  await ready;
  return {
    request(input) {
      assert(!closed, "Admin worker is closed");
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Admin worker request timed out"));
        }, 30_000);
        pending.set(id, { resolve, reject, timer });
        child.send({ type: "request", id, input }, (error) => {
          if (error) {
            clearTimeout(timer);
            pending.delete(id);
            reject(new Error("Admin worker IPC failed"));
          }
        });
      });
    },
    async close() {
      if (!closed && child.connected) child.send({ type: "shutdown" });
      const timer = setTimeout(() => child.kill(), 10_000);
      try {
        await done;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Direct service tests use the test process's real Auth.js cookie configuration. */
export async function makeApiKeyRequest(input: WorkerRequest): Promise<Request> {
  const settings = authCookieSettings(),
    csrf = randomBytes(32).toString("hex"),
    cookies: string[] = [];
  if (input.session)
    cookies.push(
      `${settings.sessionToken.name}=${await encodeAuthCookie({ token: { opaqueToken: input.session.opaqueToken, absoluteExpiresAt: new Date(input.session.expiresAt).getTime() }, secret: env.AUTH_SECRET, salt: settings.sessionToken.name })}`,
    );
  const headers = new Headers({
    origin: input.origin ?? env.AUTH_URL,
    "sec-fetch-site": "same-origin",
  });
  if (input.csrf !== "missing") {
    const hash = createHash("sha256").update(`${csrf}${env.AUTH_SECRET}`).digest("hex");
    cookies.push(`${settings.csrfToken.name}=${csrf}%7C${hash}`);
    headers.set("x-csrf-token", input.csrf === "mismatch" ? randomBytes(32).toString("hex") : csrf);
  }
  if (cookies.length) headers.set("cookie", cookies.join("; "));
  if (input.idempotencyKey !== undefined) headers.set("Idempotency-Key", input.idempotencyKey);
  if (input.body !== undefined) headers.set("content-type", "application/json");
  return new Request(new URL(input.path ?? "/api/admin/api-keys", env.AUTH_URL), {
    method: input.method,
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
}

interface ReferenceVersion {
  id: string;
  referenceId: string;
  version: number;
  secretRef: string;
  contentHash: string;
  endpoint: string;
}

/** Only a disposable test schema has these contract rows. The product schema has no Provider tables. */
export async function createReferenceFixture(fixture: ApiKeyFixture, oldKeyId: string) {
  const adapterId = "fixture-references",
    requests: Array<{
      candidateId: string;
      credentialAccepted: boolean;
      transactionOpen: boolean;
    }> = [];
  const accepted = new Set<string>();
  const controls: {
    failReference?: string;
    tamper?: boolean;
    redirect?: boolean;
    oversize?: boolean;
    beforeResponse?: () => Promise<void>;
  } = {};
  const server = createServer((request, response) => {
    void (async () => {
      const candidateId = (request.url ?? "").split("/").at(-1) ?? "";
      const versions = await fixture.admin.$queryRaw<ReferenceVersion[]>`
        SELECT id,reference_id AS "referenceId",version,secret_ref AS "secretRef",content_hash AS "contentHash",endpoint
        FROM phase013_fixture.versions WHERE id=${candidateId}
      `;
      const row = versions[0];
      const credentialAccepted = accepted.has(
        (request.headers.authorization ?? "").replace(/^Bearer /, ""),
      );
      const [{ count }] = await fixture.admin.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename=${fixture.config.appUser} AND state='idle in transaction'
      `;
      requests.push({ candidateId, credentialAccepted, transactionOpen: count !== BigInt(0) });
      if (controls.beforeResponse) await controls.beforeResponse();
      if (controls.redirect) {
        response.writeHead(302, { location: "http://127.0.0.1:1/private" });
        response.end();
        return;
      }
      if (!row || !credentialAccepted || row.referenceId === controls.failReference) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end('{"ok":false}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      if (controls.oversize) {
        response.end(JSON.stringify({ data: "x".repeat(9_000) }));
        return;
      }
      response.end(
        JSON.stringify({
          ok: true,
          candidateId: row.id,
          configVersion: controls.tamper ? row.version + 1 : row.version,
          contentHash: row.contentHash,
        }),
      );
    })().catch(() => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"ok":false}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const sql of [
      "CREATE SCHEMA phase013_fixture",
      'CREATE TABLE phase013_fixture.versions (id TEXT PRIMARY KEY, reference_id TEXT NOT NULL, version INTEGER NOT NULL, secret_ref TEXT NOT NULL REFERENCES public."ApiKeyConfig"(id) ON DELETE RESTRICT, content_hash CHAR(64) NOT NULL, endpoint TEXT NOT NULL, UNIQUE(reference_id,version))',
      "CREATE TABLE phase013_fixture.activations (id TEXT PRIMARY KEY, config_id TEXT NOT NULL REFERENCES phase013_fixture.versions(id), revision INTEGER NOT NULL DEFAULT 0)",
      "CREATE FUNCTION phase013_fixture.immutable_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic immutable configuration'; END; $$",
      "CREATE TRIGGER immutable_version BEFORE UPDATE OR DELETE ON phase013_fixture.versions FOR EACH ROW EXECUTE FUNCTION phase013_fixture.immutable_version()",
      "GRANT USAGE ON SCHEMA phase013_fixture TO phase013_app",
      "GRANT SELECT,INSERT ON phase013_fixture.versions TO phase013_app",
      "GRANT SELECT,INSERT,UPDATE ON phase013_fixture.activations TO phase013_app",
    ])
      await fixture.admin.$executeRawUnsafe(sql.replaceAll("phase013_app", fixture.config.appUser));
    const addReference = async (id: string, keyId = oldKeyId) => {
      assert.match(id, /^[A-Za-z0-9_-]{1,128}$/);
      const versionId = `cfg_${randomUUID()}`,
        endpoint = `${origin}/candidate/${versionId}`;
      const contentHash = createHash("sha256")
        .update(stableStringify({ id, version: 1, keyId, endpoint }))
        .digest("hex");
      await fixture.admin
        .$executeRaw`INSERT INTO phase013_fixture.versions(id,reference_id,version,secret_ref,content_hash,endpoint) VALUES(${versionId},${id},1,${keyId},${contentHash},${endpoint})`;
      await fixture.admin
        .$executeRaw`INSERT INTO phase013_fixture.activations(id,config_id,revision) VALUES(${id},${versionId},0)`;
    };
    await addReference("reference-a");
    await addReference("reference-b");
    const adapter: KeyReferenceAdapter = {
      id: adapterId,
      async listActiveReferences(tx, keyId) {
        const rows = await tx.$queryRaw<
          Array<{
            referenceId: string;
            revision: number;
            configVersion: number;
            contentHash: string;
          }>
        >`
          SELECT a.id AS "referenceId",a.revision,v.version AS "configVersion",v.content_hash AS "contentHash"
          FROM phase013_fixture.activations a JOIN phase013_fixture.versions v ON v.id=a.config_id WHERE v.secret_ref=${keyId} ORDER BY a.id
        `;
        return rows.map((row) => ({ adapterId, ...row }));
      },
      async prepareCandidates(tx, references, newKeyId) {
        const candidates: KeyReferenceCandidate[] = [];
        for (const reference of references) {
          const [{ maximum }] = await tx.$queryRaw<
            Array<{ maximum: number }>
          >`SELECT max(version) AS maximum FROM phase013_fixture.versions WHERE reference_id=${reference.referenceId}`;
          const candidateId = `cfg_${randomUUID()}`,
            configVersion = maximum + 1,
            endpoint = `${origin}/candidate/${candidateId}`;
          const contentHash = createHash("sha256")
            .update(
              stableStringify({
                id: reference.referenceId,
                version: configVersion,
                keyId: newKeyId,
                endpoint,
              }),
            )
            .digest("hex");
          await tx.$executeRaw`INSERT INTO phase013_fixture.versions(id,reference_id,version,secret_ref,content_hash,endpoint) VALUES(${candidateId},${reference.referenceId},${configVersion},${newKeyId},${contentHash},${endpoint})`;
          candidates.push({
            adapterId,
            referenceId: reference.referenceId,
            candidateId,
            configVersion,
            referenceRevision: reference.revision,
            contentHash,
          });
        }
        return candidates;
      },
      async connectionTarget(tx, candidate, newKeyId): Promise<KeyConnectionTarget> {
        const rows = await tx.$queryRaw<
          ReferenceVersion[]
        >`SELECT id,reference_id AS "referenceId",version,secret_ref AS "secretRef",content_hash AS "contentHash",endpoint FROM phase013_fixture.versions WHERE id=${candidate.candidateId}`;
        const row = rows[0];
        if (
          !row ||
          row.referenceId !== candidate.referenceId ||
          row.version !== candidate.configVersion ||
          row.secretRef !== newKeyId ||
          row.contentHash !== candidate.contentHash
        )
          throw new KeyLifecycleError(409, "VERSION_CONFLICT");
        return { url: row.endpoint, keyId: row.secretRef, candidate };
      },
      async activate(tx, reference: KeyReference, candidate, newKeyId) {
        await adapter.connectionTarget(tx, candidate, newKeyId);
        const count = await tx.$executeRaw`
          UPDATE phase013_fixture.activations a SET config_id=${candidate.candidateId},revision=a.revision+1
          FROM phase013_fixture.versions v WHERE a.id=${reference.referenceId} AND a.revision=${reference.revision}
            AND v.id=a.config_id AND v.version=${reference.configVersion} AND v.content_hash=${reference.contentHash}
        `;
        if (count !== 1) throw new KeyLifecycleError(409, "VERSION_CONFLICT");
      },
    };
    return {
      adapter,
      client: createKeyCandidateClient({
        mode: "ISOLATED_SYNTHETIC",
        inventory: [{ origin, pathPrefix: "/candidate/" }],
      }),
      controls,
      requests,
      origin,
      addReference,
      acceptSecret(value: string) {
        accepted.add(value);
        registerCanary({ providerCredential: value });
      },
      async active() {
        return fixture.admin.$queryRaw<
          Array<{ id: string; revision: number; secretRef: string; version: number }>
        >`SELECT a.id,a.revision,v.secret_ref AS "secretRef",v.version FROM phase013_fixture.activations a JOIN phase013_fixture.versions v ON v.id=a.config_id ORDER BY a.id`;
      },
      async activeTargets(): Promise<KeyConnectionTarget[]> {
        const rows = await fixture.admin.$queryRaw<Array<ReferenceVersion & { revision: number }>>`
          SELECT v.id,a.id AS "referenceId",a.revision,v.version,v.secret_ref AS "secretRef",v.content_hash AS "contentHash",v.endpoint
          FROM phase013_fixture.activations a JOIN phase013_fixture.versions v ON v.id=a.config_id ORDER BY a.id
        `;
        return rows.map((row) => ({
          url: row.endpoint,
          keyId: row.secretRef,
          candidate: {
            adapterId,
            referenceId: row.referenceId,
            candidateId: row.id,
            configVersion: row.version,
            referenceRevision: row.revision,
            contentHash: row.contentHash,
          },
        }));
      },
      async close() {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}
