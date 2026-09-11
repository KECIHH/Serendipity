import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { requirePhase009Generation, requirePhase009ImplementationBinding, getPhase009ImplementationSnapshot } from "./phase009-evidence.mjs";
import { requireHashCoverage, requireReportBinding } from "../../scripts/phase-evidence.mjs";
import { root, plan, planPath, receiptPath, directory, read, json, sha, hash, write, git, npm, command, dbConfig, assertDatabaseTarget, freshDatabase, sql, copyFixture, removeFixture, inventory, migrationPath, generationPath, redact } from "./phase009-runtime.mjs";

const observations = [], artifacts = [];
const key = process.argv[process.argv.indexOf("--case") + 1];
const item = plan.cases.find((entry) => entry.testCaseId === `Phase009:${key}`);
const sourceHashes = () => Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(file)]));
const canaries = ["recursive", "database", "exception"].map((label) => `private-${sha(`phase009:${label}`)}`);

function archive(name, content) {
  const file = `${directory}/${name}`;
  write(file, content);
  artifacts.push({ path: file, sha256: hash(file) });
  return file;
}

async function assertIdentity(url) {
  const target = await assertDatabaseTarget(dbConfig(), url);
  const identity = await sql("SELECT current_database(), current_setting('server_version'), shobj_description(oid, 'pg_database') FROM pg_database WHERE datname=current_database();", target.database);
  observations.push(identity);
  const [database, version, marker] = identity.stdout.trim().split("|");
  assert.equal(database, target.database); assert.match(version, /^17\./); assert.equal(marker, target.marker);
  return target;
}

function appUrl(url) {
  const result = new URL(dbConfig().appUrl);
  result.pathname = new URL(url).pathname;
  return result.toString();
}

async function grantRuntime(url) {
  const target = await assertIdentity(url);
  observations.push(await sql(`REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO phase009_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "User", "SystemConfig", "TravelRecord", "ChatMessage" TO phase009_app;
GRANT SELECT, INSERT ON TABLE "AuditLog" TO phase009_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "AuditLog" FROM phase009_app;`, target.database));
}

async function runVitest(label, { cwd = root, files = ["audit-log"], pattern, databaseUrl, expected = 0, legacy = false } = {}) {
  const rawPath = path.join(root, `.scaffold/phase009/${plan.attemptId}-${label}-vitest.json`);
  assert(!fs.existsSync(rawPath), `Raw report already exists: ${label}`);
  const args = ["run", "test", "--"];
  if (legacy) args.push("--config", "tests/phase006/vitest.database.config.mjs");
  args.push(...files);
  if (pattern) args.push("-t", pattern);
  args.push("--reporter=json", `--outputFile=${rawPath}`);
  const env = databaseUrl ? { DATABASE_URL: databaseUrl, PHASE007_DATABASE_URL: databaseUrl, PHASE008_DATABASE_URL: databaseUrl, PHASE009_DATABASE_URL: databaseUrl, PHASE009_RUNTIME_DATABASE_URL: appUrl(databaseUrl) } : {};
  if (databaseUrl) await assertIdentity(databaseUrl);
  const result = await npm(args, { cwd, expected: null, env });
  observations.push(result);
  assert(fs.existsSync(rawPath), "Vitest produced no JSON report");
  const text = redact(fs.readFileSync(rawPath, "utf8"));
  assert(canaries.every((canary) => !text.includes(canary)), "Sensitive fixture appeared in raw test output");
  const raw = JSON.parse(text);
  archive(`${label}-vitest.json`, raw);
  assert(raw.numTotalTestSuites > 0);
  if (expected === 0) {
    assert.equal(result.exitCode, 0, JSON.stringify(raw.testResults.flatMap(result => result.assertionResults).filter(result => result.status === "failed")));
    assert.equal(raw.success, true); assert.equal(raw.numFailedTests, 0); assert(raw.numPassedTests > 0);
    if (!pattern) assert.equal(raw.numPendingTests, 0, "Required integration tests must not be skipped");
  } else {
    assert(Number.isInteger(result.exitCode) && result.exitCode !== 0, "Mutation requires an actual nonzero exit");
    assert.equal(raw.success, false); assert(raw.numFailedTests > 0);
  }
  return { result, raw };
}

async function deploy(url, cwd = root, grant = true) {
  await assertIdentity(url);
  observations.push(await npm(["exec", "--", "prisma", "migrate", "deploy"], { cwd, env: { DATABASE_URL: url } }));
  if (grant) await grantRuntime(url);
}

async function migrationStatus(url, cwd = root) {
  await assertIdentity(url);
  const record = await npm(["exec", "--", "prisma", "migrate", "status"], { cwd, env: { DATABASE_URL: url } });
  observations.push(record); assert.match(record.stdout, /Database schema is up to date/);
}

async function disposeDatabase(database) {
  assert(database.startsWith(`${dbConfig().database}_`));
  assert.match(database, /^phase009_disposable_[a-f0-9]{12}_[a-z0-9_]+$/);
  observations.push(await sql(`DROP DATABASE "${database}" WITH (FORCE);`, "postgres"));
}

function baselineFixture(label) {
  const fixture = copyFixture(label), receipt = json(receiptPath);
  const original = git(["show", `${receipt.phaseStartCommit}:prisma/schema.prisma`], null);
  assert.equal(sha(original), receipt.prerequisites.schemaHash);
  fs.writeFileSync(path.join(fixture, "prisma/schema.prisma"), original);
  for (const file of inventory("prisma/migrations", fixture).filter((entry) => /\/\d{14}_audit_log\/migration\.sql$/.test(entry))) {
    const absolute = path.resolve(fixture, file);
    assert(absolute.startsWith(`${path.resolve(fixture, "prisma/migrations")}${path.sep}`));
    fs.unlinkSync(absolute); fs.rmdirSync(path.dirname(absolute));
  }
  return fixture;
}

async function prepareMigration() {
  assert(!fs.existsSync(path.join(root, generationPath)), "Generation receipt already exists");
  const target = await assertIdentity(dbConfig().url), fixture = baselineFixture("generate");
  try {
    await deploy(dbConfig().url, fixture, false);
    await migrationStatus(dbConfig().url, fixture);
    const tables = await sql("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;");
    observations.push(tables);
    assert.deepEqual(tables.stdout.trim().split(/\r?\n/), ["ChatMessage", "SystemConfig", "TravelRecord", "User", "_prisma_migrations"]);
    fs.writeFileSync(path.join(fixture, "prisma/schema.prisma"), read("prisma/schema.prisma"));
    observations.push(await npm(["run", "db:migrate", "--", "--name", "audit_log", "--create-only", "--skip-generate"], { cwd: fixture, env: { DATABASE_URL: dbConfig().url } }));
    const generated = inventory("prisma/migrations", fixture).filter((file) => /\/\d{14}_audit_log\/migration\.sql$/.test(file));
    assert.equal(generated.length, 1);
    const rawMigrationPath = "docs/evidence/attempts/Phase009/setup/audit_log.generated.sql";
    const raw = read(generated[0], fixture).toString().replaceAll("\r\n", "\n");
    assert.deepEqual([...raw.matchAll(/CREATE TABLE "([^"]+)"/g)].map((match) => match[1]), ["AuditLog"]);
    assert(!/ALTER TABLE "(User|SystemConfig|TravelRecord|ChatMessage)"|DROP\s/i.test(raw));
    write(generated[0], `${raw.trimEnd()}\n\n${read("docs/phase-plans/audit-log-protection.sql").toString().trimEnd()}\n`);
    write(rawMigrationPath, raw);
    write(generationPath, {
      generatedMigrationPath: generated[0], rawMigrationPath, rawMigrationHash: hash(rawMigrationPath), migrationHash: hash(generated[0]),
      schemaPath: "prisma/schema.prisma", schemaHash: hash("prisma/schema.prisma"), previousSchemaHash: json(receiptPath).prerequisites.schemaHash,
      previousMigrations: json(receiptPath).prerequisites.migrations, target, records: observations, simulation: true, productionTraffic: false,
      checksAddedBeforeFirstApplication: ["AuditLog_actor_shape", "AuditLog_metadata_bounds", "AuditLog_append_only", "AuditLog_no_truncate"],
    });
    console.warn(JSON.stringify({ status: "MIGRATION_GENERATED_NOT_APPLIED", migrationPath: generated[0], receiptHash: hash(generationPath) }));
  } finally { removeFixture(fixture); }
}

function verifyMigrationBinding() {
  const generation = json(generationPath);
  requirePhase009Generation(generation, { receipt: json(receiptPath), hashFile: hash, readText: (file) => read(file).toString(), migrationPath });
  return generation;
}

function scanScope() {
  const receipt = json(receiptPath);
  const previous = git(["show", `${receipt.phaseStartCommit}:prisma/schema.prisma`]).toString();
  const current = read("prisma/schema.prisma").toString();
  const withoutAudit = current.replace(/model AuditLog \{[\s\S]*?\n\}/, "").replace(/\s+auditLogs\s+AuditLog\[\]/, "");
  assert.equal(withoutAudit.replace(/\s+/g, ""), previous.replace(/\s+/g, ""), "Existing model scalars or enums changed");
  assert.equal((current.match(/model AuditLog\b/g) ?? []).length, 1);
  for (const entry of receipt.prerequisites.migrations) assert.equal(hash(entry.path), entry.sha256);
  const helper = read("src/server/services/audit-log-service.ts").toString();
  assert(!/from ["']@\/server\/db["']|\.auditLog\.(?:update|delete|upsert)/.test(helper));
  for (const file of inventory("docs/evidence/attempts/Phase009")) {
    const content = read(file).toString();
    assert(canaries.every((canary) => !content.includes(canary)), `Sensitive fixture in evidence: ${file}`);
    assert(!/postgres(?:ql)?:\/\/[^<>\s"']+:[^<>\s"']+@/i.test(content), `Connection credentials in evidence: ${file}`);
  }
  return { existingModelStructurePreserved: true, previousMigrationsPreserved: 3, sensitiveEvidenceHits: 0, publicMutationMethods: 0 };
}

async function verifyMigration() {
  const generation = verifyMigrationBinding();
  const target = await assertIdentity(dbConfig().url);
  observations.push(await npm(["run", "db:migrate", "--", "--name", "audit_log", "--skip-generate"], { env: { DATABASE_URL: dbConfig().url } }));
  await grantRuntime(dbConfig().url);
  await migrationStatus(dbConfig().url);
  observations.push(await npm(["run", "db:generate"], { env: { DATABASE_URL: dbConfig().url } }));
  const replay = await freshDatabase(`a${plan.attemptId.split("-")[1]}_replay`);
  observations.push(...replay.observations);
  const fixture = baselineFixture("replay");
  let fingerprint;
  try {
    await deploy(replay.url, fixture, false);
    observations.push(await sql(`INSERT INTO "User" (id,email,"passwordHash","updatedAt") VALUES ('preserved-user','preserved@phase009.invalid','synthetic-hash-fixture',NOW());
INSERT INTO "SystemConfig" (id,key,"valueJson",description,"group","updatedAt") VALUES ('preserved-config','phase009.preserved','{"enabled":false}','Synthetic preserved config','GENERAL',NOW());
INSERT INTO "TravelRecord" (id,"userId",title,"updatedAt") VALUES ('preserved-record','preserved-user','Synthetic preserved record',NOW());
INSERT INTO "ChatMessage" (id,"travelRecordId",role,kind,content,sequence) VALUES ('preserved-message','preserved-record','USER','TEXT','Synthetic preserved message',1);`, replay.database));
    const query = ["User", "SystemConfig", "TravelRecord", "ChatMessage"].map((name) => `SELECT '${name}',encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') FROM "${name}" t`).join(" UNION ALL ") + ";";
    const before = await sql(query, replay.database); observations.push(before);
    await deploy(replay.url);
    const after = await sql(query, replay.database); observations.push(after);
    assert.equal(after.stdout, before.stdout, "Earlier domain rows changed during migration");
    fingerprint = before.stdout.trim().split(/\r?\n/); assert.equal(fingerprint.length, 4);
    await migrationStatus(replay.url);
    const diff = await npm(["exec", "--", "prisma", "migrate", "diff", "--from-url", replay.url, "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code"], { env: { DATABASE_URL: replay.url } });
    observations.push(diff); assert.match(diff.stdout, /No difference detected/);
  } finally { await disposeDatabase(replay.database); removeFixture(fixture); }
  return { target, schemaHash: hash("prisma/schema.prisma"), migrationHash: generation.migrationHash, preservedRowFingerprints: fingerprint, runtimeRole: "phase009_app", migrationRole: "phase009_runner" };
}

async function mutations() {
  const rows = [];
  for (const name of ["trigger", "sanitizer"]) {
    const disposable = await freshDatabase(`a${plan.attemptId.split("-")[1]}_mut_${name}`);
    observations.push(...disposable.observations);
    const fixture = copyFixture(`mut-${name}`);
    try {
      await deploy(disposable.url);
      let pattern;
      if (name === "trigger") {
        const statement = 'DROP TRIGGER "AuditLog_append_only" ON "AuditLog"; DROP TRIGGER "AuditLog_no_truncate" ON "AuditLog";';
        archive("mutations/trigger.sql", statement + "\n");
        observations.push(await sql(statement, disposable.database));
        pattern = "append-only: trigger rejects";
      } else {
        const file = "src/server/audit-log.ts", source = read(file, fixture).toString();
        assert(source.includes(": redactJson(item)"));
        const mutated = source.replace(": redactJson(item)", ": item").replace("value.map(redactJson)", "value");
        fs.writeFileSync(path.join(fixture, file), mutated);
        archive("mutations/sanitizer.json", { file, originalHash: sha(source), mutatedHash: sha(mutated), change: "Remove object and array recursion from redactJson only" });
        pattern = "recursive-redaction: nested objects";
      }
      const failed = await runVitest(`negative-${name}`, { cwd: fixture, pattern, databaseUrl: disposable.url, expected: 1 });
      const failures = failed.raw.testResults.flatMap((result) => result.assertionResults).filter((result) => result.status === "failed");
      assert.equal(failures.length, name === "trigger" ? 3 : 1);
      assert(failures.every((entry) => entry.fullName.includes(pattern)));
      rows.push({ mutation: name, underlyingExitCode: failed.result.exitCode, failedTests: failures.length, failedAssertions: failures.map((entry) => entry.fullName) });
    } finally { await disposeDatabase(disposable.database); removeFixture(fixture); }
    const restored = await freshDatabase(`a${plan.attemptId.split("-")[1]}_ok_${name}`);
    observations.push(...restored.observations);
    try {
      await deploy(restored.url);
      const passed = await runVitest(`restored-${name}`, { pattern: name === "trigger" ? "append-only: trigger rejects" : "recursive-redaction: nested objects", databaseUrl: restored.url });
      rows.at(-1).restoredTests = passed.raw.numPassedTests;
      await migrationStatus(restored.url);
    } finally { await disposeDatabase(restored.database); }
  }
  const restored = await runVitest("restored-card-tests", { databaseUrl: dbConfig().url });
  return { rows, restoredCardTests: restored.raw.numPassedTests, sourceAndAppliedMigrationsUnchanged: true };
}

async function evaluate() {
  if (key === "schema") {
    const migration = await verifyMigration();
    const checked = await runVitest("schema", { pattern: "schema:", databaseUrl: dbConfig().url });
    return { ...migration, scan: scanScope(), tests: checked.raw.numPassedTests };
  }
  if (key === "mutation") return mutations();
  const checked = await runVitest(key, { pattern: `${key}:`, databaseUrl: dbConfig().url });
  return { tests: checked.raw.numPassedTests };
}

async function quality(startHashes) {
  const snapshotArgs = { root, plan, receipt: json(receiptPath), git, hashFile: hash, inventory, migrationPath };
  const implementationSnapshot = getPhase009ImplementationSnapshot(snapshotArgs);
  for (const input of json(receiptPath).pinnedInputs) assert.equal(hash(input.path), input.sha256);
  const scan = scanScope(), pkg = json("package.json"), lock = json("package-lock.json"), runtime = json("docs/runtime-baseline.json");
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.equal(version, runtime.dependencyVersions[name]); assert.equal(lock.packages[`node_modules/${name}`].version, version);
  }
  const nodeVersion = await command("node --version", ["--version"]); observations.push(nodeVersion); assert.equal(nodeVersion.stdout.trim(), "v24.19.0");
  const npmVersion = await npm(["--version"]); observations.push(npmVersion); assert.equal(npmVersion.stdout.trim(), "11.7.0");
  observations.push(await command("Prisma CLI and checkpoint network regression", ["tests/phase009/cli-network.mjs"]));
  artifacts.push({ path: `${directory}/cli-network.json`, sha256: hash(`${directory}/cli-network.json`) });
  for (const script of ["lint", "typecheck"]) observations.push(await npm(["run", script]));
  const tests = await runVitest("all-tests", { files: [], databaseUrl: dbConfig().url });
  const count = (pattern) => tests.raw.testResults.filter((result) => pattern.test(result.name)).flatMap((result) => result.assertionResults).filter((result) => result.status === "passed").length;
  const configRegressionTestCount = count(/config-models\.test|public-user\.test/);
  const dataRegressionTestCount = count(/travel-record\.test|chat-message\.test/);
  assert(configRegressionTestCount > 0 && dataRegressionTestCount > 0);
  const user = await runVitest("phase006-user-regression", { files: [], legacy: true, databaseUrl: dbConfig().url });
  observations.push(await npm(["run", "format:check"]));
  observations.push(await npm(["exec", "--", "prettier", "--check", "tests/lib/audit-log.test.ts", "tests/integration/audit-log.test.ts", "tests/phase009/*.{ts,mjs}", "tests/integration/config-models.test.ts", "tests/phase006/database.integration.ts", "tests/phase008/data-fixture.ts", "tests/integration/travel-record.test.ts"]));
  observations.push(await npm(["run", "build"]));
  observations.push(await command("node scripts/check-project-layout.mjs", ["scripts/check-project-layout.mjs"]));
  observations.push(await npm(["run", "verify:phase003"]));
  observations.push(await command("node scripts/test-phase-input-paths.mjs", ["scripts/test-phase-input-paths.mjs"]));
  const regressionPath = path.join(root, `.scaffold/phase009/${plan.attemptId}-validator-regression.json`);
  observations.push(await command("Dual-shell validator compatibility regression", ["scripts/test-validate-phase.mjs", "--shell", "both", "--case", "root-equality-empty-prefix-local-inputs-history-pass,recovery-history-pass,previous-required-case-removal", "--output", regressionPath]));
  const regression = JSON.parse(fs.readFileSync(regressionPath, "utf8"));
  assert.equal(regression.status, "PASS"); assert.equal(regression.caseCount, 3);
  for (const [file, expected] of Object.entries(regression.testedSourceHashes)) assert.equal(hash(file), expected);
  archive("validator-regression.json", regression);
  const evidencePath = path.join(root, `.scaffold/phase009/${plan.attemptId}-evidence-guards.json`);
  observations.push(await command("Phase009 evidence rejection regression", ["tests/phase009/evidence-guards.mjs", "--output", evidencePath]));
  const guards = JSON.parse(fs.readFileSync(evidencePath, "utf8")); assert.equal(guards.status, "PASS"); archive("evidence-guards.json", guards);
  const prototype = json(plan.cases[0].outputPath);
  requireReportBinding(prototype, plan.cases[0], hash(planPath), plan.sourcePaths, hash);
  for (const field of ["planHash", "inputHash", "denominator"]) {
    const mutated = structuredClone(prototype); mutated[field] = field === "denominator" ? 999 : "0".repeat(64);
    assert.throws(() => requireReportBinding(mutated, plan.cases[0], hash(planPath), plan.sourcePaths, hash), /REPORT_BINDING/);
  }
  const rows = await sql('SELECT (SELECT count(*) FROM "TravelRecord"), (SELECT count(*) FROM "ChatMessage"), (SELECT count(*) FROM "User"), (SELECT count(*) FROM "SystemConfig");');
  observations.push(rows); assert.equal(rows.stdout.trim(), "0|0|0|0");
  const leaks = await sql(`SELECT count(*) FROM "AuditLog" WHERE ${canaries.map((canary) => `row_to_json("AuditLog")::text LIKE '%${canary}%'`).join(" OR ")};`);
  observations.push(leaks); assert.equal(leaks.stdout.trim(), "0");
  scanScope();
  assert(canaries.every((canary) => !JSON.stringify(observations).includes(canary)), "Sensitive canary in captured stdout/stderr");
  requirePhase009ImplementationBinding(implementationSnapshot, getPhase009ImplementationSnapshot(snapshotArgs));
  return { status: "PASS", planHash: hash(planPath), sourceHashes: startHashes, implementationSnapshot, supportingChecks: plan.supportingChecks, observations, artifacts, testCount: tests.raw.numPassedTests, userRegressionTestCount: user.raw.numPassedTests, configRegressionTestCount, dataRegressionTestCount, sensitiveDatabaseHits: 0, sensitiveOutputHits: 0, scan, simulation: true, productionTraffic: false };
}

try {
  assert(!fs.existsSync(path.join(root, directory, "attempt.json")), "Record and freeze a new attempt after a failure");
  assert.equal(hash(`${directory}/frozen-plan.json`), hash(planPath));
  if (process.argv.includes("--prepare-migration")) await prepareMigration();
  else {
    verifyMigrationBinding();
    const startHashes = sourceHashes();
    artifacts.push({ path: migrationPath, sha256: hash(migrationPath) });
    if (process.argv.includes("--quality")) {
      const report = await quality(startHashes);
      requireHashCoverage(startHashes, plan.sourcePaths, hash, "QUALITY_SOURCE_CHANGED");
      write(`${directory}/quality.json`, report);
      console.warn(JSON.stringify({ status: "PASS", supportingChecks: report.supportingChecks.length, testCount: report.testCount }));
    } else {
      assert(item, "Pass a frozen --case or --quality");
      const details = await evaluate();
      requireHashCoverage(startHashes, plan.sourcePaths, hash, "SOURCE_CHANGED_DURING_TEST"); verifyMigrationBinding();
      write(item.outputPath, { testCaseId: item.testCaseId, command: item.command, status: "PASS", exitCode: 0, numerator: item.denominator, denominator: item.denominator, inputPath: item.inputPath, inputHash: hash(item.inputPath), planHash: hash(planPath), sourceHashes: startHashes, simulation: true, productionTraffic: false, details: { ...details, observations, artifacts } });
      console.warn(JSON.stringify({ status: "PASS", testCaseId: item.testCaseId }));
    }
  }
} catch (error) {
  const failure = `${directory}/attempt.json`;
  if (!fs.existsSync(path.join(root, failure))) write(failure, { phase: 9, attemptId: plan.attemptId, status: "FAIL", artifactCommit: null, command: item?.command ?? `node docs/phase-plans/verify-phase009.mjs ${process.argv.includes("--prepare-migration") ? "--prepare-migration" : "--quality"}`, planHash: hash(planPath), reason: redact(error.stack), observation: error.observation, observations, artifacts, recordedAt: new Date().toISOString() });
  console.error(redact(error.stack)); process.exitCode = 1;
}
