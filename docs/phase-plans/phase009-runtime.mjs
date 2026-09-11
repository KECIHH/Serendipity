import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const planPath = "docs/phase-plans/Phase009.json";
export const receiptPath = "docs/phase-plans/Phase009-inputs.json";
export const configPath = ".scaffold/phase009/database.json";
export const generationPath = "docs/evidence/attempts/Phase009/setup/migration-generation.json";
export const migrationPath = fs.existsSync(path.join(root, generationPath)) ? JSON.parse(fs.readFileSync(path.join(root, generationPath), "utf8")).generatedMigrationPath : null;
export const imageDigest = "postgres@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";
export const read = (file, base = root) => fs.readFileSync(path.join(base, file));
export const json = (file, base = root) => JSON.parse(read(file, base));
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const hash = (file, base = root) => sha(read(file, base));
export const plan = json(planPath);
export const directory = `docs/evidence/attempts/Phase009/${plan.attemptId}`;
export const npmCli = path.join(root, ".scaffold/tools/node_modules/npm/bin/npm-cli.js");
export const prismaCli = path.join(root, "node_modules/prisma/build/index.js");

let commandObserver = null;

export function setCommandObserver(observer) {
  assert(observer === null || typeof observer === "function");
  commandObserver = observer;
}

export function write(file, value, exclusive = true) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === "string" || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`, {
    flag: exclusive ? "wx" : "w",
  });
}

export function git(args, encoding = "utf8") {
  const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: root, windowsHide: true, encoding, maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}

export function dbConfig() {
  assert(fs.existsSync(path.join(root, configPath)), "Run setup-phase009.mjs --database first");
  return json(configPath);
}

export function redact(value) {
  let result = String(value ?? "");
  if (fs.existsSync(path.join(root, configPath))) {
    const config = dbConfig();
    for (const secret of [config.password, config.url, config.appPassword, config.appUrl].filter(Boolean)) result = result.replaceAll(secret, "<redacted>");
  }
  return result.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "postgresql://<redacted>");
}

export function environment(extra = {}) {
  const env = { ...process.env };
  const inheritedPath = env.Path ?? env.PATH ?? "";
  for (const key of Object.keys(env)) {
    if (/^(path|node_env|next_private_test_version|psmodulepath|npm_config_.+|database_url|direct_url|shadow_database_url|phase00[6789]_(?:runtime_)?database_url)$/i.test(key)) delete env[key];
  }
  const tools = path.join(root, ".scaffold/tools");
  return {
    ...env,
    Path: `${path.join(tools, "node_modules/.bin")}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${inheritedPath}`,
    CI: "1", NEXT_TELEMETRY_DISABLED: "1", CHECKPOINT_DISABLE: "1",
    NPM_CONFIG_OFFLINE: "true", NPM_CONFIG_USERCONFIG: path.join(tools, "npmrc"),
    NPM_CONFIG_GLOBALCONFIG: path.join(tools, "global-npmrc"), NPM_CONFIG_CACHE: path.join(tools, "cache"),
    PLAYWRIGHT_BROWSERS_PATH: path.join(tools, "browsers"),
    DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/phase009_disposable_unit",
    AUTH_SECRET: "phase009-synthetic-auth-secret-32-characters",
    ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    AI_API_KEY: "", AI_BASE_URL: "https://provider.invalid", AI_MODEL: "synthetic-phase009",
    AI_MOCK: "true", AI_TIMEOUT_MS: "60000", AI_DAILY_COST_LIMIT: "5",
    ...extra,
  };
}

export function terminateChild(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else child.kill("SIGTERM");
}

export async function command(label, args, { cwd = root, expected = 0, env = {}, executable = process.execPath, stdin = "", timeoutMs = 600_000 } = {}) {
  const started = Date.now();
  let processStarted = false;
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd, env: environment(env), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      processStarted = Number.isInteger(child.pid);
      let stdout = "", stderr = "", timedOut = false;
      const timer = setTimeout(() => { timedOut = true; terminateChild(child); }, timeoutMs);
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (exitCode, signal) => {
        clearTimeout(timer);
        resolve({ command: redact(label), executable, arguments: args.map(redact), cwd, exitCode, signal, timedOut, stdout: redact(stdout), stderr: redact(stderr), durationMs: Date.now() - started });
      });
    });
  } catch (error) {
    result = {
      command: redact(label), executable, arguments: args.map(redact), cwd, exitCode: null,
      signal: null, timedOut: false, processStarted, stdout: "", stderr: redact(error.stack ?? error),
      durationMs: Date.now() - started,
    };
    if (commandObserver) commandObserver(result);
    const failure = new Error(`${result.command} did not return a process result: ${result.stderr}`);
    failure.observation = result;
    throw failure;
  }
  if (commandObserver) commandObserver(result);
  if (!label.startsWith("docker inspect ") && !label.startsWith("docker network inspect ") && !label.startsWith("docker exec ")) {
    console.warn(JSON.stringify({ command: result.command, exitCode: result.exitCode, durationMs: result.durationMs }));
  }
  if (result.timedOut || (expected !== null && result.exitCode !== expected)) {
    const error = new Error(`${result.command} failed: ${result.stdout}\n${result.stderr}`);
    error.observation = result;
    throw error;
  }
  return result;
}

export const npm = (args, options) => command(`npm ${args.join(" ")}`, [npmCli, ...args], options);
export const docker = (args, options) => command(`docker ${args.join(" ")}`, args, { ...options, executable: "docker.exe" });

export async function assertDatabaseTarget(config = dbConfig(), url = config.url) {
  assert.match(config.runId, /^[a-f0-9]{12}$/);
  assert.equal(config.database, `phase009_disposable_${config.runId}`);
  assert.equal(config.user, "phase009_runner");
  assert.equal(config.network, `serendipity-phase009-${config.runId}`);
  assert.equal(config.containerName, `serendipity-phase009-${config.runId}`);
  assert(Number.isInteger(config.port) && config.port > 0 && config.port <= 65535);
  const parsed = new URL(url);
  assert.equal(parsed.protocol, "postgresql:");
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.port, String(config.port));
  assert.equal(parsed.username, config.user);
  assert.equal(parsed.password, config.password);
  const database = parsed.pathname.slice(1);
  assert(database === config.database || database.startsWith(`${config.database}_`));
  assert.match(database, /^phase009_disposable_[a-f0-9]{12}(?:_[a-z0-9_]+)?$/);
  assert(database.length <= 63, "PostgreSQL database name would be truncated");
  assert(!/prod|live/i.test(database));
  assert.equal(config.image, imageDigest);
  const observed = await docker(["inspect", "--format", '{{json .Config.Labels}}|{{json .NetworkSettings.Ports}}|{{.Config.Image}}|{{.State.Running}}|{{json .NetworkSettings.Networks}}|{{json .HostConfig.Tmpfs}}', config.containerId]);
  const [labelsText, portsText, image, running, networksText, tmpfsText] = observed.stdout.trim().split("|");
  const labels = JSON.parse(labelsText);
  assert.equal(labels["serendipity.phase"], "009");
  assert.equal(labels["serendipity.run"], config.runId);
  assert.equal(image, imageDigest);
  assert.equal(running, "true");
  assert.deepEqual(JSON.parse(portsText)["5432/tcp"], [{ HostIp: "127.0.0.1", HostPort: String(config.port) }]);
  assert.deepEqual(Object.keys(JSON.parse(networksText)), [config.network]);
  assert.equal(JSON.parse(tmpfsText)["/var/lib/postgresql/data"], "rw,size=536870912");
  const network = await docker(["network", "inspect", "--format", '{{json .Options}}|{{json .Labels}}', config.network]);
  const [optionsText, networkLabelsText] = network.stdout.trim().split("|");
  assert.equal(JSON.parse(optionsText)["com.docker.network.bridge.enable_ip_masquerade"], "false");
  assert.equal(JSON.parse(networkLabelsText)["serendipity.run"], config.runId);
  return {
    database, host: "127.0.0.1", port: config.port, containerId: config.containerId, image: config.image,
    runId: config.runId, marker: `serendipity-phase009-disposable:${config.runId}`,
    networkMasquerading: false, loopbackOnly: true, dataStorage: "TASK_OWNED_TMPFS",
    credentials: "SYNTHETIC_REDACTED", observations: [observed, network],
  };
}

export async function sql(statement, database = dbConfig().database) {
  const config = dbConfig();
  await assertDatabaseTarget(config);
  assert(database === "postgres" || database === config.database || database.startsWith(`${config.database}_`));
  assert.match(database, /^[a-z0-9_]+$/);
  assert(database.length <= 63, "PostgreSQL database name would be truncated");
  return docker(["exec", "-i", config.containerId, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", config.user, "-d", database, "-At"], { stdin: statement });
}

export async function freshDatabase(suffix) {
  const config = dbConfig();
  await assertDatabaseTarget(config);
  assert.match(suffix, /^[a-z0-9_]+$/);
  const database = `${config.database}_${suffix}`;
  assert(database.length <= 63, "PostgreSQL database name would be truncated");
  const created = await sql(`CREATE DATABASE "${database}";`, "postgres");
  const marked = await sql(`COMMENT ON DATABASE "${database}" IS 'serendipity-phase009-disposable:${config.runId}';`, "postgres");
  const url = new URL(config.url);
  url.pathname = `/${database}`;
  return { database, url: url.toString(), observations: [created, marked] };
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
  const parent = path.join(root, ".scaffold/phase009/fixtures");
  fs.mkdirSync(parent, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(parent, `${label}-`));
  const files = ["package.json", "tsconfig.json", "vitest.config.ts", "vitest.setup.ts", ...inventory("src"), ...inventory("tests"), ...inventory("vitest"), ...inventory("prisma")];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(fixture, file));
  }
  fs.symlinkSync(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "junction");
  return fixture;
}

export function removeFixture(fixture) {
  const absolute = fs.realpathSync(fixture);
  assert.equal(path.dirname(absolute), fs.realpathSync(path.join(root, ".scaffold/phase009/fixtures")));
  assert.equal(absolute, path.resolve(fixture));
  const modules = path.join(absolute, "node_modules");
  if (fs.existsSync(modules)) {
    assert(fs.lstatSync(modules).isSymbolicLink());
    fs.unlinkSync(modules);
  }
  fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
