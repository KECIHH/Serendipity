import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const planPath = "docs/phase-plans/Phase005.json";
export const receiptPath = "docs/phase-plans/Phase005-inputs.json";
export const read = (file, base = root) => fs.readFileSync(path.join(base, file));
export const json = (file, base = root) => JSON.parse(read(file, base));
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const hash = (file, base = root) => sha(read(file, base));
export const plan = json(planPath);
export const directory = `docs/evidence/attempts/Phase005/${plan.attemptId}`;
export const npmCli = path.join(root, ".scaffold/tools/node_modules/npm/bin/npm-cli.js");

export function write(file, value, exclusive = true) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    {
      flag: exclusive ? "wx" : "w",
    },
  );
}

export function git(args, encoding = "utf8") {
  const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: root,
    windowsHide: true,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}

export function environment(extra = {}) {
  const env = { ...process.env };
  const inheritedPath = env.Path ?? env.PATH;
  for (const key of Object.keys(env)) {
    if (/^(path|node_env|next_private_test_version|psmodulepath|npm_config_.+)$/i.test(key))
      delete env[key];
  }
  const tools = path.join(root, ".scaffold/tools");
  return {
    ...env,
    Path: `${path.join(tools, "node_modules/.bin")}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${inheritedPath}`,
    CI: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_USERCONFIG: path.join(tools, "npmrc"),
    NPM_CONFIG_GLOBALCONFIG: path.join(tools, "global-npmrc"),
    NPM_CONFIG_CACHE: path.join(tools, "cache"),
    PLAYWRIGHT_BROWSERS_PATH: path.join(tools, "browsers"),
    DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:5432/phase005_test",
    AUTH_SECRET: "phase005-synthetic-auth-secret-32-characters",
    ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
    AI_API_KEY: "",
    AI_BASE_URL: "https://provider.invalid",
    AI_MODEL: "synthetic-phase005",
    AI_MOCK: "true",
    AI_TIMEOUT_MS: "60000",
    AI_DAILY_COST_LIMIT: "5",
    ...extra,
  };
}

export async function command(
  label,
  args,
  { cwd = root, expected = 0, env = {}, executable = process.execPath } = {},
) {
  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: environment(env),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${label} timed out`));
    }, 900_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        command: label,
        executable,
        arguments: args,
        cwd,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
  });
  console.warn(
    JSON.stringify({ command: label, exitCode: result.exitCode, durationMs: result.durationMs }),
  );
  if (expected !== null && result.exitCode !== expected) {
    const error = new Error(`${label} failed: ${result.stdout}\n${result.stderr}`);
    error.observation = result;
    throw error;
  }
  return result;
}

export const npm = (args, options) => command(`npm ${args.join(" ")}`, [npmCli, ...args], options);

export function inventory(relative, base = root) {
  const start = path.join(base, relative);
  if (!fs.existsSync(start)) return [];
  return fs.readdirSync(start, { withFileTypes: true }).flatMap((entry) => {
    const child = `${relative}/${entry.name}`;
    return entry.isDirectory() ? inventory(child, base) : [child];
  });
}

export function copyFixture(label) {
  const temporaryParent = fs.realpathSync(os.tmpdir());
  const fixture = fs.mkdtempSync(path.join(temporaryParent, `serendipity-phase005-${label}-`));
  const files = new Set([
    ...plan.sourcePaths,
    ".env.example",
    "docs/env-registry.json",
    "scripts/eslint-env.mjs",
    ...inventory("public"),
  ]);
  for (const file of files) {
    const target = path.join(fixture, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  fs.symlinkSync(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "junction");
  return fixture;
}

export function removeFixture(fixture) {
  const absolute = fs.realpathSync(fixture);
  assert.equal(path.dirname(absolute), fs.realpathSync(os.tmpdir()));
  assert(path.basename(absolute).startsWith("serendipity-phase005-"));
  assert.equal(absolute, path.resolve(fixture));
  const modules = path.join(absolute, "node_modules");
  if (fs.existsSync(modules)) {
    assert(fs.lstatSync(modules).isSymbolicLink());
    fs.unlinkSync(modules);
  }
  fs.rmSync(absolute, { recursive: true, force: true });
}

async function availablePort(preferred = 3000) {
  const tryPort = (port) =>
    new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const selected = server.address().port;
        server.close(() => resolve(selected));
      });
    });
  try {
    return await tryPort(preferred);
  } catch {
    return await tryPort(0);
  }
}

export async function startServer(mode, cwd = root) {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const args = [
    npmCli,
    "run",
    mode === "production" ? "start" : "dev",
    "--",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ];
  const child = spawn(process.execPath, args, {
    cwd,
    env: environment({ NODE_ENV: mode }),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const observation = {
    command: `npm run ${mode === "production" ? "start" : "dev"} -- --hostname 127.0.0.1 --port ${port}`,
    mode,
    cwd,
    port,
    pid: child.pid,
    stdout: "",
    stderr: "",
    exitCode: null,
  };
  child.stdout.on("data", (chunk) => {
    observation.stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    observation.stderr += chunk.toString();
  });
  let exitCode;
  child.on("close", (code) => {
    exitCode = code;
    observation.exitCode = code;
  });
  const stop = async () => {
    if (exitCode !== undefined) return;
    if (process.platform === "win32") {
      const stopped = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        encoding: "utf8",
      });
      observation.stopExitCode = stopped.status;
    } else child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
  };
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (exitCode !== undefined)
      throw new Error(
        `Server exited before readiness: ${observation.stdout}\n${observation.stderr}`,
      );
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
      if (response.status === 200) return { baseUrl, observation, stop };
    } catch {
      /* A bounded wait for this synthetic local server only. */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await stop();
  throw new Error(`Server did not become ready: ${observation.stdout}\n${observation.stderr}`);
}

export async function httpMatrix(baseUrl, rows) {
  const observed = [];
  for (const [pathname, expectedStatus] of rows) {
    const url = `${baseUrl}${pathname}`;
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const body = await response.text();
    const headers = Object.fromEntries(response.headers);
    const curl = await command(
      `curl.exe -s -o NUL -w %{http_code} ${url}`,
      ["-s", "-o", process.platform === "win32" ? "NUL" : "/dev/null", "-w", "%{http_code}", url],
      { executable: process.platform === "win32" ? "curl.exe" : "curl" },
    );
    const observation = {
      pathname,
      status: response.status,
      expectedStatus,
      bodyBytes: Buffer.byteLength(body),
      bodyHash: sha(body),
      headers,
      curl,
    };
    observed.push(observation);
    assert.equal(response.status, expectedStatus, `${pathname}: status`);
    assert.equal(curl.stdout, String(expectedStatus), `${pathname}: curl status`);
    if (expectedStatus === 404) {
      assert.equal(body, "", `${pathname}: the deny-all response body must be empty`);
      assert(
        !Object.keys(headers).some((key) => key === "location" || key.startsWith("x-")),
        `${pathname}: identifying response header`,
      );
      assert(!/AI 配置|审计日志|概览/.test(body));
    }
  }
  return observed;
}
