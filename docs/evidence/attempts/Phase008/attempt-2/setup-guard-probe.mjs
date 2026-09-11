import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.cwd();
const setupPath = "docs/phase-plans/setup-phase008.mjs";
const runtimePath = "docs/phase-plans/phase008-runtime.mjs";
const cleanImports = (source) => source.replace(/^import[\s\S]*?;\r?\n/gm, "");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const setupBody = cleanImports(fs.readFileSync(setupPath, "utf8"));
const runId = "1a".repeat(6);
const password = "2b".repeat(24);
const containerId = "f".repeat(64);
const configPath = ".scaffold/phase008/database.json";
const receiptPath = "docs/evidence/attempts/Phase008/setup/postgresql.json";
const directory = "docs/evidence/attempts/Phase008/attempt-test";
const failurePath = directory + "/attempt.json";
const imageDigest = "postgres@sha256:" + "a".repeat(64);
const config = {
  runId, password, containerId, image: imageDigest, user: "phase008_runner",
  database: "phase008_disposable_" + runId, network: "serendipity-phase008-" + runId,
  containerName: "serendipity-phase008-" + runId, port: 45432,
};
config.url = "postgresql://" + config.user + ":" + password + "@127.0.0.1:45432/" + config.database + "?connect_timeout=3";
const target = {
  database: config.database, host: "127.0.0.1", port: config.port, containerId,
  image: imageDigest, runId, marker: "serendipity-phase008-disposable:" + runId,
  networkMasquerading: false, loopbackOnly: true, dataStorage: "TASK_OWNED_TMPFS",
  credentials: "SYNTHETIC_REDACTED", observations: [],
};
const originalReceipt = {
  records: [{ command: "original setup", exitCode: 0 }], target,
  version: "17.6", marker: target.marker, syntheticUsers: true, productionTraffic: false,
  image: imageDigest, dataStorage: "TASK_OWNED_TMPFS", loopbackOnly: true, networkMasquerading: false,
};
const setupFunction = new AsyncFunction(
  "assert", "fs", "path", "randomBytes", "root", "plan", "planPath", "directory",
  "configPath", "imageDigest", "json", "hash", "write", "docker", "sql", "redact",
  "assertDatabaseTarget", "setCommandObserver", "process", "console", setupBody,
);

async function setupCase(options = {}) {
  const memory = new Map();
  const key = (file) => path.resolve(root, file);
  if (!options.fresh) memory.set(key(configPath), structuredClone(config));
  if (!options.missingReceipt && !options.fresh) memory.set(key(receiptPath), structuredClone(originalReceipt));
  if (options.receiptMismatch) memory.get(key(receiptPath)).target[options.receiptMismatch] = "wrong";
  if (options.previousFailure) memory.set(key(failurePath), { status: "FAIL", sentinel: "immutable" });
  let observer = null;
  const commands = [];
  const logs = [];
  const simulatedProcess = { argv: options.noArg ? [] : ["--database"], exitCode: undefined };
  const emit = (label, stdout, exitCode = 0) => {
    const result = {
      command: label, executable: "synthetic-docker", arguments: [label], cwd: root,
      exitCode, signal: null, timedOut: false, stdout, stderr: "", durationMs: 1,
      env: { POSTGRES_PASSWORD: password },
    };
    commands.push(result);
    if (observer) observer(result);
    return result;
  };
  const docker = async (args) => {
    const label = "docker " + args.join(" ");
    if (options.launchFailure && args[0] === "run") {
      const observation = emit(label, "failure " + password, 1);
      const error = new Error("failure " + password);
      error.observation = observation;
      throw error;
    }
    let stdout = "";
    if (args[0] === "run" || (args[0] === "inspect" && args.includes("{{.Id}}"))) stdout = containerId + "\n";
    else if (args[0] === "port") stdout = "127.0.0.1:45432\n";
    return emit(label, stdout);
  };
  const assertDatabaseTarget = async () => {
    await docker(["inspect", "--format", "labels-and-network", containerId]);
    if (options.guardFailure) throw new Error("label mismatch");
    await docker(["network", "inspect", config.network]);
    return structuredClone(target);
  };
  const sql = async (statement) => {
    await assertDatabaseTarget();
    let stdout = "";
    if (statement === "SELECT current_database();") stdout = config.database + "\n";
    else if (statement.startsWith("SELECT shobj_description")) stdout = (options.markerFailure ? "wrong marker" : target.marker) + "\n";
    else if (statement === "SHOW server_version;") stdout = (options.versionFailure ? "16.8" : "17.6") + "\n";
    return emit("docker exec psql", stdout);
  };
  const json = (file) => {
    assert(memory.has(key(file)), "missing in-memory file " + file);
    return structuredClone(memory.get(key(file)));
  };
  const write = (file, value) => {
    if (memory.has(key(file))) {
      const error = new Error("exclusive file exists");
      error.code = "EEXIST";
      throw error;
    }
    memory.set(key(file), structuredClone(value));
  };
  const beforeReceipt = memory.has(key(receiptPath)) ? JSON.stringify(memory.get(key(receiptPath))) : null;
  await setupFunction(
    assert, { existsSync: (file) => memory.has(key(file)) }, path,
    (size) => Buffer.alloc(size, size === 6 ? 0x1a : 0x2b), root,
    { attemptId: "attempt-test" }, "docs/phase-plans/Phase008.json", directory,
    configPath, imageDigest, json, () => "c".repeat(64), write, docker, sql,
    (value) => String(value).replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "postgresql://<redacted>"),
    assertDatabaseTarget, (value) => { observer = value; }, simulatedProcess,
    { error: (value) => logs.push(String(value)) },
  );
  assert.equal(observer, null, "setup must detach its command observer");
  const failure = memory.get(key(failurePath));
  const shouldFail = options.missingReceipt || options.receiptMismatch || options.previousFailure || options.guardFailure || options.launchFailure || options.markerFailure || options.versionFailure || options.noArg;
  if (shouldFail) {
    assert.equal(simulatedProcess.exitCode, 1);
    if (options.previousFailure) assert.deepEqual(failure, { status: "FAIL", sentinel: "immutable" });
    else {
      assert.equal(failure.status, "FAIL");
      assert.equal(failure.blockedCategory, "ENV");
      assert.equal(failure.exitCode, 1);
      assert.equal(failure.phase, 8);
      assert.equal(failure.records.length, commands.length, "every nested command must be recorded exactly once");
      assert.equal(failure.planHash, "c".repeat(64));
      assert(!JSON.stringify(failure).includes(password), "failure evidence leaked generated password");
      assert(!failure.records.some((entry) => Object.hasOwn(entry, "env")), "failure evidence retained environment");
    }
  } else {
    assert.equal(simulatedProcess.exitCode, undefined);
    assert.equal(failure, undefined);
    if (options.fresh) {
      const receipt = memory.get(key(receiptPath));
      assert.equal(receipt.records.length, commands.length);
      assert.equal(receipt.target.runId, runId);
      assert.equal(receipt.version, "17.6");
      assert(!JSON.stringify(receipt).includes(password));
    } else {
      assert.equal(JSON.stringify(memory.get(key(receiptPath))), beforeReceipt, "reuse must not rewrite setup evidence");
    }
  }
}

const cases = [
  {}, { missingReceipt: true }, { receiptMismatch: "runId" }, { receiptMismatch: "containerId" },
  { receiptMismatch: "database" }, { markerFailure: true }, { versionFailure: true },
  { guardFailure: true, previousFailure: true }, { fresh: true, launchFailure: true },
  { fresh: true }, { noArg: true },
];
for (const item of cases) await setupCase(item);

const runtimeBody = cleanImports(fs.readFileSync(runtimePath, "utf8"))
  .replace(/\bexport /g, "")
  .replaceAll("import.meta.url", "moduleUrl") + "\nreturn { command, setCommandObserver };";
const runtimeFunction = new AsyncFunction(
  "assert", "fs", "path", "createHash", "spawn", "spawnSync", "fileURLToPath",
  "moduleUrl", "process", "console", runtimeBody,
);
async function runtimeCase(mode) {
  const virtualFs = {
    existsSync: () => false,
    readFileSync: (file) => {
      assert(file.endsWith("Phase008.json"));
      return Buffer.from(JSON.stringify({ attemptId: "attempt-test" }));
    },
  };
  const spawn = () => {
    const child = new EventEmitter();
    child.pid = mode === "launch" ? undefined : 123;
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (mode === "launch") child.emit("error", new Error("synthetic ENOENT"));
      else {
        child.stdout.emit("data", Buffer.from("observed output"));
        child.emit("close", mode === "nonzero" ? 2 : 0, null);
      }
    });
    return child;
  };
  const runtime = await runtimeFunction(
    assert, virtualFs, path, createHash, spawn, () => {}, fileURLToPath,
    pathToFileURL(path.resolve(runtimePath)).href,
    { env: {}, execPath: process.execPath, platform: process.platform }, { warn: () => {} },
  );
  const observed = [];
  runtime.setCommandObserver((result) => observed.push(result));
  let failure;
  try { await runtime.command("synthetic command", []); } catch (error) { failure = error; }
  assert.equal(observed.length, 1, "runtime must notify once before every return or throw");
  if (mode === "success") assert.equal(failure, undefined);
  else {
    assert(failure);
    assert.equal(failure.observation, observed[0]);
    if (mode === "launch") {
      assert.equal(observed[0].exitCode, null);
      assert.equal(observed[0].processStarted, false);
    } else assert.equal(observed[0].exitCode, 2);
  }
  runtime.setCommandObserver(null);
}
for (const mode of ["success", "nonzero", "launch"]) await runtimeCase(mode);
console.log(JSON.stringify({ status: "PASS", setupCases: cases.length, runtimeCases: 3, databaseCommandsExecuted: 0, filesWritten: 0 }));

