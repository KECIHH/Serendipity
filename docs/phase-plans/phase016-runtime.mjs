import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const planPath = "docs/phase-plans/Phase016.json";
export const receiptPath = "docs/phase-plans/Phase016-inputs.json";
export const minimalDatabasePath = ".scaffold/phase016/database.json";
export const fullDatabasePath = ".scaffold/phase016/full-database.json";
export const read = (file, base = root) => fs.readFileSync(path.join(base, file));
export const json = (file, base = root) => JSON.parse(read(file, base));
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const hash = (file, base = root) => sha(read(file, base));
export const plan = json(planPath);
export const directory = `docs/evidence/attempts/Phase016/${plan.attemptId}`;
export const npmCli = path.join(root, ".scaffold/tools/node_modules/npm/bin/npm-cli.js");
export const prismaCli = path.join(root, "node_modules/prisma/build/index.js");

export function write(file, value, exclusive = true) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    typeof value === "string" || Buffer.isBuffer(value)
      ? value
      : `${JSON.stringify(value, null, 2)}\n`,
    { flag: exclusive ? "wx" : "w" },
  );
}

export function git(args, encoding = "utf8") {
  const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: root,
    windowsHide: true,
    encoding,
    maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}

export function command(name, args, options = {}) {
  const cwd = options.cwd ?? root;
  const startedAt = Date.now();
  const result = spawnSync(name, args, {
    cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: options.timeoutMs ?? 180_000,
  });
  const record = {
    command: [name, ...args].join(" "),
    executable: name,
    arguments: args,
    cwd: path.resolve(cwd),
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode: result.status,
    signal: result.signal,
    timedOut: result.error?.code === "ETIMEDOUT",
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: Date.now() - startedAt,
  };
  if (record.timedOut) record.stderr = `${record.stderr}\nCOMMAND_TIMED_OUT`.trim();
  scanSensitiveText(`${record.stdout}\n${record.stderr}`, record.command);
  return record;
}

export function npmRun(script, args = [], options = {}) {
  return command(process.execPath, [npmCli, "run", script, ...args], options);
}

export function scanSensitiveText(value, label = "output") {
  const text = String(value ?? "");
  const secrets = [];
  if (fs.existsSync(path.join(root, minimalDatabasePath))) {
    const config = json(minimalDatabasePath);
    secrets.push(config.url, config.appUrl);
  }
  if (fs.existsSync(path.join(root, fullDatabasePath))) {
    const config = json(fullDatabasePath);
    secrets.push(
      config.url,
      config.appUrl,
      config.password,
      config.appPassword,
      config.authSecret,
      config.encryptionKey,
    );
  }
  const unescaped = text.replace(/\\+(["'])/g, "$1");
  const patterns = [
    ["PROVIDER_KEY_PATTERN", /\b(?:sk|rk)[-_][A-Za-z0-9_-]{20,}\b/.test(text)],
    ["ENCRYPTED_ENVELOPE", /["']?ciphertext["']?\s*:\s*["'][A-Za-z0-9+/]{2,}={0,2}["']/.test(unescaped)],
    ["DATABASE_CREDENTIAL", /postgres(?:ql)?:\/\/[^\s"'<>]+:[^\s"'<>]+@/i.test(text)],
  ];
  const violation = secrets.some((secret) => secret && text.includes(secret))
    ? "SYNTHETIC_CREDENTIAL"
    : patterns.find(([, matched]) => matched)?.[0];
  if (violation) {
    const error = new Error(`SECRET_SCAN_REJECTED: ${violation}`);
    error.safeLabel = label;
    throw error;
  }
  return { hits: 0, scannedBeforeRedaction: true };
}

export function safeDiagnostics(value) {
  try {
    scanSensitiveText(value);
    return String(value);
  } catch {
    return "SECRET_SCAN_REJECTED";
  }
}

export function ensureFullDatabaseConfig() {
  const minimal = json(minimalDatabasePath);
  const legacy = json(".scaffold/phase014/database.json");
  const appUrl = new URL(legacy.appUrl);
  appUrl.port = new URL(minimal.appUrl).port;
  const config = {
    phase: "016",
    runId: legacy.runId,
    database: minimal.database,
    user: legacy.user,
    appUser: minimal.appUser,
    password: legacy.password,
    appPassword: minimal.appPassword,
    url: minimal.url,
    appUrl: appUrl.toString(),
    authSecret: legacy.authSecret,
    encryptionKey: minimal.encryptionKey,
    containerId: legacy.containerId,
  };
  assert.match(config.runId, /^[a-f0-9]{12}$/);
  assert.match(config.database, /^phase016_disposable_[a-f0-9]{12}$/);
  assert.equal(config.database, `phase016_disposable_${config.runId}`);
  for (const [value, username] of [[config.url, config.user], [config.appUrl, config.appUser]]) {
    const url = new URL(value);
    assert.equal(url.protocol, "postgresql:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, `/${config.database}`);
    assert.equal(url.username, username);
  }
  assert.equal(Buffer.from(config.encryptionKey, "base64").byteLength, 32);
  write(fullDatabasePath, config, false);
  return { config, path: path.resolve(root, fullDatabasePath) };
}

export function testEnvironment(fixturePath) {
  const config = json(fullDatabasePath);
  return {
    DATABASE_URL: config.appUrl,
    AUTH_SECRET: config.authSecret,
    AUTH_URL: "http://127.0.0.1:3000",
    AUTH_TRUSTED_PROXY_CIDRS: "",
    ENCRYPTION_KEY: config.encryptionKey,
    AI_MOCK: "true",
    AI_TIMEOUT_MS: "60000",
    AI_DAILY_COST_LIMIT: "5",
    PHASE007_DATABASE_URL: config.url,
    PHASE008_DATABASE_URL: config.url,
    PHASE009_DATABASE_URL: config.url,
    PHASE009_RUNTIME_DATABASE_URL: config.appUrl,
    PHASE010_FIXTURE_CONFIG: fixturePath,
    PHASE011_FIXTURE_CONFIG: fixturePath,
    PHASE012_FIXTURE_CONFIG: fixturePath,
    PHASE013_FIXTURE_CONFIG: fixturePath,
    PHASE014_FIXTURE_CONFIG: fixturePath,
    PHASE015_FIXTURE_CONFIG: fixturePath,
    PHASE016_FIXTURE_CONFIG: fixturePath,
    PHASE012_DATABASE_URL: config.url,
    PHASE012_RUNTIME_DATABASE_URL: config.appUrl,
    PHASE013_DATABASE_URL: config.url,
    PHASE013_RUNTIME_DATABASE_URL: config.appUrl,
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

export function resetDatabase(cwd = root) {
  const config = json(fullDatabasePath);
  assert.match(config.database, /^phase016_disposable_[a-f0-9]{12}$/);
  assert.equal(config.database, `phase016_disposable_${config.runId}`);
  assert.equal(new URL(config.url).hostname, "127.0.0.1");
  assert.equal(new URL(config.url).pathname, `/${config.database}`);
  const identity = command(
    "docker",
    ["exec", config.containerId, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", config.user, "-d", config.database, "-At", "-c", "SELECT current_database() || '|' || shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()"],
    { cwd },
  );
  assert.equal(identity.exitCode, 0, "DATABASE_IDENTITY_QUERY");
  assert.equal(
    identity.stdout.trim(),
    `${config.database}|serendipity-phase016-disposable:${config.runId}`,
    "DATABASE_IDENTITY_MISMATCH",
  );
  const migration = command(
    process.execPath,
    [prismaCli, "migrate", "reset", "--force", "--skip-seed", "--skip-generate"],
    { cwd, env: { DATABASE_URL: config.url }, timeoutMs: 240_000 },
  );
  if (migration.exitCode !== 0) return migration;
  const privileges = [
    "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
    `GRANT USAGE ON SCHEMA public TO ${config.appUser}`,
    `GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE "User","SystemConfig","TravelRecord","ChatMessage","ApiKeyConfig","ChatCommand","CommandIdempotency","DurableTask","Outbox" TO ${config.appUser}`,
    `GRANT SELECT,INSERT,UPDATE ON TABLE "ChatCommandEvent","TaskPayload" TO ${config.appUser}`,
    `GRANT SELECT,INSERT ON TABLE "AiOutputRecord","AiUsageReservation","AdminCommandReceipt","KeyRotationRun" TO ${config.appUser}`,
    `GRANT SELECT ON TABLE "PromptDefinition","PromptVersion","PlanningPolicyVersion","ProviderConfigVersion","ModelDeployment","PromptActivation","PromptModelActivation","PlanningPolicyActivation" TO ${config.appUser}`,
    'GRANT SELECT ON "_prisma_migrations" TO ' + config.appUser,
    `GRANT SELECT,UPDATE ON SEQUENCE "ChatCommandEvent_sequence_seq" TO ${config.appUser}`,
    `COMMENT ON DATABASE "${config.database}" IS 'serendipity-phase016-disposable:${config.runId}';`,
  ].join(";\n");
  const marked = command(
    "docker",
    ["exec", config.containerId, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", config.user, "-d", config.database, "-At", "-c", privileges],
    { cwd },
  );
  return {
    ...marked,
    command: `${migration.command} && ${marked.command}`,
    stdout: `${migration.stdout}\n${marked.stdout}`,
    stderr: `${migration.stderr}\n${marked.stderr}`,
    durationMs: migration.durationMs + marked.durationMs,
    databaseMarker: `serendipity-phase016-disposable:${config.runId}`,
    steps: [identity, migration, marked],
  };
}

export function inventory(relative, base = root) {
  const start = path.join(base, relative);
  if (!fs.existsSync(start)) return [];
  return fs.readdirSync(start, { withFileTypes: true }).flatMap((entry) => {
    const child = `${relative}/${entry.name}`;
    return entry.isDirectory() ? inventory(child, base) : [child];
  });
}

export function copyFixture(label) {
  assert.match(label, /^[a-z0-9-]+$/);
  const parent = path.join(root, ".scaffold/phase016/fixtures");
  fs.mkdirSync(parent, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(parent, `${label}-`));
  const files = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vitest.config.ts",
    "vitest.setup.ts",
    ...inventory("src"),
    ...inventory("tests"),
    ...inventory("vitest"),
    ...inventory("prisma"),
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(fixture, file));
  }
  fs.symlinkSync(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "junction");
  return fixture;
}

export function removeFixture(fixture) {
  const absolute = fs.realpathSync(fixture);
  assert.equal(
    path.dirname(absolute),
    fs.realpathSync(path.join(root, ".scaffold/phase016/fixtures")),
  );
  assert.equal(absolute, path.resolve(fixture));
  const modules = path.join(absolute, "node_modules");
  if (fs.existsSync(modules)) {
    assert(fs.lstatSync(modules).isSymbolicLink());
    fs.unlinkSync(modules);
  }
  fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}