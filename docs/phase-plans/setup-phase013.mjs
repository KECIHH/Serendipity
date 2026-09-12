import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  root,
  plan,
  planPath,
  receiptPath,
  directory,
  configPath,
  generationPath,
  imageDigest,
  read,
  json,
  sha,
  hash,
  write,
  git,
  npm,
  inventory,
  copyFixture,
  removeFixture,
  docker,
  sql,
  redact,
  assertDatabaseTarget,
  setCommandObserver,
  freshDatabase,
} from "./phase013-runtime.mjs";
import { requirePhase013Generation } from "./phase013-evidence.mjs";

const setupReceiptPath = "docs/evidence/attempts/Phase013/setup/postgresql.json";
const setupCommand = `node docs/phase-plans/setup-phase013.mjs ${process.argv.includes("--migration") ? "--migration" : "--database"}`;
const startedAt = new Date().toISOString();
const planHash = hash(planPath);
const records = [];
let currentConfig = null;

function redactSetup(value) {
  let text = String(value ?? "");
  for (const secret of [
    currentConfig?.password,
    currentConfig?.url,
    currentConfig?.appPassword,
    currentConfig?.appUrl,
    currentConfig?.authSecret,
    currentConfig?.encryptionKey,
  ]) {
    if (typeof secret === "string" && secret.length > 0)
      text = text.replaceAll(secret, "<redacted>");
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
  assert.equal(
    container.stdout.trim(),
    target.containerId,
    "The actual container must match its recorded identity",
  );
  const databaseName = await sql("SELECT current_database();");
  assert.equal(
    databaseName.stdout.trim(),
    target.database,
    "The actual database must match its recorded identity",
  );
  const marker = await sql(
    "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database();",
  );
  assert.equal(marker.stdout.trim(), target.marker);
  const version = await sql("SHOW server_version;");
  assert.match(version.stdout.trim(), /^17\./);
  return { marker: marker.stdout.trim(), version: version.stdout.trim() };
}

function verifySetupReceipt(target, actual) {
  assert(
    fs.existsSync(path.join(root, setupReceiptPath)),
    "Existing database configuration requires its immutable setup/postgresql.json receipt",
  );
  const receipt = json(setupReceiptPath);
  assert(
    receipt.target && typeof receipt.target === "object",
    "The setup receipt must contain a database target",
  );
  for (const field of [
    "runId",
    "containerId",
    "database",
    "host",
    "port",
    "image",
    "marker",
    "networkMasquerading",
    "loopbackOnly",
    "dataStorage",
    "credentials",
  ]) {
    assert.equal(
      receipt.target[field],
      target[field],
      `The setup receipt target ${field} must match the actual database`,
    );
  }
  assert.equal(receipt.marker, actual.marker);
  assert.equal(receipt.version, actual.version);
  assert.equal(receipt.image, imageDigest);
  assert.equal(receipt.syntheticUsers, true);
  assert.equal(receipt.productionTraffic, false);
  assert.equal(receipt.dataStorage, "TASK_OWNED_TMPFS");
  assert.equal(receipt.loopbackOnly, true);
  assert.equal(receipt.networkMasquerading, false);
  assert(
    Array.isArray(receipt.records) && receipt.records.length > 0,
    "The setup receipt must retain its original command observations",
  );
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
  assert(
    !fs.existsSync(path.join(root, setupReceiptPath)),
    "A setup receipt without its local configuration requires explicit recovery",
  );
  const runId = randomBytes(6).toString("hex");
  const config = {
    runId,
    image: imageDigest,
    user: "phase013_runner",
    password: randomBytes(24).toString("hex"),
    appUser: "phase013_app",
    appPassword: randomBytes(24).toString("hex"),
    authSecret: randomBytes(32).toString("hex"),
    encryptionKey: randomBytes(32).toString("base64"),
    database: `phase013_disposable_${runId}`,
    network: `serendipity-phase013-${runId}`,
    containerName: `serendipity-phase013-${runId}`,
  };
  currentConfig = config;
  await docker(["image", "inspect", "--format", "{{json .RepoDigests}}", imageDigest]);
  await docker([
    "network",
    "create",
    "--opt",
    "com.docker.network.bridge.enable_ip_masquerade=false",
    "--label",
    `serendipity.run=${runId}`,
    config.network,
  ]);
  const created = await docker(
    [
      "run",
      "--detach",
      "--name",
      config.containerName,
      "--label",
      "serendipity.phase=013",
      "--label",
      `serendipity.run=${runId}`,
      "--network",
      config.network,
      "--publish",
      "127.0.0.1::5432",
      "--tmpfs",
      "/var/lib/postgresql/data:rw,size=536870912",
      "--env",
      "POSTGRES_USER",
      "--env",
      "POSTGRES_PASSWORD",
      "--env",
      "POSTGRES_DB",
      imageDigest,
    ],
    {
      env: {
        POSTGRES_USER: config.user,
        POSTGRES_PASSWORD: config.password,
        POSTGRES_DB: config.database,
      },
    },
  );
  config.containerId = created.stdout.trim();
  const port = await docker(["port", config.containerId, "5432/tcp"]);
  assert.match(port.stdout.trim(), /^127\.0\.0\.1:\d+$/);
  config.port = Number(port.stdout.trim().split(":")[1]);
  config.url = `postgresql://${config.user}:${config.password}@127.0.0.1:${config.port}/${config.database}?connect_timeout=3`;
  config.appUrl = `postgresql://${config.appUser}:${config.appPassword}@127.0.0.1:${config.port}/${config.database}?connect_timeout=3`;
  write(configPath, config);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await docker(
      ["exec", config.containerId, "pg_isready", "-U", config.user, "-d", config.database],
      { expected: null },
    );
    if (result.exitCode === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(ready, "Disposable PostgreSQL did not start");
  const target = await assertDatabaseTarget(config);
  await sql(
    `COMMENT ON DATABASE "${config.database}" IS 'serendipity-phase013-disposable:${runId}';`,
    "postgres",
  );
  await sql(
    `CREATE ROLE "${config.appUser}" LOGIN PASSWORD '${config.appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`,
    "postgres",
  );
  const actual = await verifyPostgresql(config, target);
  write(setupReceiptPath, {
    records,
    target,
    ...actual,
    syntheticUsers: true,
    productionTraffic: false,
    image: imageDigest,
    dataStorage: "TASK_OWNED_TMPFS",
    loopbackOnly: true,
    networkMasquerading: false,
  });
}

async function migration() {
  await database();
  const receipt = json(receiptPath);
  if (fs.existsSync(path.join(root, generationPath))) {
    const generation = json(generationPath);
    requirePhase013Generation(generation, {
      receipt,
      hashFile: hash,
      readText: (file) => read(file).toString(),
      migrationPath: generation.generatedMigrationPath,
    });
    return;
  }
  if (plan.migrationPolicy.preparedReceiptPath) {
    const prior = plan.previousAttempts.at(-1);
    assert(prior, "A repair must bind its immutable failed attempt");
    const failure = json(prior.failurePath);
    assert.equal(failure.preparedReceiptPath, generationPath);
    const original = json(failure.originalReceiptPath);
    assert.equal(hash(failure.originalReceiptPath), failure.originalReceiptHash);
    assert.equal(hash(failure.failedMigrationPath), failure.failedMigrationHash);
    assert.equal(hash(failure.failedProtectionPath), failure.failedProtectionHash);
    assert.equal(original.migrationHash, failure.failedMigrationHash);
    assert.equal(original.protectionHash, failure.failedProtectionHash);
    const targetPath = original.generatedMigrationPath;
    assert.equal(
      hash(targetPath),
      failure.failedMigrationHash,
      "An unrecorded migration repair is forbidden",
    );
    const protectionPath = plan.migrationPolicy.protectionPath;
    const protection = read(protectionPath).toString();
    assert(!protection.includes("\r"));
    assert(!/\bCREATE\s+TABLE\b|\bDROP\s+TABLE\b|^\s*TRUNCATE\s/im.test(protection));
    assert.notEqual(
      hash(protectionPath),
      failure.failedProtectionHash,
      "A repair must change the failed SQL",
    );
    write(targetPath, protection.trimEnd() + "\n", false);
    const start = records.length;
    const repair = await freshDatabase("a" + plan.attemptId.split("-")[1] + "_repair");
    let correction;
    try {
      await npm(["exec", "--", "prisma", "migrate", "deploy"], {
        env: { DATABASE_URL: repair.url },
      });
      const status = await npm(["exec", "--", "prisma", "migrate", "status"], {
        env: { DATABASE_URL: repair.url },
      });
      assert.match(status.stdout, /Database schema is up to date/);
      const candidate = JSON.stringify([
        {
          adapterId: "fixture",
          referenceId: "reference",
          candidateId: "candidate",
          configVersion: 1,
          referenceRevision: 1,
          contentHash: "0".repeat(64),
        },
      ]);
      const duplicate = JSON.stringify([...JSON.parse(candidate), ...JSON.parse(candidate)]);
      const observed = await sql(
        "SELECT public.key_rotation_candidates_valid('[]'::jsonb), public.key_rotation_candidates_valid('[{}]'::jsonb), public.key_rotation_candidates_valid('" +
          candidate +
          "'::jsonb), public.key_rotation_candidates_valid('" +
          duplicate +
          "'::jsonb);",
        repair.database,
      );
      assert.equal(
        observed.stdout.trim(),
        "t|f|t|f",
        "Repaired SQL must accept exact candidates and reject malformed/duplicate references",
      );
      correction = {
        emptyCandidateAccepted: true,
        malformedCandidateRejected: true,
        exactCandidateAccepted: true,
        duplicateReferenceRejected: true,
      };
    } finally {
      await sql('DROP DATABASE "' + repair.database + '" WITH (FORCE);', "postgres");
    }
    const generation = {
      ...original,
      migrationHash: hash(targetPath),
      protectionHash: hash(protectionPath),
      records: records.slice(start),
      correction,
      amendment: {
        originalReceiptPath: failure.originalReceiptPath,
        originalReceiptHash: failure.originalReceiptHash,
        failedMigrationPath: failure.failedMigrationPath,
        failedMigrationHash: failure.failedMigrationHash,
        failedProtectionPath: failure.failedProtectionPath,
        failedProtectionHash: failure.failedProtectionHash,
        failedAttemptPath: prior.failurePath,
        failedAttemptHash: prior.failureHash,
        reason:
          "Disambiguate the SQL candidate alias from the PL/pgSQL variable and preserve the original closed-failure evidence.",
      },
    };
    requirePhase013Generation(generation, {
      receipt,
      hashFile: hash,
      readText: (file) => read(file).toString(),
      migrationPath: targetPath,
    });
    write(generationPath, generation);
    console.warn(
      JSON.stringify({
        status: "CONTRACT_REPAIR_VERIFIED_IN_DISPOSABLE_DATABASE",
        migrationPath: targetPath,
        receiptHash: hash(generationPath),
      }),
    );
    return;
  }
  const config = json(configPath);
  const target = await assertDatabaseTarget(config);
  const fixture = copyFixture("prepare-contract");
  const migrationStart = records.length;
  try {
    const previous = git(["show", receipt.phaseStartCommit + ":prisma/schema.prisma"], null);
    assert.equal(sha(previous), receipt.prerequisites.schemaHash);
    for (const entry of receipt.prerequisites.migrations)
      assert.equal(hash(entry.path), entry.sha256);
    assert.equal(
      inventory("prisma/migrations").filter((file) =>
        /\d{14}_key_rotation_contract\/migration\.sql$/.test(file),
      ).length,
      0,
    );
    fs.writeFileSync(path.join(fixture, "prisma/schema.prisma"), previous);
    await npm(["exec", "--", "prisma", "migrate", "deploy"], {
      cwd: fixture,
      env: { DATABASE_URL: config.url },
    });
    const status = await npm(["exec", "--", "prisma", "migrate", "status"], {
      cwd: fixture,
      env: { DATABASE_URL: config.url },
    });
    assert.match(status.stdout, /Database schema is up to date/);
    const tables = await sql(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;",
    );
    assert.deepEqual(tables.stdout.trim().split(/\r?\n/), [
      "AdminCommandReceipt",
      "ApiKeyConfig",
      "AuditLog",
      "AuthLoginAttempt",
      "AuthSession",
      "ChatMessage",
      "KeyRotationRun",
      "SystemConfig",
      "TravelRecord",
      "User",
      "_prisma_migrations",
    ]);
    const schema = read("prisma/schema.prisma").toString();
    assert(!schema.includes("\r"), "Normalize schema to LF before recording its hash");
    assert.equal(
      hash("prisma/schema.prisma"),
      receipt.prerequisites.schemaHash,
      "This custom-trigger repair must preserve the existing Prisma model contract",
    );
    const diff = await npm(
      [
        "exec",
        "--",
        "prisma",
        "migrate",
        "diff",
        "--from-schema-datamodel",
        path.join(fixture, "prisma/schema.prisma"),
        "--to-schema-datamodel",
        path.join(root, "prisma/schema.prisma"),
        "--script",
      ],
      { env: { DATABASE_URL: config.url } },
    );
    assert.match(diff.stdout, /empty migration/i);
    const schemaDiffPath = "docs/evidence/attempts/Phase013/setup/schema-diff.sql";
    write(schemaDiffPath, diff.stdout.replaceAll("\r\n", "\n"));
    const protectionPath = plan.migrationPolicy.protectionPath;
    const protection = read(protectionPath).toString();
    assert(!protection.includes("\r"), "Normalize SQL protection to LF before recording its hash");
    assert(
      !/\bCREATE\s+TABLE\b|\bDROP\s+TABLE\b|^\s*TRUNCATE\s/im.test(protection),
      "Only existing-table contract repairs are permitted",
    );
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 14);
    const generatedMigrationPath =
      "prisma/migrations/" + timestamp + "_key_rotation_contract/migration.sql";
    write(generatedMigrationPath, protection.trimEnd() + "\n");
    const generation = {
      generatedMigrationPath,
      migrationHash: hash(generatedMigrationPath),
      schemaPath: "prisma/schema.prisma",
      schemaHash: hash("prisma/schema.prisma"),
      previousSchemaHash: receipt.prerequisites.schemaHash,
      previousMigrations: receipt.prerequisites.migrations,
      target,
      records: records.slice(migrationStart),
      simulation: true,
      productionTraffic: false,
      newTables: 0,
      protectionPath,
      protectionHash: hash(protectionPath),
      schemaDiffPath,
      schemaDiffHash: hash(schemaDiffPath),
      mode: "EXISTING_TABLE_SQL_CONTRACT_REPAIR",
      timestampSource: "CURRENT_UTC_AT_PREPARATION",
      reason: plan.migrationPolicy.rationale,
    };
    requirePhase013Generation(generation, {
      receipt,
      hashFile: hash,
      readText: (file) => read(file).toString(),
      migrationPath: generatedMigrationPath,
    });
    write(generationPath, generation);
    console.warn(
      JSON.stringify({
        status: "CUSTOM_CONTRACT_MIGRATION_PREPARED_NOT_APPLIED",
        migrationPath: generatedMigrationPath,
        receiptHash: hash(generationPath),
      }),
    );
  } finally {
    removeFixture(fixture);
  }
}

setCommandObserver((observation) => records.push(safeObservation(observation)));

try {
  assert(
    process.argv.includes("--database") || process.argv.includes("--migration"),
    "Use --database or --migration",
  );
  if (process.argv.includes("--migration")) await migration();
  else await database();
} catch (error) {
  const failurePath = `${directory}/attempt.json`;
  if (!fs.existsSync(path.join(root, failurePath))) {
    try {
      write(failurePath, {
        phase: 13,
        attemptId: plan.attemptId,
        status: "FAIL",
        blockedCategory: "ENV",
        artifactCommit: null,
        planHash,
        command: setupCommand,
        exitCode: 1,
        reason: redactSetup(error.stack ?? error),
        observation: safeObservation(error.observation),
        records,
        startedAt,
        recordedAt: new Date().toISOString(),
      });
    } catch (recordingError) {
      if (recordingError.code !== "EEXIST")
        console.error(redactSetup(recordingError.stack ?? recordingError));
    }
  }
  console.error(redactSetup(error.stack ?? error));
  process.exitCode = 1;
} finally {
  setCommandObserver(null);
}
