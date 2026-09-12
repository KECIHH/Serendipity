import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";

export interface AuthFixtureConfig {
  phase: "011" | "012" | "013" | "014";
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

export function fixtureConfig(): AuthFixtureConfig {
  const file = process.env.PHASE011_FIXTURE_CONFIG;
  assert(file, "Phase011 requires its task-owned database configuration");
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as Omit<AuthFixtureConfig, "phase">;
  assert.match(config.runId, /^[a-f0-9]{12}$/);
  const match = /^phase(011|012|013|014)_disposable_([a-f0-9]{12})$/.exec(config.database);
  assert(match, "Auth regression requires an owned Phase011, Phase012 or Phase013 database");
  const phase = match[1] as AuthFixtureConfig["phase"];
  assert.equal(config.database, `phase${phase}_disposable_${config.runId}`);
  assert.equal(config.user, `phase${phase}_runner`);
  assert.equal(config.appUser, `phase${phase}_app`);
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
  return { ...config, phase };
}

export function registerCanary(values: Record<string, string>): void {
  const file = process.env.PHASE011_FIXTURE_CONFIG;
  assert(file);
  fs.appendFileSync(
    path.join(path.dirname(file), "auth-canaries.jsonl"),
    `${JSON.stringify(values)}\n`,
  );
}

function scan(value: string): void {
  const config = fixtureConfig();
  const sensitive = [config.password, config.appPassword, config.authSecret];
  const file = path.join(path.dirname(process.env.PHASE011_FIXTURE_CONFIG!), "auth-canaries.jsonl");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean))
      sensitive.push(...Object.values(JSON.parse(line) as Record<string, string>));
  }
  assert(
    !sensitive.some((secret) => secret && value.includes(secret)),
    "Fixture process disclosed a synthetic credential or private identifier",
  );
  assert(
    !/postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@/i.test(value),
    "Fixture process disclosed a database URL",
  );
}

export async function runAuthCommand(
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
      reject(new Error("Auth fixture command timed out"));
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
        scan(stdout);
        scan(stderr);
        resolve({ exitCode, stdout, stderr });
      } catch {
        reject(new Error("SECRET_SCAN_REJECTED"));
      }
    });
  });
}

export interface AuthFixture {
  config: AuthFixtureConfig;
  database: string;
  url: string;
  ownerUrl: string;
  admin: PrismaClient;
  app: PrismaClient;
  clock: Date;
  seed: { email: string; password: string; userId: string };
  setClock(value: Date): Promise<void>;
}

/** Each test gets a new, marked PG17 database, all real migrations and the real base seed. */
export async function withAuthDatabase<T>(
  operation: (fixture: AuthFixture) => Promise<T>,
): Promise<T> {
  const config = fixtureConfig();
  const database = `${config.database}_a${randomBytes(5).toString("hex")}`;
  assert.match(database, /^phase(?:011|012|013|014)_disposable_[a-f0-9]{12}_a[a-f0-9]{10}$/);
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
  runtime.searchParams.set("connection_limit", "4");
  const ownerUrl = owner.toString(),
    url = runtime.toString();
  const admin = new PrismaClient({ datasourceUrl: ownerUrl, log: [] });
  const app = new PrismaClient({ datasourceUrl: url, log: [] });
  try {
    await control.$executeRawUnsafe(
      `COMMENT ON DATABASE "${database}" IS 'serendipity-phase${config.phase}-disposable:${config.runId}'`,
    );
    const migration = await runAuthCommand(
      [path.resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"],
      { env: { DATABASE_URL: ownerUrl } },
    );
    assert.equal(migration.exitCode, 0, "Auth fixture migration failed");
    for (const statement of [
      "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
      `GRANT USAGE ON SCHEMA public TO "${config.appUser}"`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "User", "SystemConfig", "TravelRecord", "ChatMessage", "ApiKeyConfig" TO "${config.appUser}"`,
      `GRANT SELECT, INSERT ON TABLE "AuditLog", "AuthSession", "AuthLoginAttempt" TO "${config.appUser}"`,
      `GRANT UPDATE (status,"lastSeenAt","revokedAt") ON "AuthSession" TO "${config.appUser}"`,
      `GRANT UPDATE (status,"completedAt") ON "AuthLoginAttempt" TO "${config.appUser}"`,
      `GRANT SELECT ON "_prisma_migrations" TO "${config.appUser}"`,
      `GRANT EXECUTE ON FUNCTION public.auth_now() TO "${config.appUser}"`,
    ])
      await admin.$executeRawUnsafe(statement);
    const email = `auth-${randomBytes(8).toString("hex")}@example.invalid`;
    const password = `${randomBytes(24).toString("base64url")}Aa1!`;
    registerCanary({ email, password });
    const seeded = await runAuthCommand(
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
    // This exact random name was created above, after proving the marked disposable control DB.
    await control.$executeRawUnsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
    await control.$disconnect();
  }
}
