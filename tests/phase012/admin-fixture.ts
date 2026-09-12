import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { PrismaClient, type Role, type UserStatus } from "@prisma/client";

export interface AdminFixtureConfig {
  runId: string;
  database: string;
  user: string;
  appUser: string;
  password: string;
  appPassword: string;
  url: string;
  appUrl: string;
  authSecret: string;
}

export function fixtureConfig(): AdminFixtureConfig {
  const file = process.env.PHASE012_FIXTURE_CONFIG;
  assert(file, "Phase012 requires its task-owned database configuration");
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as AdminFixtureConfig;
  assert.match(config.runId, /^[a-f0-9]{12}$/);
  assert.equal(config.database, `phase012_disposable_${config.runId}`);
  assert.equal(config.user, "phase012_runner");
  assert.equal(config.appUser, "phase012_app");
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
  return config;
}

export function registerCanary(values: Record<string, string>): void {
  const file = process.env.PHASE012_FIXTURE_CONFIG;
  assert(file);
  fs.appendFileSync(
    path.join(path.dirname(file), "admin-canaries.jsonl"),
    `${JSON.stringify(values)}\n`,
  );
}

/** IPC response data is private test input; only stdout/stderr may become diagnostics. */
function scanDiagnostics(value: string): void {
  const config = fixtureConfig();
  const secrets = [config.password, config.appPassword, config.authSecret];
  const file = path.join(
    path.dirname(process.env.PHASE012_FIXTURE_CONFIG!),
    "admin-canaries.jsonl",
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

export interface AdminFixture {
  config: AdminFixtureConfig;
  database: string;
  url: string;
  ownerUrl: string;
  admin: PrismaClient;
  app: PrismaClient;
  clock: Date;
  seed: { email: string; password: string; userId: string };
  setClock(value: Date): Promise<void>;
}

/** A fresh marked PG17 database, the real migration history and the real base seed per test. */
export async function withAdminDatabase<T>(
  operation: (fixture: AdminFixture) => Promise<T>,
): Promise<T> {
  const config = fixtureConfig();
  const database = `${config.database}_u${randomBytes(5).toString("hex")}`;
  assert.match(database, /^phase012_disposable_[a-f0-9]{12}_u[a-f0-9]{10}$/);
  const control = new PrismaClient({ datasourceUrl: config.url, log: [] });
  const [identity] = await control.$queryRaw<
    Array<{ name: string; version: string; marker: string }>
  >`
    SELECT current_database() AS name,current_setting('server_version') AS version,
    shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()
  `;
  assert.equal(identity.name, config.database);
  assert.equal(identity.marker, `serendipity-phase012-disposable:${config.runId}`);
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
      `COMMENT ON DATABASE "${database}" IS 'serendipity-phase012-disposable:${config.runId}'`,
    );
    const migration = await runAdminCommand(
      [path.resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"],
      { env: { DATABASE_URL: ownerUrl } },
    );
    assert.equal(migration.exitCode, 0, "Admin fixture migration failed");
    for (const statement of [
      "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
      "GRANT USAGE ON SCHEMA public TO phase012_app",
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "User", "SystemConfig", "TravelRecord", "ChatMessage", "ApiKeyConfig" TO phase012_app',
      'GRANT SELECT, INSERT ON TABLE "AuditLog", "AuthSession", "AuthLoginAttempt" TO phase012_app',
      'GRANT UPDATE (status,"lastSeenAt","revokedAt") ON "AuthSession" TO phase012_app',
      'GRANT UPDATE (status,"completedAt") ON "AuthLoginAttempt" TO phase012_app',
      'GRANT SELECT, INSERT, UPDATE ON TABLE "AdminCommandReceipt", "KeyRotationRun" TO phase012_app',
      'GRANT SELECT ON "_prisma_migrations" TO phase012_app',
      "GRANT EXECUTE ON FUNCTION public.auth_now() TO phase012_app",
    ])
      await admin.$executeRawUnsafe(statement);
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
  fixture: AdminFixture,
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
  fixture: AdminFixture,
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
  mode?: "route" | "observed-list";
  method: "GET" | "PATCH";
  path?: string;
  session?: FixtureSession;
  csrf?: "missing" | "mismatch";
  origin?: string;
  idempotencyKey?: string;
  body?: unknown;
}
export interface WorkerResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  queries?: string[];
}
export interface AdminWorker {
  request(input: WorkerRequest): Promise<WorkerResponse>;
  close(): Promise<void>;
}

/** Persistent real Route Handler process; it can be stopped/restarted while PG receipts survive. */
export async function startAdminWorker(fixture: AdminFixture): Promise<AdminWorker> {
  const child = spawn(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "tests/phase012/admin-worker.ts"],
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
        ENCRYPTION_KEY: Buffer.alloc(32, 12).toString("base64"),
        AI_API_KEY: "",
        AI_BASE_URL: "https://provider.invalid",
        AI_MODEL: "synthetic-phase012",
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
