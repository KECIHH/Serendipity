import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";

interface Config {
  phase: "010" | "011" | "012";
  runId: string;
  database: string;
  url: string;
  appUrl: string;
  user: string;
  appUser: string;
  password: string;
  appPassword: string;
}

export function fixtureConfig(): Config {
  const file = process.env.PHASE010_FIXTURE_CONFIG;
  assert(file, "Phase010 requires its task-owned database configuration");
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as Omit<Config, "phase">;
  assert.match(config.runId, /^[a-f0-9]{12}$/);
  const match = /^phase(010|011|012)_disposable_([a-f0-9]{12})$/.exec(config.database);
  assert(match, "Seed regression requires an owned Phase010, Phase011 or Phase012 database");
  const phase = match[1] as Config["phase"];
  assert.equal(config.database, `phase${phase}_disposable_${config.runId}`);
  assert.equal(config.user, `phase${phase}_runner`);
  assert.equal(config.appUser, `phase${phase}_app`);
  for (const [value, username] of [
    [config.url, config.user],
    [config.appUrl, config.appUser],
  ]) {
    const url = new URL(value);
    assert.equal(url.protocol, "postgresql:");
    assert.equal(url.hostname, "127.0.0.1");
    assert(url.port);
    assert.equal(url.pathname, `/${config.database}`);
    assert.equal(url.username, username);
  }
  return { ...config, phase };
}

export async function childCommand(
  args: string[],
  env: Record<string, string | undefined>,
  cwd = process.cwd(),
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const configFile = process.env.PHASE010_FIXTURE_CONFIG;
  assert(configFile, "CLI fixtures require the task-owned scan configuration");
  const config = fixtureConfig();
  const runtimePath = path.resolve(
    path.dirname(configFile),
    `../../docs/phase-plans/phase${config.phase}-runtime.mjs`,
  );
  const { scanSensitiveText } = await import(pathToFileURL(runtimePath).href);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      // Negative CLI fixtures intentionally exercise absent/invalid NODE_ENV values.
      env: env as NodeJS.ProcessEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Fixture command timed out"));
    }, 60_000);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      try {
        scanSensitiveText(stdout);
        scanSensitiveText(stderr);
      } catch (error) {
        reject(error);
        return;
      }
      resolve({ exitCode, stdout, stderr });
    });
  });
}

export function syntheticSeedEnv(url: string): Record<string, string | undefined> {
  const password = `${randomBytes(24).toString("base64url")}Aa1!`;
  const email = `seed-${randomBytes(8).toString("hex")}@example.invalid`;
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: url,
    ADMIN_EMAIL: email,
    ADMIN_INITIAL_PASSWORD: password,
    CHECKPOINT_DISABLE: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    NPM_CONFIG_OFFLINE: "true",
    NODE_OPTIONS: "",
  };
  // Exercise the real CLI without any Web-only secret or bootstrap Provider input.
  for (const key of [
    "AUTH_SECRET",
    "AUTH_URL",
    "AUTH_TRUSTED_PROXY_CIDRS",
    "ENCRYPTION_KEY",
    "AI_API_KEY",
    "AI_BASE_URL",
    "AI_MODEL",
  ])
    delete env[key as keyof typeof env];
  const local = path.join(
    path.dirname(process.env.PHASE010_FIXTURE_CONFIG!),
    "seed-canaries.jsonl",
  );
  fs.appendFileSync(local, JSON.stringify({ email, password }) + "\n");
  return env;
}

export async function runSeed(env: Record<string, string | undefined>) {
  const npmCli = path.resolve(
    path.dirname(process.env.PHASE010_FIXTURE_CONFIG!),
    "../tools/node_modules/npm/bin/npm-cli.js",
  );
  const result = await childCommand([npmCli, "run", "--silent", "db:seed"], env);
  const output = result.stdout + result.stderr;
  for (const key of [
    "DATABASE_URL",
    "ADMIN_INITIAL_PASSWORD",
    "ADMIN_EMAIL",
    "AUTH_SECRET",
    "ENCRYPTION_KEY",
    "AI_API_KEY",
  ]) {
    const value = env[key];
    assert(!value || !output.includes(value), "Raw CLI output disclosed a command input");
  }
  return result;
}

export async function withSeedDatabase<T>(
  operation: (fixture: {
    admin: PrismaClient;
    app: PrismaClient;
    url: string;
    database: string;
    config: Config;
  }) => Promise<T>,
): Promise<T> {
  const config = fixtureConfig();
  const database = `${config.database}_t${randomBytes(5).toString("hex")}`;
  assert(database.length <= 63);
  assert.match(database, /^phase(?:010|011|012)_disposable_[a-f0-9]{12}_t[a-f0-9]{10}$/);
  const control = new PrismaClient({ datasourceUrl: config.url, log: [] });
  const [identity] = await control.$queryRaw<
    Array<{ name: string; role: string; marker: string | null; version: string }>
  >`
    SELECT current_database() AS name, current_user AS role, shobj_description(oid,'pg_database') AS marker, current_setting('server_version') AS version
    FROM pg_database WHERE datname=current_database()
  `;
  assert.equal(identity.name, config.database);
  assert.equal(identity.role, config.user);
  assert.equal(identity.marker, `serendipity-phase${config.phase}-disposable:${config.runId}`);
  assert.match(identity.version, /^17\./);
  await control.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
  await control.$executeRawUnsafe(
    `COMMENT ON DATABASE "${database}" IS 'serendipity-phase${config.phase}-disposable:${config.runId}'`,
  );
  const ownerUrl = new URL(config.url);
  ownerUrl.pathname = `/${database}`;
  const runtimeUrl = new URL(config.appUrl);
  runtimeUrl.pathname = `/${database}`;
  const admin = new PrismaClient({ datasourceUrl: ownerUrl.toString(), log: [] });
  const app = new PrismaClient({ datasourceUrl: runtimeUrl.toString(), log: [] });
  try {
    const migrated = await childCommand(
      [path.resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"],
      { ...process.env, DATABASE_URL: ownerUrl.toString(), CHECKPOINT_DISABLE: "1" },
    );
    assert.equal(migrated.exitCode, 0, "Fixture migration must succeed");
    for (const statement of [
      "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
      `GRANT USAGE ON SCHEMA public TO "${config.appUser}"`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "User", "SystemConfig", "TravelRecord", "ChatMessage", "ApiKeyConfig" TO "${config.appUser}"`,
      `GRANT SELECT, INSERT ON TABLE "AuditLog" TO "${config.appUser}"`,
      `GRANT SELECT ON TABLE "_prisma_migrations" TO "${config.appUser}"`,
    ])
      await admin.$executeRawUnsafe(statement);
    if (Prisma.dmmf.datamodel.models.some(({ name }) => name === "AuthSession")) {
      for (const statement of [
        `GRANT SELECT, INSERT ON TABLE "AuthSession", "AuthLoginAttempt" TO "${config.appUser}"`,
        `GRANT UPDATE ("status", "lastSeenAt", "revokedAt") ON TABLE "AuthSession" TO "${config.appUser}"`,
        `GRANT UPDATE ("status", "completedAt") ON TABLE "AuthLoginAttempt" TO "${config.appUser}"`,
        `GRANT EXECUTE ON FUNCTION public.auth_now() TO "${config.appUser}"`,
      ])
        await admin.$executeRawUnsafe(statement);
    }
    return await operation({ admin, app, url: runtimeUrl.toString(), database, config });
  } finally {
    await app.$disconnect();
    await admin.$disconnect();
    await control.$executeRawUnsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
    await control.$disconnect();
  }
}

/** Compare private row bytes through digests so a failing assertion cannot print credentials. */
export async function rowSnapshot(client: PrismaClient): Promise<string> {
  const rows = await client.$queryRaw<Array<{ table: string; hash: string }>>`
    SELECT 'User' AS table, encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') AS hash FROM "User" t
    UNION ALL SELECT 'SystemConfig', encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') FROM "SystemConfig" t
    UNION ALL SELECT 'AuditLog', encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') FROM "AuditLog" t ORDER BY 1,2
  `;
  const authRows = Prisma.dmmf.datamodel.models.some(({ name }) => name === "AuthSession")
    ? await client.$queryRaw<Array<{ table: string; hash: string }>>`
        SELECT 'AuthSession' AS table, encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') AS hash FROM "AuthSession" t
        UNION ALL SELECT 'AuthLoginAttempt', encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') FROM "AuthLoginAttempt" t ORDER BY 1,2
      `
    : [];
  return createHash("sha256")
    .update(JSON.stringify([...rows, ...authRows]))
    .digest("hex");
}
