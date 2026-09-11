import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  requirePhase010Preflight,
  requirePhase010Generation,
  requirePhase010FailureChain,
  requirePhase010ImplementationBinding,
  getPhase010ImplementationSnapshot,
} from "./phase010-evidence.mjs";
import {
  requireHashCoverage,
  requireReportBinding,
  requirePriorCaseBinding,
} from "../../scripts/phase-evidence.mjs";
import {
  root, plan, planPath, receiptPath, directory, configPath, generationPath, migrationPath,
  read, json, sha, hash, write, git, npm, command, dbConfig, assertDatabaseTarget,
  freshDatabase, sql, copyFixture, removeFixture, inventory, setCommandObserver,
  scanSensitiveText, safeDiagnostics, redact,
} from "./phase010-runtime.mjs";

const requiredKeys = ["migration", "first-seed", "repeated-seed", "concurrent-seed", "secret-privilege", "governance-absence"];
const requiredSupportingChecks = ["lint", "typecheck", "test", "format-check", "build", "project-layout", "phase003-regression", "phase006-user-regression", "phase007-config-regression", "phase008-data-regression", "phase009-audit-regression", "evidence-binding", "dependency-versions", "prisma-cli-network-isolation", "secret-and-scope-scan", "validator-regression", "phase010-evidence-guards"];
const options = process.argv.slice(2);
const key = options[0] === "--case" ? options[1] : null;
const item = plan.cases.find((entry) => entry.testCaseId === `Phase010:${key}`);
const isQuality = options.length === 1 && options[0] === "--quality";
const runnerCommand = item?.command ?? "node docs/phase-plans/verify-phase010.mjs --quality";
const startedAt = new Date().toISOString();
const startPlanHash = hash(planPath);
const observations = [];
const artifacts = [];
const legacyCanaries = ["recursive", "database", "exception"].map((label) => `private-${sha(`phase009:${label}`)}`);
const tables = ["User", "SystemConfig", "TravelRecord", "ChatMessage", "AuditLog", "ApiKeyConfig"];
const sourceHashes = () => Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(file)]));

function scan(value, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  scanSensitiveText(text, label);
  assert(legacyCanaries.every((canary) => !text.includes(canary)), "SECRET_SCAN_REJECTED: LEGACY_PRIVATE_CANARY");
  return { hits: 0, scannedBeforeRedaction: true };
}

function archive(name, value) {
  scan(value, name);
  const file = `${directory}/${name}`;
  write(file, value);
  artifacts.push({ path: file, sha256: hash(file) });
  return file;
}

function artifact(file) {
  scan(read(file).toString(), file);
  const entry = { path: file, sha256: hash(file) };
  artifacts.push(entry);
  return entry;
}

function readRawReport(file) {
  assert(fs.existsSync(file), "A required raw report was not produced");
  const raw = fs.readFileSync(file, "utf8");
  scan(raw, path.basename(file));
  // Any secret is a failure before this conversion, including for deliberately failing tests.
  return JSON.parse(redact(raw));
}

async function assertIdentity(url = dbConfig().url) {
  const target = await assertDatabaseTarget(dbConfig(), url);
  const identity = await sql("SELECT current_database(), current_setting('server_version'), shobj_description(oid, 'pg_database') FROM pg_database WHERE datname=current_database();", target.database);
  const [database, version, marker] = identity.stdout.trim().split("|");
  assert.equal(database, target.database);
  assert.match(version, /^17\./);
  assert.equal(marker, target.marker);
  return { ...target, version };
}

function appUrl(url) {
  const result = new URL(dbConfig().appUrl);
  result.pathname = new URL(url).pathname;
  return result.toString();
}

async function grantRuntime(url) {
  const target = await assertIdentity(url);
  await sql(`REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO phase010_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "User", "SystemConfig", "TravelRecord", "ChatMessage", "ApiKeyConfig" TO phase010_app;
GRANT SELECT, INSERT ON TABLE "AuditLog" TO phase010_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "AuditLog" FROM phase010_app;
GRANT SELECT ON TABLE "_prisma_migrations" TO phase010_app;`, target.database);
  const privileges = await sql("SELECT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR d.datdba=r.oid) FROM pg_roles r CROSS JOIN pg_database d WHERE r.rolname='phase010_app' AND d.datname=current_database();", target.database);
  assert.equal(privileges.stdout.trim(), "f");
}

async function deploy(url, cwd = root, grant = true) {
  await assertIdentity(url);
  await npm(["exec", "--", "prisma", "migrate", "deploy"], { cwd, env: { DATABASE_URL: url } });
  if (grant) await grantRuntime(url);
}

async function migrationStatus(url, cwd = root) {
  await assertIdentity(url);
  const record = await npm(["exec", "--", "prisma", "migrate", "status"], { cwd, env: { DATABASE_URL: url } });
  assert.match(record.stdout, /Database schema is up to date/);
}

async function disposeDatabase(database) {
  assert(database.startsWith(`${dbConfig().database}_`));
  assert.match(database, /^phase010_disposable_[a-f0-9]{12}_[a-z0-9_]+$/);
  assert(database.length <= 63);
  await sql(`DROP DATABASE "${database}" WITH (FORCE);`, "postgres");
}

function verifyMigrationBinding() {
  const generation = json(generationPath);
  requirePhase010Generation(generation, { receipt: json(receiptPath), hashFile: hash, readText: (file) => read(file).toString(), migrationPath });
  return generation;
}

function baselineFixture() {
  const fixture = copyFixture("phase009-replay");
  const receipt = json(receiptPath);
  const original = git(["show", `${receipt.phaseStartCommit}:prisma/schema.prisma`], null);
  assert.equal(sha(original), receipt.prerequisites.schemaHash);
  fs.writeFileSync(path.join(fixture, "prisma/schema.prisma"), original);
  const current = inventory("prisma/migrations", fixture).filter((file) => /\/\d{14}_api_key_config\/migration\.sql$/.test(file));
  assert.deepEqual(current, [migrationPath]);
  const absolute = path.resolve(fixture, current[0]);
  assert(absolute.startsWith(path.resolve(fixture, "prisma/migrations") + path.sep));
  fs.unlinkSync(absolute);
  fs.rmdirSync(path.dirname(absolute));
  return fixture;
}

async function verifyMigration() {
  const generation = verifyMigrationBinding();
  const target = await assertIdentity();
  await npm(["run", "db:migrate", "--", "--name", "api_key_config", "--skip-generate"], { env: { DATABASE_URL: dbConfig().url } });
  await grantRuntime(dbConfig().url);
  await migrationStatus(dbConfig().url);
  await npm(["run", "db:generate"], { env: { DATABASE_URL: dbConfig().url } });
  const replay = await freshDatabase(`a${plan.attemptId.split("-")[1]}_replay`);
  const fixture = baselineFixture();
  let preservedRowFingerprints;
  try {
    await deploy(replay.url, fixture, false);
    const beforeTables = await sql("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;", replay.database);
    assert.deepEqual(beforeTables.stdout.trim().split(/\r?\n/), ["AuditLog", "ChatMessage", "SystemConfig", "TravelRecord", "User", "_prisma_migrations"]);
    await sql(`INSERT INTO "User" (id,email,"passwordHash","updatedAt") VALUES ('preserved-user','preserved@phase010.invalid','synthetic-unusable-fixture',NOW());
INSERT INTO "SystemConfig" (id,key,"valueJson",description,"group","updatedAt") VALUES ('preserved-config','phase010.preserved','{"enabled":false}','Synthetic preserved config','GENERAL',NOW());
INSERT INTO "TravelRecord" (id,"userId",title,"updatedAt") VALUES ('preserved-record','preserved-user','Synthetic preserved record',NOW());
INSERT INTO "ChatMessage" (id,"travelRecordId",role,kind,content,sequence) VALUES ('preserved-message','preserved-record','USER','TEXT','Synthetic preserved message',1);
INSERT INTO "AuditLog" (id,action,"targetType","targetId","detailJson") VALUES ('preserved-audit','CONFIG_UPDATE','SystemConfig','preserved-config','{"systemActor":"SCHEDULER","result":"SUCCESS"}');`, replay.database);
    const query = tables.filter((table) => table !== "ApiKeyConfig").map((table) => `SELECT '${table}' AS name,encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') AS fingerprint FROM "${table}" t`).join(" UNION ALL ") + " ORDER BY 1,2;";
    const before = await sql(query, replay.database);
    await deploy(replay.url);
    const after = await sql(query, replay.database);
    assert.equal(after.stdout, before.stdout, "Earlier domain rows changed during migration");
    preservedRowFingerprints = before.stdout.trim().split(/\r?\n/);
    assert.equal(preservedRowFingerprints.length, 5);
    const applied = await sql('SELECT migration_name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name;', replay.database);
    assert.deepEqual(applied.stdout.trim().split(/\r?\n/), [...generation.previousMigrations, { path: migrationPath, sha256: generation.migrationHash }].map((entry) => `${entry.path.split("/")[2]}|${entry.sha256}`));
    await migrationStatus(replay.url);
    const diff = await npm(["exec", "--", "prisma", "migrate", "diff", "--from-schema-datasource", "prisma/schema.prisma", "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code"], { env: { DATABASE_URL: replay.url } });
    assert.match(diff.stdout, /No difference detected/);
    const keyRows = await sql('SELECT count(*) FROM "ApiKeyConfig";', replay.database);
    assert.equal(keyRows.stdout.trim(), "0");
  } finally {
    try { await disposeDatabase(replay.database); }
    finally { removeFixture(fixture); }
  }
  return { target, schemaHash: hash("prisma/schema.prisma"), migrationHash: generation.migrationHash, preservedRowFingerprints, preservedTables: 5, previousMigrationsPreserved: 4, runtimeRole: "phase010_app", migrationRole: "phase010_runner", runtimeOwner: false, runtimeSuperuser: false };
}

async function runVitest(label, { cwd = root, files = ["seed", "api-key-schema"], pattern, legacy = false, expected = 0, minimum = 1 } = {}) {
  assert.match(label, /^[a-z0-9-]+$/);
  const rawPath = path.join(root, `.scaffold/phase010/${plan.attemptId}-${label}-vitest.json`);
  assert(!fs.existsSync(rawPath), `Raw report already exists: ${label}`);
  await assertIdentity();
  const args = ["run", "test", "--"];
  if (legacy) args.push("--config", "tests/phase006/vitest.database.config.mjs");
  args.push(...files);
  if (pattern) args.push("-t", pattern);
  args.push("--no-file-parallelism", "--reporter=json", `--outputFile=${rawPath}`);
  const env = {
    DATABASE_URL: dbConfig().url,
    PHASE007_DATABASE_URL: dbConfig().url,
    PHASE008_DATABASE_URL: dbConfig().url,
    PHASE009_DATABASE_URL: dbConfig().url,
    PHASE009_RUNTIME_DATABASE_URL: dbConfig().appUrl,
    PHASE010_FIXTURE_CONFIG: path.join(root, configPath),
  };
  const result = await npm(args, { cwd, env, expected: null });
  const raw = readRawReport(rawPath);
  const reportPath = archive(`${label}-vitest.json`, raw);
  assert(Number.isInteger(result.exitCode) && !result.timedOut, "Tests require a real completed process");
  assert(raw.numTotalTestSuites > 0);
  assert.equal(raw.numRuntimeErrorTestSuites ?? 0, 0, "Test setup/runtime failures are not assertion evidence");
  const assertions = raw.testResults.flatMap((suite) => suite.assertionResults);
  if (expected === 0) {
    assert.equal(result.exitCode, 0, "A required test command failed; see its scanned report");
    assert.equal(raw.success, true);
    assert.equal(raw.numFailedTests, 0);
    assert(raw.numPassedTests >= minimum, "Not all required case assertions ran");
    if (!pattern) assert.equal(raw.numPendingTests, 0, "Required tests must not be skipped");
    if (pattern) assert(assertions.filter((test) => test.status === "passed").every((test) => new RegExp(pattern).test(test.fullName)), "Case selection differs from the frozen command intent");
  } else {
    assert.notEqual(result.exitCode, 0, "Mutation requires an actual nonzero exit");
    assert.equal(raw.success, false);
    assert(raw.numFailedTests >= minimum, "Mutation must fail original assertions");
  }
  return { result, raw, reportPath, assertions };
}

function seedEnvironment(url) {
  const email = `seed-${randomBytes(8).toString("hex")}@example.invalid`;
  const password = `${randomBytes(24).toString("base64url")}Aa1!`;
  const canaryPath = path.join(root, ".scaffold/phase010/seed-canaries.jsonl");
  fs.appendFileSync(canaryPath, JSON.stringify({ email, password }) + "\n");
  return {
    NODE_ENV: "test", DATABASE_URL: appUrl(url), ADMIN_EMAIL: email, ADMIN_INITIAL_PASSWORD: password,
    AUTH_SECRET: undefined, ENCRYPTION_KEY: undefined, AI_API_KEY: undefined, AI_BASE_URL: undefined, AI_MODEL: undefined,
  };
}

async function seedSnapshot(database) {
  const count = await sql(tables.map((table) => `SELECT '${table}' AS name,count(*)::text AS count FROM "${table}"`).join(" UNION ALL ") + " ORDER BY 1;", database);
  const rowCounts = Object.fromEntries(count.stdout.trim().split(/\r?\n/).map((line) => { const [table, value] = line.split("|"); return [table, Number(value)]; }));
  const bytes = await sql(["User", "SystemConfig", "AuditLog"].map((table) => `SELECT '${table}' AS name,encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') AS fingerprint FROM "${table}" t`).join(" UNION ALL ") + " ORDER BY 1,2;", database);
  return { rowCounts, rowFingerprints: bytes.stdout.trim().split(/\r?\n/).filter(Boolean) };
}

function assertSeeded(snapshot) {
  assert.deepEqual(snapshot.rowCounts, { ApiKeyConfig: 0, AuditLog: 4, ChatMessage: 0, SystemConfig: 3, TravelRecord: 0, User: 1 });
  assert.equal(snapshot.rowFingerprints.length, 8);
}

async function observeSeedCase(kind) {
  const disposable = await freshDatabase(`a${plan.attemptId.split("-")[1]}_${kind.replaceAll("-", "_")}`);
  try {
    await deploy(disposable.url);
    const before = await seedSnapshot(disposable.database);
    assert(Object.values(before.rowCounts).every((value) => value === 0));
    const env = seedEnvironment(disposable.url);
    const seed = () => npm(["run", "--silent", "db:seed"], { env });
    let summaries;
    let first = null;
    if (kind === "concurrent-seed") {
      await sql("CREATE FUNCTION seed_gate_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2); RETURN NEW; END; $$; CREATE TRIGGER seed_gate_barrier BEFORE INSERT ON \"User\" FOR EACH ROW EXECUTE FUNCTION seed_gate_barrier();", disposable.database);
      const executions = await Promise.allSettled([seed(), seed()]);
      for (const execution of executions) if (execution.status === "rejected") throw execution.reason;
      const results = executions.map((execution) => execution.value);
      summaries = results.map((result) => JSON.parse(result.stdout));
      assert.deepEqual(summaries.map((value) => value.status).sort(), ["SEEDED", "UNCHANGED"]);
      assert.equal(summaries.reduce((total, value) => total + value.administratorCreated, 0), 1);
      assert.equal(summaries.reduce((total, value) => total + value.configsCreated, 0), 3);
      assert.equal(summaries.reduce((total, value) => total + value.auditsCreated, 0), 4);
      assert(summaries.some((value) => value.retries > 0 && value.retries <= 3), "Concurrent seed must exercise an actual bounded conflict retry");
    } else {
      const result = await seed();
      summaries = [JSON.parse(result.stdout)];
      assert.deepEqual(summaries[0], { status: "SEEDED", administratorCreated: 1, configsCreated: 3, auditsCreated: 4, retries: 0 });
      if (kind === "repeated-seed") {
        first = await seedSnapshot(disposable.database);
        assertSeeded(first);
        summaries.push(JSON.parse((await seed()).stdout));
        assert.deepEqual(summaries[1], { status: "UNCHANGED", administratorCreated: 0, configsCreated: 0, auditsCreated: 0, retries: 0 });
      }
    }
    const after = await seedSnapshot(disposable.database);
    assertSeeded(after);
    if (first) assert.deepEqual(after, first, "Repeated seed changed persisted business or audit bytes");
    await migrationStatus(disposable.url);
    return { before, first, after, summaries, concurrentProcesses: kind === "concurrent-seed" ? 2 : 0, duplicateRows: 0, repeatedChangedRows: first ? 0 : null, plaintextPersistedInEvidence: false };
  } finally { await disposeDatabase(disposable.database); }
}

function scanScope() {
  const receipt = json(receiptPath);
  const previous = git(["show", `${receipt.phaseStartCommit}:prisma/schema.prisma`]).toString();
  const current = read("prisma/schema.prisma").toString();
  const withoutNew = current.replace(/model ApiKeyConfig\s*\{[\s\S]*?\n\}/, "").replace(/enum ApiKeyStatus\s*\{[\s\S]*?\n\}/, "");
  assert.equal(withoutNew.replace(/\s+/g, ""), previous.replace(/\s+/g, ""), "Existing models or enums changed");
  assert.equal((current.match(/model ApiKeyConfig\b/g) ?? []).length, 1);
  assert.equal((current.match(/enum ApiKeyStatus\b/g) ?? []).length, 1);
  assert(!/model\s+(?:Prompt\w*|AiModel\w*|ModelDeployment|Provider\w*|AiOutputRecord)\b/.test(current), "Future governance models appeared");
  const apiModel = current.match(/model ApiKeyConfig\s*\{([\s\S]*?)\n\}/)[1];
  assert(!/\b(?:userId|maskedKey|plainKey|modelName|enabled)\b/.test(apiModel), "Parallel secret or ownership fields appeared");
  assert.deepEqual(inventory("prisma/migrations").filter((file) => file.endsWith("/migration.sql")).sort(), [...receipt.prerequisites.migrations.map((entry) => entry.path), migrationPath].sort());
  for (const entry of receipt.prerequisites.migrations) assert.equal(hash(entry.path), entry.sha256);
  const seed = read("src/server/services/seed-service.ts").toString();
  assert(!/\.(?:user|systemConfig|apiKeyConfig)\.upsert\s*\(|\.apiKeyConfig\.(?:create|update|upsert)\s*\(/.test(seed), "Seed contains an overwrite or key-creation branch");
  const files = ["prisma/schema.prisma", migrationPath, "prisma/seed.ts", "src/server/seed-input.ts", "src/server/services/seed-service.ts", ...inventory("docs/evidence/attempts/Phase010")];
  for (const file of files) scan(read(file).toString(), file);
  scan(observations, "captured command output");
  return { existingModelStructurePreserved: true, previousMigrationsPreserved: 4, temporaryGovernanceModels: 0, parallelSecretFields: 0, generatedSecretHits: 0, encryptedEnvelopeHits: 0, sensitiveEvidenceHits: 0, rawOutputScannedBeforeArchival: true, filesScanned: files.length };
}

async function mutations() {
  const rows = [];
  for (const name of ["create-only", "production-guard"]) {
    const fixture = copyFixture(`mutation-${name}`);
    const file = name === "create-only" ? "src/server/services/seed-service.ts" : "src/server/seed-input.ts";
    const source = read(file, fixture).toString();
    const pattern = name === "create-only" ? "secret-privilege: create-only pre-existing USER remains untouched" : "secret-privilege: production guard rejects even a valid disposable fixture without writes";
    try {
      let mutated;
      if (name === "create-only") {
        const branch = /if \(administrator\) \{[\s\S]*?\} else if \(provenance\.length\) reject\("EXISTING_DATA_CONFLICT"\);/;
        assert.equal((source.match(new RegExp(branch.source, "g")) ?? []).length, 1, "Create-only mutation point changed");
        mutated = source.replace(branch, `if (administrator) {
    const overwritten = await tx.user.update({ where: { id: administrator.id }, data: { role: "ADMIN", status: "ACTIVE", passwordHash } });
    await writeAuditLog(tx, {
      actor: { kind: "SYSTEM", systemActor: "MIGRATION" }, action: "SEED_ADMIN_CREATE", targetType: "User", targetId: overwritten.id,
      detailJson: { result: "SUCCESS", sourceMarker: SEED_SOURCE_MARKER, seedRunId: input.seedRunId, seedFingerprint: administratorFingerprint(overwritten, input) },
    });
  }`);
      } else {
        const guard = /if\s*\(\s*env\.NODE_ENV\s*!==\s*"development"\s*&&\s*env\.NODE_ENV\s*!==\s*"test"\s*\)\s*throw new SeedError\("UNSAFE_TARGET"\);/;
        assert.equal((source.match(new RegExp(guard.source, "g")) ?? []).length, 1, "Production mutation point changed");
        mutated = source.replace(guard, "/* Isolated mutation: the environment guard is removed. */");
      }
      assert.notEqual(mutated, source);
      fs.writeFileSync(path.join(fixture, file), mutated);
      archive(`mutations/${name}.json`, { file, originalHash: sha(source), mutatedHash: sha(mutated), originalTestPattern: pattern, mutation: name === "create-only" ? "Replace only existing-user refusal with a real audited role/status/password update" : "Remove only the NODE_ENV development/test admission guard", productionTraffic: false });
      const failed = await runVitest(`negative-${name}`, { cwd: fixture, files: ["tests/integration/seed.test.ts"], pattern, expected: 1 });
      const failures = failed.assertions.filter((test) => test.status === "failed");
      assert.equal(failures.length, 1, "Only the original targeted assertion must turn red");
      assert(failures[0].fullName.includes(pattern));
      assert(failures[0].failureMessages.some((message) => /expected.*0.*not.*0/i.test(message)), "Mutation must demonstrate the real unsafe CLI succeeded, not a setup or unrelated assertion error");
      rows.push({ mutation: name, sourcePath: file, originalHash: sha(source), underlyingExitCode: failed.result.exitCode, failedTests: 1, failedAssertions: failures.map((test) => test.fullName), reportPath: failed.reportPath });
    } finally { removeFixture(fixture); }
    assert.equal(hash(file), sha(source), "Mutation escaped its isolated source copy");
    const restored = await runVitest(`restored-${name}`, { files: ["tests/integration/seed.test.ts"], pattern });
    assert.equal(restored.raw.numPassedTests, 1);
    rows.at(-1).restoredTests = restored.raw.numPassedTests;
    rows.at(-1).restoredExitCode = restored.result.exitCode;
    rows.at(-1).restoredReportPath = restored.reportPath;
  }
  const restored = await runVitest("restored-card-tests");
  verifyMigrationBinding();
  return { rows, restoredCardTests: restored.raw.numPassedTests, restoredCardReportPath: restored.reportPath, sourceAndAppliedMigrationsUnchanged: true };
}

async function evaluate() {
  if (key === "migration") {
    const migration = await verifyMigration();
    const checked = await runVitest("migration", { files: ["api-key-schema"], pattern: "migration:", minimum: 4 });
    return { ...migration, tests: checked.raw.numPassedTests, scan: scanScope() };
  }
  if (["first-seed", "repeated-seed", "concurrent-seed"].includes(key)) {
    const measured = await observeSeedCase(key);
    const checked = await runVitest(key, { files: ["seed"], pattern: `${key}:`, minimum: key === "first-seed" ? 5 : 2 });
    return { ...measured, tests: checked.raw.numPassedTests, rawOutputScannedBeforeArchival: true };
  }
  if (key === "secret-privilege") {
    const checked = await runVitest(key, { files: ["seed"], pattern: "secret-privilege:", minimum: 7 });
    const negative = await mutations();
    return { tests: checked.raw.numPassedTests, mutations: negative, scan: scanScope() };
  }
  assert.equal(key, "governance-absence");
  const checked = await runVitest(key, { files: ["api-key-schema"], pattern: "governance-absence:" });
  const observedTables = await sql("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;");
  assert.deepEqual(observedTables.stdout.trim().split(/\r?\n/), [...tables, "_prisma_migrations"].sort());
  const keys = await sql('SELECT count(*) FROM "ApiKeyConfig";');
  assert.equal(keys.stdout.trim(), "0");
  return { tests: checked.raw.numPassedTests, modelCount: 6, governanceTables: 0, apiKeyRows: 0, scan: scanScope() };
}

function executionDependencyHashes() {
  const pkg = json("package.json");
  const paths = [
    ...Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).map((name) => `node_modules/${name}/package.json`),
    ".scaffold/tools/node_modules/npm/package.json", ".scaffold/tools/node_modules/npm/bin/npm-cli.js",
    "node_modules/prisma/build/index.js", "node_modules/.prisma/client/schema.prisma",
    "node_modules/vitest/vitest.mjs", "node_modules/tsx/dist/cli.mjs",
    "vitest/stubs/server-only.ts", "scripts/test-phase-input-paths.mjs",
    "scripts/verify-phase003.mjs", "scripts/phase003-evidence.mjs", "scripts/checkpoint-history.mjs",
  ];
  return Object.fromEntries([...new Set(paths)].sort().map((file) => [file, hash(file)]));
}

async function quality(startHashes) {
  const snapshotArgs = { root, plan, receipt: json(receiptPath), git, hashFile: hash, inventory, migrationPath };
  const implementationSnapshot = getPhase010ImplementationSnapshot(snapshotArgs);
  const dependencyHashes = executionDependencyHashes();
  const checks = new Map();
  const checked = (id, details = {}) => { assert(requiredSupportingChecks.includes(id) && !checks.has(id)); checks.set(id, { checkId: id, status: "PASS", ...details }); };
  const pkg = json("package.json"), lock = json("package-lock.json"), runtime = json("docs/runtime-baseline.json");
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.equal(version, runtime.dependencyVersions[name]);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
    assert.equal(json(`node_modules/${name}/package.json`).version, version);
  }
  const nodeVersion = await command("node --version", ["--version"]);
  assert.equal(nodeVersion.stdout.trim(), `v${runtime.runtimePolicy.node}`);
  const npmVersion = await npm(["--version"]);
  assert.equal(npmVersion.stdout.trim(), runtime.runtimePolicy.npm);
  assert.equal(pkg.engines.node, runtime.runtimePolicy.node);
  assert.equal(pkg.engines.npm, runtime.runtimePolicy.npm);
  assert.equal(sha(fs.readFileSync(process.execPath)), runtime.nodeExecutableSha256);
  checked("dependency-versions", { dependencyCount: Object.keys(pkg.dependencies).length + Object.keys(pkg.devDependencies).length, nodeExecutableSha256: runtime.nodeExecutableSha256 });

  await command("Prisma CLI and checkpoint network regression", ["tests/phase010/cli-network.mjs"]);
  const networkPath = `${directory}/cli-network.json`;
  const network = json(networkPath);
  assert.equal(network.status, "PASS");
  assert.equal(network.publicRequestsCompleted, 0);
  assert.equal(network.productionTraffic, false);
  assert.equal(network.guardHash, hash(network.guardPath));
  assert.equal(network.prismaCliHash, hash("node_modules/prisma/build/index.js"));
  assert.deepEqual(network.reports.map((probe) => probe.label), ["disabled", "mutation-enable-checkpoint"]);
  for (const probe of network.reports) { assert.equal(probe.result.exitCode, 0); assert.equal(probe.result.timedOut, false); }
  assert.equal(network.reports[0].publicAttempts.length, 0);
  assert(network.reports[1].publicAttempts.length > 0);
  artifact(networkPath);
  checked("prisma-cli-network-isolation", { reportPath: networkPath });
  for (const script of ["lint", "typecheck"]) { await npm(["run", script]); checked(script); }
  const tests = await runVitest("all-tests", { files: [] });
  checked("test", { reportPath: tests.reportPath, testCount: tests.raw.numPassedTests });
  const count = (pattern) => tests.raw.testResults.filter((suite) => pattern.test(suite.name)).flatMap((suite) => suite.assertionResults).filter((test) => test.status === "passed").length;
  for (const file of ["config-models", "travel-record", "chat-message", "audit-log", "seed", "api-key-schema"]) {
    const suites = tests.raw.testResults.filter((suite) => suite.name.replaceAll("\\", "/").endsWith(`/tests/integration/${file}.test.ts`));
    assert(suites.flatMap((suite) => suite.assertionResults).some((test) => test.status === "passed"), `Missing real integration regression: ${file}`);
  }
  const configRegressionTestCount = count(/config-models\.test|public-user\.test/);
  const dataRegressionTestCount = count(/travel-record\.test|chat-message\.test/);
  const auditRegressionTestCount = count(/audit-log\.test/);
  checked("phase007-config-regression", { testCount: configRegressionTestCount, reportPath: tests.reportPath });
  checked("phase008-data-regression", { testCount: dataRegressionTestCount, reportPath: tests.reportPath });
  checked("phase009-audit-regression", { testCount: auditRegressionTestCount, reportPath: tests.reportPath });
  const user = await runVitest("phase006-user-regression", { files: [], legacy: true });
  checked("phase006-user-regression", { testCount: user.raw.numPassedTests, reportPath: user.reportPath });
  await npm(["run", "format:check"]);
  await npm(["exec", "--", "prettier", "--check", "prisma/seed.ts", "tests/lib/seed.test.ts", "tests/lib/api-key-schema.test.ts", "tests/integration/seed.test.ts", "tests/integration/api-key-schema.test.ts", "tests/phase010/*.{ts,mjs}", "tests/phase006/database.integration.ts", "tests/phase008/data-fixture.ts", "tests/phase009/audit-fixture.ts", "tests/integration/config-models.test.ts", "tests/integration/audit-log.test.ts", "tests/integration/travel-record.test.ts", "tests/lib/audit-log.test.ts"]);
  checked("format-check");
  await npm(["run", "build"]); checked("build");
  await command("node scripts/check-project-layout.mjs", ["scripts/check-project-layout.mjs"]); checked("project-layout");
  await npm(["run", "verify:phase003"]); checked("phase003-regression");
  await command("node scripts/test-phase-input-paths.mjs", ["scripts/test-phase-input-paths.mjs"]);

  const regressionPath = path.join(root, `.scaffold/phase010/${plan.attemptId}-validator-regression.json`);
  assert(!fs.existsSync(regressionPath));
  await command("Dual-shell validator compatibility regression", ["scripts/test-validate-phase.mjs", "--shell", "both", "--case", "root-equality-empty-prefix-local-inputs-history-pass,recovery-history-pass,previous-required-case-removal", "--output", regressionPath]);
  const regression = readRawReport(regressionPath);
  assert.equal(regression.status, "PASS"); assert.equal(regression.caseCount, 3);
  for (const [file, expected] of Object.entries(regression.testedSourceHashes)) assert.equal(hash(file), expected);
  checked("validator-regression", { reportPath: archive("validator-regression.json", regression), caseCount: regression.caseCount });

  const guardsPath = path.join(root, `.scaffold/phase010/${plan.attemptId}-evidence-guards.json`);
  assert(!fs.existsSync(guardsPath));
  await command("Phase010 evidence rejection regression", ["tests/phase010/evidence-guards.mjs", "--output", guardsPath]);
  const guards = readRawReport(guardsPath);
  assert.equal(guards.status, "PASS"); assert.equal(guards.phase, 10);
  requireHashCoverage(guards.testedSourceHashes, ["docs/phase-plans/phase010-evidence.mjs", "docs/phase-plans/phase010-runtime.mjs", "scripts/phase-evidence.mjs", "tests/phase010/evidence-guards.mjs"], hash, "EVIDENCE_GUARD_DEPENDENCY_HASH");
  assert(guards.results.length > 0 && guards.results.every((entry) => entry.status === "PASS"));
  assert.equal(guards.caseCount, guards.results.length);
  checked("phase010-evidence-guards", { reportPath: archive("evidence-guards.json", guards), caseCount: guards.caseCount });

  for (const current of plan.cases) {
    const report = json(current.outputPath);
    requireReportBinding(report, current, startPlanHash, plan.sourcePaths, hash);
    for (const entry of report.details.artifacts) assert.equal(hash(entry.path), entry.sha256);
  }
  const prototype = json(plan.cases[0].outputPath);
  for (const field of ["planHash", "inputHash", "denominator", "numerator", "exitCode"]) {
    const mutated = structuredClone(prototype);
    mutated[field] = ["denominator", "numerator", "exitCode"].includes(field) ? 999 : "0".repeat(64);
    assert.throws(() => requireReportBinding(mutated, plan.cases[0], startPlanHash, plan.sourcePaths, hash), /REPORT_BINDING/);
  }
  checked("evidence-binding", { reports: plan.cases.length, rejectedMutations: 5 });
  const rows = await seedSnapshot(dbConfig().database);
  for (const table of ["User", "SystemConfig", "TravelRecord", "ChatMessage", "ApiKeyConfig"]) assert.equal(rows.rowCounts[table], 0, "A fixture left business rows in the verification database");
  const leaks = await sql(`SELECT count(*) FROM "AuditLog" WHERE ${legacyCanaries.map((canary) => `row_to_json("AuditLog")::text LIKE '%${canary}%'`).join(" OR ")};`);
  assert.equal(leaks.stdout.trim(), "0");
  const scope = scanScope();
  checked("secret-and-scope-scan", scope);
  assert.deepEqual([...checks.keys()].sort(), [...requiredSupportingChecks].sort());
  requireHashCoverage(dependencyHashes, Object.keys(executionDependencyHashes()), hash, "EXECUTION_DEPENDENCY_CHANGED");
  requirePhase010ImplementationBinding(implementationSnapshot, getPhase010ImplementationSnapshot(snapshotArgs));
  return { status: "PASS", planHash: startPlanHash, sourceHashes: startHashes, implementationSnapshot, executionDependencyHashes: dependencyHashes, supportingChecks: plan.supportingChecks, supportingResults: plan.supportingChecks.map((id) => checks.get(id)), observations, artifacts, testCount: tests.raw.numPassedTests, userRegressionTestCount: user.raw.numPassedTests, configRegressionTestCount, dataRegressionTestCount, auditRegressionTestCount, sensitiveDatabaseHits: 0, sensitiveOutputHits: 0, scan: scope, simulation: true, productionTraffic: false };
}

setCommandObserver((observation) => { scan(observation, "command observation"); observations.push(observation); });
try {
  assert(!fs.existsSync(path.join(root, directory, "attempt.json")), "Record and freeze a new attempt after a failure");
  assert.equal(plan.phase, 10);
  assert.deepEqual(plan.requiredCaseIds, requiredKeys.map((name) => `Phase010:${name}`));
  assert.deepEqual(plan.cases.map((entry) => entry.testCaseId), plan.requiredCaseIds);
  assert.deepEqual(plan.supportingChecks, requiredSupportingChecks);
  assert(plan.cases.every((entry) => entry.denominator === 1));
  assert(isQuality || (options.length === 2 && options[0] === "--case" && item), "Pass a frozen --case or --quality");
  assert.equal(hash(`${directory}/frozen-plan.json`), startPlanHash, "Current attempt plan changed after freezing");
  const outputPath = isQuality ? `${directory}/quality.json` : item.outputPath;
  assert(!fs.existsSync(path.join(root, outputPath)), "A completed report cannot be overwritten");
  const receipt = json(receiptPath);
  requirePhase010Preflight(receipt.preflight);
  requirePhase010FailureChain(plan, { readJson: json, hashFile: hash });
  for (const input of receipt.pinnedInputs) assert.equal(hash(input.path), input.sha256);
  for (const previous of plan.previousAttempts) requirePriorCaseBinding(plan, json(previous.planPath), { readJson: json, hashFile: hash });
  verifyMigrationBinding();
  const startHashes = sourceHashes();
  artifact(migrationPath);
  if (isQuality) {
    const report = await quality(startHashes);
    requireHashCoverage(startHashes, plan.sourcePaths, hash, "QUALITY_SOURCE_CHANGED");
    verifyMigrationBinding();
    scan(report, "quality report");
    write(outputPath, report);
    console.warn(JSON.stringify({ status: "PASS", supportingChecks: report.supportingChecks.length, testCount: report.testCount }));
  } else {
    const details = await evaluate();
    requireHashCoverage(startHashes, plan.sourcePaths, hash, "SOURCE_CHANGED_DURING_TEST");
    verifyMigrationBinding();
    const report = { testCaseId: item.testCaseId, command: item.command, status: "PASS", exitCode: 0, numerator: item.denominator, denominator: item.denominator, inputPath: item.inputPath, inputHash: hash(item.inputPath), planHash: startPlanHash, sourceHashes: startHashes, simulation: true, productionTraffic: false, details: { ...details, observations, artifacts } };
    scan(report, "case report");
    write(outputPath, report);
    console.warn(JSON.stringify({ status: "PASS", testCaseId: item.testCaseId }));
  }
} catch (error) {
  const failurePath = `${directory}/attempt.json`;
  if (!fs.existsSync(path.join(root, failurePath))) {
    const safeObservation = error.observation ? safeDiagnostics(JSON.stringify(error.observation)) : null;
    const failure = { phase: 10, attemptId: plan.attemptId, status: "FAIL", artifactCommit: null, command: runnerCommand, exitCode: 1, planHash: startPlanHash, reason: safeDiagnostics(error.stack ?? error), observation: safeObservation === null ? null : (() => { try { return JSON.parse(safeObservation); } catch { return { diagnostics: safeObservation }; } })(), observations, artifacts, startedAt, recordedAt: new Date().toISOString() };
    scan(failure, "failure receipt");
    write(failurePath, failure);
  }
  console.error(safeDiagnostics(error.stack ?? error));
  process.exitCode = 1;
} finally { setCommandObserver(null); }
