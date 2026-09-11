import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  root, plan, planPath, directory, configPath, imageDigest, json, hash, write,
  docker, sql, redact, assertDatabaseTarget, setCommandObserver,
} from "./phase008-runtime.mjs";

const setupReceiptPath = "docs/evidence/attempts/Phase008/setup/postgresql.json";
const setupCommand = "node docs/phase-plans/setup-phase008.mjs --database";
const startedAt = new Date().toISOString();
const planHash = hash(planPath);
const records = [];
let currentConfig = null;

function redactSetup(value) {
  let text = String(value ?? "");
  for (const secret of [currentConfig?.password, currentConfig?.url]) {
    if (typeof secret === "string" && secret.length > 0) text = text.replaceAll(secret, "<redacted>");
  }
  try {
    return redact(text);
  } catch {
    return "Setup diagnostics withheld because the local redaction configuration is invalid.";
  }
}

function safeObservation(observation) {
  if (!observation || typeof observation !== "object") return null;
  const safe = {};
  for (const field of ["command", "executable", "cwd", "stdout", "stderr", "signal"]) {
    if (Object.hasOwn(observation, field)) {
      safe[field] = observation[field] === null ? null : redactSetup(observation[field]);
    }
  }
  if (Array.isArray(observation.arguments)) safe.arguments = observation.arguments.map(redactSetup);
  for (const field of ["exitCode", "durationMs", "timedOut", "processStarted"]) {
    if (Object.hasOwn(observation, field)) safe[field] = observation[field];
  }
  return safe;
}

async function verifyPostgresql(config, target) {
  const container = await docker(["inspect", "--format", "{{.Id}}", config.containerId]);
  assert.equal(container.stdout.trim(), target.containerId, "The actual container must match its recorded identity");
  const databaseName = await sql("SELECT current_database();");
  assert.equal(databaseName.stdout.trim(), target.database, "The actual database must match its recorded identity");
  const marker = await sql("SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database();");
  assert.equal(marker.stdout.trim(), target.marker);
  const version = await sql("SHOW server_version;");
  assert.match(version.stdout.trim(), /^17\./);
  return { marker: marker.stdout.trim(), version: version.stdout.trim() };
}

function verifySetupReceipt(target, actual) {
  assert(fs.existsSync(path.join(root, setupReceiptPath)), "Existing database configuration requires its immutable setup/postgresql.json receipt");
  const receipt = json(setupReceiptPath);
  assert(receipt.target && typeof receipt.target === "object", "The setup receipt must contain a database target");
  for (const field of ["runId", "containerId", "database", "host", "port", "image", "marker", "networkMasquerading", "loopbackOnly", "dataStorage", "credentials"]) {
    assert.equal(receipt.target[field], target[field], `The setup receipt target ${field} must match the actual database`);
  }
  assert.equal(receipt.marker, actual.marker);
  assert.equal(receipt.version, actual.version);
  assert.equal(receipt.image, imageDigest);
  assert.equal(receipt.syntheticUsers, true);
  assert.equal(receipt.productionTraffic, false);
  assert.equal(receipt.dataStorage, "TASK_OWNED_TMPFS");
  assert.equal(receipt.loopbackOnly, true);
  assert.equal(receipt.networkMasquerading, false);
  assert(Array.isArray(receipt.records) && receipt.records.length > 0, "The setup receipt must retain its original command observations");
}

async function database() {
  if (fs.existsSync(path.join(root, configPath))) {
    const config = json(configPath);
    currentConfig = config;
    const target = await assertDatabaseTarget(config);
    const actual = await verifyPostgresql(config, target);
    verifySetupReceipt(target, actual);
    return;
  }
  assert(!fs.existsSync(path.join(root, setupReceiptPath)), "A setup receipt without its local configuration requires explicit recovery");
  const runId = randomBytes(6).toString("hex");
  const config = {
    runId, image: imageDigest, user: "phase008_runner", password: randomBytes(24).toString("hex"),
    database: `phase008_disposable_${runId}`, network: `serendipity-phase008-${runId}`,
    containerName: `serendipity-phase008-${runId}`,
  };
  currentConfig = config;
  await docker(["image", "inspect", "--format", "{{json .RepoDigests}}", imageDigest]);
  await docker(["network", "create", "--opt", "com.docker.network.bridge.enable_ip_masquerade=false", "--label", `serendipity.run=${runId}`, config.network]);
  const created = await docker([
    "run", "--detach", "--name", config.containerName, "--label", "serendipity.phase=008", "--label", `serendipity.run=${runId}`,
    "--network", config.network, "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data:rw,size=536870912",
    "--env", "POSTGRES_USER", "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_DB", imageDigest,
  ], { env: { POSTGRES_USER: config.user, POSTGRES_PASSWORD: config.password, POSTGRES_DB: config.database } });
  config.containerId = created.stdout.trim();
  const port = await docker(["port", config.containerId, "5432/tcp"]);
  assert.match(port.stdout.trim(), /^127\.0\.0\.1:\d+$/);
  config.port = Number(port.stdout.trim().split(":")[1]);
  config.url = `postgresql://${config.user}:${config.password}@127.0.0.1:${config.port}/${config.database}?connect_timeout=3`;
  write(configPath, config);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await docker(["exec", config.containerId, "pg_isready", "-U", config.user, "-d", config.database], { expected: null });
    if (result.exitCode === 0) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(ready, "Disposable PostgreSQL did not start");
  const target = await assertDatabaseTarget(config);
  await sql(`COMMENT ON DATABASE "${config.database}" IS 'serendipity-phase008-disposable:${runId}';`, "postgres");
  const actual = await verifyPostgresql(config, target);
  write(setupReceiptPath, {
    records, target, ...actual,
    syntheticUsers: true, productionTraffic: false, image: imageDigest,
    dataStorage: "TASK_OWNED_TMPFS", loopbackOnly: true, networkMasquerading: false,
  });
}

setCommandObserver((observation) => records.push(safeObservation(observation)));

try {
  assert(process.argv.includes("--database"), "Use --database");
  await database();
} catch (error) {
  const failurePath = `${directory}/attempt.json`;
  if (!fs.existsSync(path.join(root, failurePath))) {
    try {
      write(failurePath, {
        phase: 8, attemptId: plan.attemptId, status: "FAIL", blockedCategory: "ENV",
        artifactCommit: null, planHash, command: setupCommand, exitCode: 1,
        reason: redactSetup(error.stack ?? error), observation: safeObservation(error.observation),
        records, startedAt, recordedAt: new Date().toISOString(),
      });
    } catch (recordingError) {
      if (recordingError.code !== "EEXIST") console.error(redactSetup(recordingError.stack ?? recordingError));
    }
  }
  console.error(redactSetup(error.stack ?? error));
  process.exitCode = 1;
} finally {
  setCommandObserver(null);
}
