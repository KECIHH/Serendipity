import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const planPath = "docs/phase-plans/Phase018.json";
export const receiptPath = "docs/phase-plans/Phase018-inputs.json";
export const databasePath = ".scaffold/phase018/database.json";
export const phase015DatabasePath = ".scaffold/phase015/full-database.json";
export const phase016DatabasePath = ".scaffold/phase016/full-database.json";
export const phase017DatabasePath = ".scaffold/phase017/database.json";
export const read = (file, base = root) => fs.readFileSync(path.join(base, file));
export const json = (file, base = root) => JSON.parse(read(file, base));
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const hash = (file, base = root) => sha(read(file, base));
export const plan = json(planPath);
export const directory = `docs/evidence/attempts/Phase018/${plan.attemptId}`;
export const npmCli = path.join(root, ".scaffold/tools/node_modules/npm/bin/npm-cli.js");
export const prismaCli = path.join(root, "node_modules/prisma/build/index.js");

export function write(file, data, exclusive = true) {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(
    absolute,
    typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2) + "\n",
    { flag: exclusive ? "wx" : "w" },
  );
}

export function git(args, encoding = "utf8") {
  const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: root,
    encoding,
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}

export function scan(value, label = "output") {
  const text = String(value);
  const unescaped = text.replace(/\\+(["'])/g, "$1");
  const secrets = [];
  for (const file of [databasePath, phase015DatabasePath, phase016DatabasePath, phase017DatabasePath])
    if (fs.existsSync(path.join(root, file))) {
      const config = json(file);
      secrets.push(
        ...["url", "appUrl", "password", "appPassword", "authSecret", "encryptionKey"]
          .map((key) => config[key])
          .filter(Boolean),
      );
    }
  const rules = [
    ["PROVIDER_KEY_PATTERN", /\b(?:sk|rk)[-_][A-Za-z0-9_-]{20,}\b/.test(text)],
    ["ENCRYPTED_ENVELOPE", /["']?ciphertext["']?\s*:\s*["'][A-Za-z0-9+/]{2,}={0,2}["']/.test(unescaped)],
    ["DATABASE_CREDENTIAL", /postgres(?:ql)?:\/\/[^\s"'<>]+:[^\s"'<>]+@/i.test(text)],
  ];
  const allowlists = [
    "tests/phase018/source-scan-allowlist.json",
    "tests/phase016/source-scan-allowlist.json",
    "tests/phase015/source-scan-allowlist.json",
  ];
  const exception = allowlists
    .filter((file) => fs.existsSync(path.join(root, file)))
    .flatMap((file) => json(file).fixtures)
    .find((row) => row.path === label && row.sha256 === sha(Buffer.from(text)));
  assert(!secrets.some((secret) => text.includes(secret)), "SECRET_SCAN:SYNTHETIC_CREDENTIAL");
  assert(
    !rules.some(([rule, matched]) => matched && !exception?.rules.includes(rule)),
    `SECRET_SCAN:${label}`,
  );
}

export function command(executable, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: options.timeoutMs ?? 180000,
  });
  const record = {
    command: [executable, ...args].join(" "),
    executable,
    arguments: args,
    cwd: options.cwd ?? root,
    exitCode: result.status,
    signal: result.signal,
    timedOut: result.error?.code === "ETIMEDOUT",
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  scan(record.stdout + "\n" + record.stderr);
  return record;
}

export const npmRun = (script, args = [], options = {}) =>
  command(process.execPath, [npmCli, "run", script, ...args], options);

export function environment() {
  const config = json(databasePath);
  const phase016 = json(phase016DatabasePath);
  const phase015 = json(phase015DatabasePath);
  const phase017 = json(phase017DatabasePath);
  const regressionPath = path.resolve(root, phase015DatabasePath);
  return {
    DATABASE_URL: config.appUrl,
    AUTH_SECRET: config.authSecret,
    AUTH_URL: "http://127.0.0.1:3000",
    AUTH_TRUSTED_PROXY_CIDRS: "",
    ENCRYPTION_KEY: config.encryptionKey,
    AI_MOCK: "true",
    AI_TIMEOUT_MS: "60000",
    AI_DAILY_COST_LIMIT: "5",
    PHASE007_DATABASE_URL: phase015.url,
    PHASE008_DATABASE_URL: phase015.url,
    PHASE009_DATABASE_URL: phase015.url,
    PHASE009_RUNTIME_DATABASE_URL: phase015.appUrl,
    PHASE010_FIXTURE_CONFIG: regressionPath,
    PHASE011_FIXTURE_CONFIG: regressionPath,
    PHASE012_FIXTURE_CONFIG: regressionPath,
    PHASE013_FIXTURE_CONFIG: regressionPath,
    PHASE014_FIXTURE_CONFIG: regressionPath,
    PHASE015_FIXTURE_CONFIG: regressionPath,
    PHASE016_FIXTURE_CONFIG: path.resolve(root, phase016DatabasePath),
    PHASE017_FIXTURE_CONFIG: path.resolve(root, phase017DatabasePath),
    PHASE018_FIXTURE_CONFIG: path.resolve(root, databasePath),
    PHASE012_DATABASE_URL: phase015.url,
    PHASE012_RUNTIME_DATABASE_URL: phase015.appUrl,
    PHASE013_DATABASE_URL: phase015.url,
    PHASE013_RUNTIME_DATABASE_URL: phase015.appUrl,
    NEXT_TELEMETRY_DISABLED: "1",
    ...(phase016.authSecret ? {} : {}),
  };
}

async function identity(config) {
  const admin = new pg.Client({ connectionString: config.url });
  await admin.connect();
  try {
    const { rows } = await admin.query(
      "SELECT current_database() AS name,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()",
    );
    return rows[0];
  } finally {
    await admin.end();
  }
}

export async function ensureDatabase() {
  if (!fs.existsSync(path.join(root, databasePath))) {
    const base = json(phase016DatabasePath);
    const url = new URL(base.url);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, `/phase016_disposable_${base.runId}`);
    const admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    try {
      const rows = await admin.query(
        "SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()",
      );
      assert.equal(rows.rows[0].marker, `serendipity-phase016-disposable:${base.runId}`);
      const runId = randomBytes(6).toString("hex");
      const database = `phase018_disposable_${runId}`;
      const appUser = `phase018_app_${runId}`;
      const appPassword = randomBytes(24).toString("hex");
      await admin.query(
        `CREATE ROLE ${appUser} LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(`CREATE DATABASE ${database} OWNER ${base.user}`);
      await admin.query(
        `COMMENT ON DATABASE ${database} IS 'serendipity-phase018-disposable:${runId}'`,
      );
      const own = new URL(url);
      own.pathname = `/${database}`;
      const app = new URL(url);
      app.pathname = `/${database}`;
      app.username = appUser;
      app.password = appPassword;
      const regression = json(phase015DatabasePath);
      write(databasePath, {
        phase: "018",
        runId,
        database,
        user: base.user,
        password: json(".scaffold/phase014/database.json").password,
        appUser,
        appPassword,
        url: own.toString(),
        appUrl: app.toString(),
        authSecret: regression.authSecret,
        encryptionKey: regression.encryptionKey,
      });
    } finally {
      await admin.end();
    }
  }
  const config = json(databasePath);
  assert.match(config.database, /^phase018_disposable_[a-f0-9]{12}$/);
  assert.equal(new URL(config.url).hostname, "127.0.0.1");
  assert.equal(new URL(config.url).pathname, `/${config.database}`);
  const row = await identity(config);
  assert.equal(row.name, config.database);
  assert.equal(row.marker, `serendipity-phase018-disposable:${config.runId}`);
  return config;
}

const appGrants = (config) =>
  [
    "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
    `GRANT USAGE ON SCHEMA public TO ${config.appUser}`,
    `GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE "User","SystemConfig","TravelRecord","ChatMessage","ApiKeyConfig","ChatCommand","CommandIdempotency","DurableTask","Outbox" TO ${config.appUser}`,
    `GRANT SELECT,INSERT ON TABLE "ChatCommandEvent","AiOutputRecord","AuditLog","AuthSession","AuthLoginAttempt" TO ${config.appUser}`,
    `GRANT SELECT,INSERT,DELETE ON TABLE "TaskPayload" TO ${config.appUser}`,
    `GRANT UPDATE(id) ON TABLE "TaskPayload" TO ${config.appUser}`,
    `GRANT SELECT,INSERT,UPDATE ON TABLE "AiUsageReservation","AdminCommandReceipt","KeyRotationRun","PromptActivation","PromptModelActivation","PlanningPolicyActivation" TO ${config.appUser}`,
    `GRANT SELECT,INSERT ON TABLE "PromptDefinition","PromptVersion","PlanningPolicyVersion","ProviderConfigVersion","ModelDeployment" TO ${config.appUser}`,
    `GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE "AiDebugRun" TO ${config.appUser}`,
    `GRANT UPDATE(status,"lastSeenAt","revokedAt") ON "AuthSession" TO ${config.appUser}`,
    `GRANT UPDATE(status,"completedAt") ON "AuthLoginAttempt" TO ${config.appUser}`,
    "GRANT EXECUTE ON FUNCTION public.auth_now() TO " + config.appUser,
    'GRANT SELECT ON "_prisma_migrations" TO ' + config.appUser,
  ].join(";\n");

/** The owner connection may reset a disposable database; the runtime role stays restricted. */
export async function resetDisposable(config, marker) {
  const migration = command(
    process.execPath,
    [prismaCli, "migrate", "reset", "--force", "--skip-seed", "--skip-generate"],
    { env: { DATABASE_URL: config.url }, timeoutMs: 300000 },
  );
  if (migration.exitCode !== 0) return migration;
  const admin = new pg.Client({ connectionString: config.url });
  await admin.connect();
  let grants;
  try {
    const result = await admin.query(`${appGrants(config)};\nCOMMENT ON DATABASE "${config.database}" IS '${marker}';`);
    grants = { exitCode: 0, stdout: "", stderr: "" };
    void result;
  } finally {
    await admin.end();
  }
  return {
    ...migration,
    command: `${migration.command} && psql privileges`,
    stdout: `${migration.stdout}\n${grants.stdout}`,
    stderr: `${migration.stderr}\n${grants.stderr}`,
    exitCode: migration.exitCode === 0 && grants.exitCode === 0 ? 0 : 1,
    timedOut: false,
    databaseMarker: marker,
    steps: [migration],
  };
}

export async function resetDatabase() {
  const config = await ensureDatabase();
  return resetDisposable(config, `serendipity-phase018-disposable:${config.runId}`);
}

export async function resetRegression() {
  const results = [];
  const phase015 = json(phase015DatabasePath);
  const phase016 = json(phase016DatabasePath);
  const phase017 = json(phase017DatabasePath);
  for (const [config, marker] of [
    [phase015, `serendipity-phase015-disposable:${phase015.runId}`],
    [phase016, `serendipity-phase016-disposable:${phase016.runId}`],
    [phase017, `serendipity-phase017-disposable:${phase017.runId}`],
  ]) {
    const row = await identity(config);
    assert.equal(row.name, config.database);
    assert.equal(row.marker, marker);
    results.push(await resetDisposable(config, marker));
  }
  return results;
}

export function sourceFiles() {
  return git([
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "src",
    "tests",
    "prisma",
    "scripts",
    "vitest",
  ])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
}

export function fixtureFiles() {
  return [
    ...new Set([
      ...sourceFiles(),
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "vitest.config.ts",
      "vitest.setup.ts",
      "docs/travel-plan-schema.md",
      "docs/prompt-design.md",
    ]),
  ].sort();
}

export function copyFixture(label) {
  assert.match(label, /^[a-z0-9-]+$/);
  const parent = path.join(root, ".scaffold/phase018/fixtures");
  fs.mkdirSync(parent, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(parent, `${label}-`));
  for (const file of fixtureFiles()) {
    fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(fixture, file));
  }
  fs.symlinkSync(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "junction");
  return fixture;
}

export function removeFixture(fixture) {
  const absolute = fs.realpathSync(fixture);
  assert.equal(path.dirname(absolute), fs.realpathSync(path.join(root, ".scaffold/phase018/fixtures")));
  assert.equal(absolute, path.resolve(fixture));
  const modules = path.join(absolute, "node_modules");
  assert(fs.lstatSync(modules).isSymbolicLink());
  fs.unlinkSync(modules);
  fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
