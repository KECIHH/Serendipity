import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { testEnvironment as previousEnvironment, resetDatabase as resetPreviousDatabase } from "./phase016-runtime.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const planPath = "docs/phase-plans/Phase017.json", receiptPath = "docs/phase-plans/Phase017-inputs.json";
export const databasePath = ".scaffold/phase017/database.json";
export const read = (file, base = root) => fs.readFileSync(path.join(base, file));
export const json = (file, base = root) => JSON.parse(read(file, base));
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const hash = (file, base = root) => sha(read(file, base));
export const plan = json(planPath);
export const directory = `docs/evidence/attempts/Phase017/${plan.attemptId}`;
export const npmCli = path.join(root, ".scaffold/tools/node_modules/npm/bin/npm-cli.js");
export function write(file, data, exclusive = true) {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2) + "\n", { flag: exclusive ? "wx" : "w" });
}
export function git(args, encoding = "utf8") {
  const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], { cwd: root, encoding, windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}
export function scan(value, label = "output") {
  const text = String(value), unescaped = text.replace(/\\+(["'])/g, "$1");
  const secrets = [];
  for (const file of [databasePath, ".scaffold/phase015/full-database.json", ".scaffold/phase016/full-database.json"])
    if (fs.existsSync(path.join(root, file))) {
      const config = json(file);
      secrets.push(...["url", "appUrl", "password", "appPassword", "authSecret", "encryptionKey"].map((key) => config[key]).filter(Boolean));
    }
  const rules = [
    ["PROVIDER_KEY_PATTERN", /\b(?:sk|rk)[-_][A-Za-z0-9_-]{20,}\b/.test(text)],
    ["ENCRYPTED_ENVELOPE", /["']?ciphertext["']?\s*:\s*["'][A-Za-z0-9+/]{2,}={0,2}["']/.test(unescaped)],
    ["DATABASE_CREDENTIAL", /postgres(?:ql)?:\/\/[^\s"'<>]+:[^\s"'<>]+@/i.test(text)],
  ];
  const allowlists = ["tests/phase016/source-scan-allowlist.json", "tests/phase015/source-scan-allowlist.json"];
  const exception = allowlists.flatMap((file) => json(file).fixtures).find((row) => row.path === label && row.sha256 === sha(Buffer.from(text)));
  assert(!secrets.some((secret) => text.includes(secret)), "SECRET_SCAN:SYNTHETIC_CREDENTIAL");
  assert(!rules.some(([rule, matched]) => matched && !exception?.rules.includes(rule)), `SECRET_SCAN:${label}`);
}
export function command(executable, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(executable, args, { cwd: options.cwd ?? root, env: { ...process.env, ...options.env }, windowsHide: true, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, timeout: options.timeoutMs ?? 180000 });
  const record = { command: [executable, ...args].join(" "), executable, arguments: args, cwd: options.cwd ?? root, exitCode: result.status, signal: result.signal, timedOut: result.error?.code === "ETIMEDOUT", startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - started, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  scan(record.stdout + "\n" + record.stderr);
  return record;
}
export const npmRun = (script, args = [], options = {}) => command(process.execPath, [npmCli, "run", script, ...args], options);
export function environment() {
  const config = json(databasePath);
  return { ...previousEnvironment(path.join(root, ".scaffold/phase016/full-database.json")), PHASE017_FIXTURE_CONFIG: path.join(root, databasePath), DATABASE_URL: config.appUrl };
}
export async function ensureDatabase() {
  if (!fs.existsSync(path.join(root, databasePath))) {
    const base = json(".scaffold/phase016/full-database.json");
    const url = new URL(base.url);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, `/phase016_disposable_${base.runId}`);
    const admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    try {
      const identity = await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()");
      assert.equal(identity.rows[0].marker, `serendipity-phase016-disposable:${base.runId}`);
      const runId = randomBytes(6).toString("hex"), database = `phase017_disposable_${runId}`, appUser = `phase017_app_${runId}`, appPassword = randomBytes(24).toString("hex");
      await admin.query(`CREATE ROLE ${appUser} LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      await admin.query(`CREATE DATABASE ${database} OWNER ${base.user}`);
      await admin.query(`COMMENT ON DATABASE ${database} IS 'serendipity-phase017-disposable:${runId}'`);
      url.pathname = `/${database}`;
      const appUrl = new URL(url); appUrl.username = appUser; appUrl.password = appPassword;
      write(databasePath, { ...base, phase: "017", runId, database, appUser, appPassword, url: url.toString(), appUrl: appUrl.toString() });
    } finally { await admin.end(); }
  }
  const config = json(databasePath);
  const admin = new pg.Client({ connectionString: config.url }); await admin.connect();
  try {
    assert.match(config.database, /^phase017_disposable_[a-f0-9]{12}$/);
    assert.equal(new URL(config.url).hostname, "127.0.0.1");
    assert.equal(new URL(config.url).pathname, `/${config.database}`);
    const { rows } = await admin.query("SELECT current_database() AS name,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()");
    assert.equal(rows[0].name, config.database);
    assert.equal(rows[0].marker, `serendipity-phase017-disposable:${config.runId}`);
  } finally { await admin.end(); }
  return config;
}
export async function resetDatabase() {
  const config = await ensureDatabase();
  const result = command(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "reset", "--force", "--skip-seed", "--skip-generate"], { env: { DATABASE_URL: config.url }, timeoutMs: 240000 });
  assert.equal(result.exitCode, 0, "PHASE017_MIGRATIONS");
  const admin = new pg.Client({ connectionString: config.url }); await admin.connect();
  try {
    assert.match(config.appUser, /^phase017_app_[a-f0-9]{12}$/);
    await admin.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ${config.appUser}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${config.appUser}; REVOKE UPDATE,DELETE ON "AiOutputRecord","AuditLog","PromptVersion","PromptDefinition","ModelDeployment","ProviderConfigVersion","PlanningPolicyVersion","ChatCommandEvent" FROM ${config.appUser}; GRANT EXECUTE ON FUNCTION public.auth_now() TO ${config.appUser}`);
  } finally { await admin.end(); }
  return result;
}
export function resetRegression() {
  return [resetPreviousDatabase(root, true), resetPreviousDatabase(root, false)];
}
export function sourceFiles() {
  return git(["ls-files", "--cached", "--others", "--exclude-standard", "--", "src", "tests", "prisma", "scripts", "vitest"]).trim().split(/\r?\n/).filter(Boolean);
}
export function fixtureFiles() {
  return [...new Set([...sourceFiles(), "package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", "vitest.setup.ts", "docs/travel-plan-schema.md", "docs/prompt-design.md"])].sort();
}
export function copyFixture(label) {
  assert.match(label, /^[a-z0-9-]+$/);
  const parent = path.join(root, ".scaffold/phase017/fixtures"); fs.mkdirSync(parent, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(parent, `${label}-`));
  const files = fixtureFiles();
  for (const file of files) { fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true }); fs.copyFileSync(path.join(root, file), path.join(fixture, file)); }
  fs.symlinkSync(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "junction");
  return fixture;
}
export function removeFixture(fixture) {
  const absolute = fs.realpathSync(fixture);
  assert.equal(path.dirname(absolute), fs.realpathSync(path.join(root, ".scaffold/phase017/fixtures")));
  assert.equal(absolute, path.resolve(fixture));
  const modules = path.join(absolute, "node_modules");
  assert(fs.lstatSync(modules).isSymbolicLink()); fs.unlinkSync(modules);
  fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
