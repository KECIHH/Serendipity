import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  requirePhase012Preflight, requirePhase012Generation, requirePhase012FailureChain,
  requirePhase012ImplementationBinding, getPhase012ImplementationSnapshot,
} from "./phase012-evidence.mjs";
import { requireHashCoverage, requireReportBinding, requirePriorCaseBinding } from "../../scripts/phase-evidence.mjs";
import {
  root, plan, planPath, receiptPath, directory, configPath, generationPath, migrationPath,
  read, json, sha, hash, write, git, npm, command, dbConfig, assertDatabaseTarget,
  freshDatabase, sql, copyFixture, removeFixture, inventory, setCommandObserver,
  scanSensitiveText, safeDiagnostics, redact,
} from "./phase012-runtime.mjs";

const requiredKeys = ["list", "role-status", "self-protection", "last-admin", "session", "authorization-idempotency", "navigation"];
const requiredSupportingChecks = ["lint","typecheck","admin-users-layout","test","format-check","build","project-layout","phase003-regression","phase006-user-regression","phase007-config-regression","phase008-data-regression","phase009-audit-regression","phase010-seed-regression","phase011-auth-regression","migration-schema","api-contract","evidence-binding","dependency-versions","prisma-cli-network-isolation","secret-and-scope-scan","validator-regression","phase012-evidence-guards"];
const options = process.argv.slice(2);
const key = options[0] === "--case" ? options[1] : null;
const item = plan.cases.find((entry) => entry.testCaseId === `Phase012:${key}`);
const isQuality = options.length === 1 && options[0] === "--quality";
const runnerCommand = item?.command ?? "node docs/phase-plans/verify-phase012.mjs --quality";
const startedAt = new Date().toISOString();
const startPlanHash = hash(planPath);
const observations = [];
const artifacts = [];
const tables = ["AdminCommandReceipt", "ApiKeyConfig", "AuditLog", "AuthLoginAttempt", "AuthSession", "ChatMessage", "KeyRotationRun", "SystemConfig", "TravelRecord", "User"];
const sourceHashes = () => Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(file)]));

function scan(value, label) {
  scanSensitiveText(typeof value === "string" ? value : JSON.stringify(value), label);
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
  if (!/\.(?:png|ico|woff2?)$/i.test(file)) scan(read(file).toString(), file);
  const entry = { path: file, sha256: hash(file) };
  artifacts.push(entry);
  return entry;
}

function readRawReport(file) {
  assert(fs.existsSync(file), "A required raw report was not produced");
  const raw = fs.readFileSync(file, "utf8");
  scan(raw, path.basename(file));
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

async function grantRuntime(url) {
  const target = await assertIdentity(url);
  await sql(`REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO phase012_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "User", "SystemConfig", "TravelRecord", "ChatMessage", "ApiKeyConfig" TO phase012_app;
GRANT SELECT, INSERT ON TABLE "AuditLog" TO phase012_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "AuditLog" FROM phase012_app;
GRANT SELECT ON TABLE "_prisma_migrations" TO phase012_app;
GRANT SELECT, INSERT ON TABLE "AuthSession", "AuthLoginAttempt" TO phase012_app;
GRANT UPDATE (status, "lastSeenAt", "revokedAt") ON TABLE "AuthSession" TO phase012_app;
GRANT UPDATE (status, "completedAt") ON TABLE "AuthLoginAttempt" TO phase012_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdminCommandReceipt", "KeyRotationRun" TO phase012_app;
GRANT EXECUTE ON FUNCTION public.auth_now() TO phase012_app;`, target.database);
  const privilege = await sql("SELECT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR d.datdba=r.oid) FROM pg_roles r CROSS JOIN pg_database d WHERE r.rolname='phase012_app' AND d.datname=current_database();", target.database);
  assert.equal(privilege.stdout.trim(), "f");
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
  assert.match(database, /^phase012_disposable_[a-f0-9]{12}_[a-z0-9_]+$/);
  assert(database.length <= 63);
  await sql(`DROP DATABASE "${database}" WITH (FORCE);`, "postgres");
}

function verifyMigrationBinding() {
  const generation = json(generationPath);
  requirePhase012Generation(generation, { receipt: json(receiptPath), hashFile: hash, readText: (file) => read(file).toString(), migrationPath });
  return generation;
}

function baselineFixture() {
  const fixture = copyFixture("phase011-replay");
  const receipt = json(receiptPath);
  const original = git(["show", `${receipt.phaseStartCommit}:prisma/schema.prisma`], null);
  assert.equal(sha(original), receipt.prerequisites.schemaHash);
  fs.writeFileSync(path.join(fixture, "prisma/schema.prisma"), original);
  const current = inventory("prisma/migrations", fixture).filter((file) => /\/\d{14}_admin_commands\/migration\.sql$/.test(file));
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
  await deploy(dbConfig().url);
  await migrationStatus(dbConfig().url);
  await npm(["run", "db:generate"], { env: { DATABASE_URL: dbConfig().url } });
  const replay = await freshDatabase(`a${plan.attemptId.split("-")[1]}_replay`);
  const fixture = baselineFixture();
  let preservedRowFingerprints;
  try {
    await deploy(replay.url, fixture, false);
    const beforeTables = await sql("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;", replay.database);
    assert.deepEqual(beforeTables.stdout.trim().split(/\r?\n/), ["ApiKeyConfig", "AuditLog", "AuthLoginAttempt", "AuthSession", "ChatMessage", "SystemConfig", "TravelRecord", "User", "_prisma_migrations"]);
    await sql(`INSERT INTO "User" (id,email,"passwordHash","updatedAt") VALUES ('preserved-user','preserved@phase012.invalid','synthetic-unusable-fixture',NOW());
INSERT INTO "SystemConfig" (id,key,"valueJson",description,"group","updatedAt") VALUES ('preserved-config','phase012.preserved','{"enabled":false}','Synthetic preserved config','GENERAL',NOW());
INSERT INTO "TravelRecord" (id,"userId",title,"updatedAt") VALUES ('preserved-record','preserved-user','Synthetic preserved record',NOW());
INSERT INTO "ChatMessage" (id,"travelRecordId",role,kind,content,sequence) VALUES ('preserved-message','preserved-record','USER','TEXT','Synthetic preserved message',1);
INSERT INTO "AuditLog" (id,action,"targetType","targetId","detailJson") VALUES ('preserved-audit','CONFIG_UPDATE','SystemConfig','preserved-config','{"systemActor":"SCHEDULER","result":"SUCCESS"}');`, replay.database);
    const previousTables = tables.filter((table) => !["AdminCommandReceipt", "KeyRotationRun"].includes(table));
    const query = previousTables.map((table) => `SELECT '${table}' AS name,encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') AS fingerprint FROM "${table}" t`).join(" UNION ALL ") + " ORDER BY 1,2;";
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
    const newRows = await sql('SELECT (SELECT count(*) FROM "AdminCommandReceipt"),(SELECT count(*) FROM "KeyRotationRun");', replay.database);
    assert.equal(newRows.stdout.trim(), "0|0");
  } finally {
    try { await disposeDatabase(replay.database); }
    finally { removeFixture(fixture); }
  }
  return { target, schemaHash: hash("prisma/schema.prisma"), migrationHash: generation.migrationHash, preservedRowFingerprints, preservedTables: 8, preservedFixtureRows: 5, previousMigrationsPreserved: 6, runtimeRole: "phase012_app", migrationRole: "phase012_runner", runtimeOwner: false, runtimeSuperuser: false };
}

async function runVitest(label, { cwd = root, files = ["tests/admin/users.integration.test.ts"], pattern, legacy = false, expected = 0, minimum = 1 } = {}) {
  assert.match(label, /^[a-z0-9-]+$/);
  const rawPath = path.join(root, `.scaffold/phase012/${plan.attemptId}-${label}-vitest.json`);
  assert(!fs.existsSync(rawPath), `Raw report already exists: ${label}`);
  await assertIdentity();
  const args = ["run", "test", "--"];
  if (legacy) args.push("--config", "tests/phase006/vitest.database.config.mjs");
  args.push(...files);
  if (pattern) args.push("-t", pattern);
  args.push("--no-file-parallelism", "--reporter=default", "--reporter=json", `--outputFile=${rawPath}`);
  const env = {
    DATABASE_URL: dbConfig().appUrl, PHASE007_DATABASE_URL: dbConfig().url,
    PHASE008_DATABASE_URL: dbConfig().url, PHASE009_DATABASE_URL: dbConfig().url,
    PHASE009_RUNTIME_DATABASE_URL: dbConfig().appUrl,
    PHASE010_FIXTURE_CONFIG: path.join(root, configPath), PHASE011_FIXTURE_CONFIG: path.join(root, configPath), PHASE012_FIXTURE_CONFIG: path.join(root, configPath), PHASE012_DATABASE_URL: dbConfig().url, PHASE012_RUNTIME_DATABASE_URL: dbConfig().appUrl,
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
    if (pattern) assert(assertions.filter((test) => test.status === "passed").every((test) => new RegExp(pattern).test(test.fullName)), "Case selection differs from frozen intent");
  } else {
    assert.notEqual(result.exitCode, 0, "Mutation requires an actual nonzero exit");
    assert.equal(raw.success, false);
    assert(raw.numFailedTests >= minimum, "Mutation must fail original assertions");
    assert(assertions.some((test) => test.status === "failed"), "An import failure is not a security assertion");
  }
  return { result, raw, reportPath, assertions };
}

function scanScope() {
  const receipt = json(receiptPath);
  assert.deepEqual(inventory("prisma/migrations").filter((file) => file.endsWith("/migration.sql")).sort(), [...receipt.prerequisites.migrations.map((entry) => entry.path), migrationPath].sort());
  for (const entry of receipt.prerequisites.migrations) assert.equal(hash(entry.path), entry.sha256);
  const schema = read("prisma/schema.prisma").toString();
  assert.deepEqual([...schema.matchAll(/^model (\w+)\s*\{/gm)].map((match) => match[1]).sort(), tables);
  const sourceFiles = [...inventory("src/server/admin"), ...inventory("src/components/admin"), ...inventory("src/app/api/admin"), ...inventory("src/app/admin")];
  const files = [...sourceFiles, "prisma/schema.prisma", migrationPath, ...inventory("docs/evidence/attempts/Phase012")];
  for (const file of files) if (!/\.(?:png|ico|woff2?)$/i.test(file)) scan(read(file).toString(), file);
  scan(observations, "captured command output");
  return { previousMigrationsPreserved: 6, modelCount: tables.length, generatedSecretHits: 0, sensitiveEvidenceHits: 0, rawOutputScannedBeforeArchival: true, filesScanned: files.length };
}

async function mutations() {
  const definitions = [
    { name: "session-increment", file: "src/server/admin/users.ts", before: "sessionVersion: { increment: 1 },", after: "/* Isolated mutation: sessionVersion increment removed. */", pattern: "role-status" },
  ];
  const rows = [];
  for (const definition of definitions) {
    const { name, file, before, after, pattern } = definition;
    const baseline = await runVitest(`baseline-${name}`, { pattern });
    const fixture = copyFixture(`mutation-${name}`);
    const source = read(file, fixture).toString();
    try {
      const matches = typeof before === "string" ? source.split(before).length - 1 : [...source.matchAll(new RegExp(before.source, "g"))].length;
      assert.equal(matches, 1, `Exactly one mutation point must exist: ${name}`);
      const mutated = source.replace(before, after);
      assert.notEqual(mutated, source);
      fs.writeFileSync(path.join(fixture, file), mutated);
      archive(`mutations/${name}.json`, { file, originalHash: sha(source), mutatedHash: sha(mutated), originalTestPattern: pattern, mutation: name, productionTraffic: false });
      const failed = await runVitest(`negative-${name}`, { cwd: fixture, pattern, expected: 1 });
      const failures = failed.assertions.filter((test) => test.status === "failed");
      assert(failures.every((test) => test.fullName.includes(pattern)));
      assert(failures.every((test) => !test.failureMessages.some((message) => /Cannot find module|Failed to resolve|SyntaxError|ReferenceError|beforeAll hook timed out/.test(message))), "Mutation failed setup instead of the original security assertion");
      rows.push({ mutation: name, sourcePath: file, originalHash: sha(source), baselineExitCode: baseline.result.exitCode, baselineReportPath: baseline.reportPath, underlyingExitCode: failed.result.exitCode, failedTests: failures.length, failedAssertions: failures.map((test) => test.fullName), reportPath: failed.reportPath });
    } finally { removeFixture(fixture); }
    assert.equal(hash(file), sha(source), "Mutation escaped its isolated source copy");
    const restored = await runVitest(`restored-${name}`, { pattern });
    rows.at(-1).restoredTests = restored.raw.numPassedTests;
    rows.at(-1).restoredExitCode = restored.result.exitCode;
    rows.at(-1).restoredReportPath = restored.reportPath;
  }
  const restored = await runVitest("restored-admin-tests", { files: ["admin/users", "admin/layout"] });
  verifyMigrationBinding();
  return { rows, restoredCardTests: restored.raw.numPassedTests, restoredCardReportPath: restored.reportPath, sourceAndAppliedMigrationsUnchanged: true };
}

async function browserChecks() {
  const rawPath = path.join(root, `.scaffold/phase012/${plan.attemptId}-browser.json`);
  assert(!fs.existsSync(rawPath));
  const result = await command("Phase012 real Auth.js HTTP and browser checks", ["--import", "tsx", "tests/phase012/browser.mjs", "--output", rawPath], {
    env: { DATABASE_URL: dbConfig().appUrl, PHASE012_FIXTURE_CONFIG: path.join(root, configPath) },
    timeoutMs: 900_000,
    expected: null,
  });
  const report = readRawReport(rawPath);
  const reportPath = archive("browser.json", report);
  for (const entry of report.artifacts) { assert.equal(hash(entry.path), entry.sha256); artifact(entry.path); }
  assert.equal(result.exitCode, 0, "The real browser process failed; its scanned report is archived");
  assert.equal(report.status, "PASS");
  assert.equal(report.phase, 12);
  assert.equal(report.simulation, true);
  assert.equal(report.productionTraffic, false);
  assert(Array.isArray(report.results) && report.results.length > 0);
  assert(report.results.every((entry) => entry.status === "PASS"));
  assert.equal(report.caseCount, report.results.length);
  return { reportPath, caseCount: report.caseCount };
}

async function evaluate() {
  const target = await assertIdentity();
  const migration = key === "list" ? await verifyMigration() : {};
  const checked = key === "navigation"
    ? await runVitest("navigation-ui", { files: ["admin/layout", "admin/users-client"] })
    : await runVitest(key, { pattern: key });
  const browser = key === "navigation" ? await browserChecks() : null;
  const mutation = key === "role-status" ? await mutations() : null;
  return { target, ...migration, tests: checked.raw.numPassedTests, reportPath: checked.reportPath,
    assertionNames: checked.assertions.filter(test => test.status === "passed").map(test => test.fullName),
    ...(browser ? { browser } : {}), ...(mutation ? { mutations: mutation } : {}), scan: scanScope() };
}

function executionDependencyHashes() {
  const pkg = json("package.json");
  const files = [
    ...Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).map((name) => `node_modules/${name}/package.json`),
    ".scaffold/tools/node_modules/npm/package.json", ".scaffold/tools/node_modules/npm/bin/npm-cli.js",
    "node_modules/prisma/build/index.js", "node_modules/.prisma/client/schema.prisma",
    "node_modules/vitest/vitest.mjs", "node_modules/tsx/dist/cli.mjs",
    "vitest/stubs/server-only.ts", "scripts/test-phase-input-paths.mjs", "scripts/verify-phase003.mjs",
    "scripts/phase003-evidence.mjs", "scripts/checkpoint-history.mjs",
  ];
  return Object.fromEntries([...new Set(files)].sort().map((file) => [file, hash(file)]));
}

async function quality(startHashes) {
  const snapshotArgs = { root, plan, receipt: json(receiptPath), git, hashFile: hash, inventory, migrationPath };
  const implementationSnapshot = getPhase012ImplementationSnapshot(snapshotArgs);
  const dependencyHashes = executionDependencyHashes();
  const checks = new Map();
  const checked = (id, details = {}) => { assert(requiredSupportingChecks.includes(id) && !checks.has(id)); checks.set(id, { checkId: id, status: "PASS", ...details }); };
  const pkg = json("package.json"), lock = json("package-lock.json"), runtime = json("docs/runtime-baseline.json");
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.equal(version, runtime.dependencyVersions[name]);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
    assert.equal(json(`node_modules/${name}/package.json`).version, version);
  }
  assert.equal((await command("node --version", ["--version"])).stdout.trim(), `v${runtime.runtimePolicy.node}`);
  assert.equal((await npm(["--version"])).stdout.trim(), runtime.runtimePolicy.npm);
  assert.equal(pkg.engines.node, runtime.runtimePolicy.node);
  assert.equal(pkg.engines.npm, runtime.runtimePolicy.npm);
  assert.equal(sha(fs.readFileSync(process.execPath)), runtime.nodeExecutableSha256);
  checked("dependency-versions", { dependencyCount: Object.keys(pkg.dependencies).length + Object.keys(pkg.devDependencies).length, nodeExecutableSha256: runtime.nodeExecutableSha256 });
  await command("Prisma CLI and checkpoint network regression", ["tests/phase012/cli-network.mjs"]);
  const networkPath = `${directory}/cli-network.json`;
  const network = json(networkPath);
  assert.equal(network.status, "PASS"); assert.equal(network.publicRequestsCompleted, 0); assert.equal(network.productionTraffic, false);
  assert.equal(network.guardHash, hash(network.guardPath)); assert.equal(network.prismaCliHash, hash("node_modules/prisma/build/index.js"));
  assert.deepEqual(network.reports.map((probe) => probe.label), ["disabled", "mutation-enable-checkpoint"]);
  for (const probe of network.reports) { assert.equal(probe.result.exitCode, 0); assert.equal(probe.result.timedOut, false); }
  assert.equal(network.reports[0].publicAttempts.length, 0); assert(network.reports[1].publicAttempts.length > 0);
  artifact(networkPath); checked("prisma-cli-network-isolation", { reportPath: networkPath });
  for (const script of ["lint", "typecheck"]) { await npm(["run", script]); checked(script); }
  const admin = await runVitest("admin-users-layout", { files: ["admin/users", "admin/layout"] });
  checked("admin-users-layout", { reportPath: admin.reportPath, testCount: admin.raw.numPassedTests });
  const tests = await runVitest("all-tests", { files: [] });
  checked("test", { reportPath: tests.reportPath, testCount: tests.raw.numPassedTests });
  const count = (pattern) => tests.raw.testResults.filter((suite) => pattern.test(suite.name)).flatMap((suite) => suite.assertionResults).filter((test) => test.status === "passed").length;
  for (const file of ["config-models", "travel-record", "chat-message", "audit-log", "seed", "api-key-schema", "admin-login"]) {
    const suites = tests.raw.testResults.filter((suite) => suite.name.replaceAll("\\", "/").endsWith(`/tests/integration/${file}.test.ts`));
    assert(suites.flatMap((suite) => suite.assertionResults).some((test) => test.status === "passed"), `Missing real integration regression: ${file}`);
  }
  const configRegressionTestCount = count(/config-models\.test|public-user\.test/);
  const dataRegressionTestCount = count(/travel-record\.test|chat-message\.test/);
  const auditRegressionTestCount = count(/audit-log\.test/);
  const seedRegressionTestCount = count(/seed\.test|api-key-schema\.test/);
  checked("phase007-config-regression", { testCount: configRegressionTestCount, reportPath: tests.reportPath });
  checked("phase008-data-regression", { testCount: dataRegressionTestCount, reportPath: tests.reportPath });
  checked("phase009-audit-regression", { testCount: auditRegressionTestCount, reportPath: tests.reportPath });
  checked("phase010-seed-regression", { testCount: seedRegressionTestCount, reportPath: tests.reportPath });
  checked("phase011-auth-regression", { testCount: count(/auth|admin-login/), reportPath: tests.reportPath });
  const user = await runVitest("phase006-user-regression", { files: [], legacy: true });
  checked("phase006-user-regression", { testCount: user.raw.numPassedTests, reportPath: user.reportPath });
  await npm(["run", "format:check"]);
  const changedTests = git(["diff", "--name-only", json(receiptPath).phaseStartCommit, "--", "tests"]).trim().split(/\r?\n/).filter((file) => /\.(?:ts|tsx|mjs)$/.test(file));
  const formatFiles = [...new Set([...changedTests, ...inventory("tests/phase012"), ...inventory("tests/admin")])];
  await npm(["exec", "--", "prettier", "--check", ...formatFiles]); checked("format-check");
  await npm(["run", "build"]); checked("build");
  await command("node scripts/check-project-layout.mjs", ["scripts/check-project-layout.mjs"]); checked("project-layout");
  await npm(["run", "verify:phase003"]); checked("phase003-regression");
  await command("node scripts/test-phase-input-paths.mjs", ["scripts/test-phase-input-paths.mjs"]);
  await command("node scripts/generate-api-contract.mjs --check", ["scripts/generate-api-contract.mjs", "--check"]);
  checked("api-contract");
  await migrationStatus(dbConfig().url);
  verifyMigrationBinding(); checked("migration-schema", { schemaHash: hash("prisma/schema.prisma"), migrationHash: hash(migrationPath) });
  const regressionPath = path.join(root, `.scaffold/phase012/${plan.attemptId}-validator-regression.json`);
  assert(!fs.existsSync(regressionPath));
  await command("Dual-shell validator compatibility regression", ["scripts/test-validate-phase.mjs", "--shell", "both", "--case", "root-equality-empty-prefix-local-inputs-history-pass,recovery-history-pass,previous-required-case-removal", "--output", regressionPath]);
  const regression = readRawReport(regressionPath);
  assert.equal(regression.status, "PASS"); assert.equal(regression.caseCount, 3);
  for (const [file, expected] of Object.entries(regression.testedSourceHashes)) assert.equal(hash(file), expected);
  checked("validator-regression", { reportPath: archive("validator-regression.json", regression), caseCount: regression.caseCount });
  const guardsPath = path.join(root, `.scaffold/phase012/${plan.attemptId}-evidence-guards.json`);
  assert(!fs.existsSync(guardsPath));
  await command("Phase012 evidence rejection regression", ["tests/phase012/evidence-guards.mjs", "--output", guardsPath]);
  const guards = readRawReport(guardsPath);
  assert.equal(guards.status, "PASS"); assert.equal(guards.phase, 12);
  requireHashCoverage(guards.testedSourceHashes, ["docs/phase-plans/phase012-evidence.mjs", "docs/phase-plans/phase012-runtime.mjs", "scripts/phase-evidence.mjs", "tests/phase012/evidence-guards.mjs"], hash, "EVIDENCE_GUARD_DEPENDENCY_HASH");
  assert(guards.results.length > 0 && guards.results.every((entry) => entry.status === "PASS"));
  assert.equal(guards.caseCount, guards.results.length);
  checked("phase012-evidence-guards", { reportPath: archive("evidence-guards.json", guards), caseCount: guards.caseCount });
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
  const scope = scanScope(); checked("secret-and-scope-scan", scope);
  assert.deepEqual([...checks.keys()].sort(), [...requiredSupportingChecks].sort());
  requireHashCoverage(dependencyHashes, Object.keys(executionDependencyHashes()), hash, "EXECUTION_DEPENDENCY_CHANGED");
  requirePhase012ImplementationBinding(implementationSnapshot, getPhase012ImplementationSnapshot(snapshotArgs));
  return { status: "PASS", planHash: startPlanHash, sourceHashes: startHashes, implementationSnapshot, executionDependencyHashes: dependencyHashes, supportingChecks: plan.supportingChecks, supportingResults: plan.supportingChecks.map((id) => checks.get(id)), observations, artifacts, testCount: tests.raw.numPassedTests, userRegressionTestCount: user.raw.numPassedTests, configRegressionTestCount, dataRegressionTestCount, auditRegressionTestCount, seedRegressionTestCount, sensitiveOutputHits: 0, scan: scope, simulation: true, productionTraffic: false };
}

setCommandObserver((observation) => { scan(observation, "command observation"); observations.push(observation); });
try {
  assert(!fs.existsSync(path.join(root, directory, "attempt.json")), "Record and freeze a new attempt after a failure");
  assert.equal(plan.phase, 12);
  assert.deepEqual(plan.requiredCaseIds, requiredKeys.map((name) => `Phase012:${name}`));
  assert.deepEqual(plan.cases.map((entry) => entry.testCaseId), plan.requiredCaseIds);
  assert.deepEqual(plan.supportingChecks, requiredSupportingChecks);
  assert(plan.cases.every((entry) => entry.denominator === 1));
  assert(isQuality || (options.length === 2 && options[0] === "--case" && item), "Pass a frozen --case or --quality");
  assert.equal(hash(`${directory}/frozen-plan.json`), startPlanHash, "Current attempt plan changed after freezing");
  const outputPath = isQuality ? `${directory}/quality.json` : item.outputPath;
  assert(!fs.existsSync(path.join(root, outputPath)), "A completed report cannot be overwritten");
  const receipt = json(receiptPath);
  requirePhase012Preflight(receipt.preflight);
  assert.equal(hash(receipt.preflight.reportPath), receipt.preflight.reportHash, "PREFLIGHT_HASH: original admission report changed");
  for (const [field, value] of Object.entries(json(receipt.preflight.reportPath))) assert.deepEqual(receipt.preflight[field], value, `PREFLIGHT_BINDING: ${field}`);
  requirePhase012FailureChain(plan, { readJson: json, hashFile: hash });
  for (const input of receipt.pinnedInputs) assert.equal(hash(input.path), input.sha256);
  for (const previous of plan.previousAttempts) requirePriorCaseBinding(plan, json(previous.planPath), { readJson: json, hashFile: hash });
  verifyMigrationBinding();
  const startHashes = sourceHashes();
  artifact(migrationPath);
  if (isQuality) {
    const report = await quality(startHashes);
    requireHashCoverage(startHashes, plan.sourcePaths, hash, "QUALITY_SOURCE_CHANGED");
    verifyMigrationBinding(); scan(report, "quality report"); write(outputPath, report);
    console.warn(JSON.stringify({ status: "PASS", supportingChecks: report.supportingChecks.length, testCount: report.testCount }));
  } else {
    const details = await evaluate();
    requireHashCoverage(startHashes, plan.sourcePaths, hash, "SOURCE_CHANGED_DURING_TEST");
    verifyMigrationBinding();
    const report = { testCaseId: item.testCaseId, command: item.command, status: "PASS", exitCode: 0, numerator: item.denominator, denominator: item.denominator, inputPath: item.inputPath, inputHash: hash(item.inputPath), planHash: startPlanHash, sourceHashes: startHashes, simulation: true, productionTraffic: false, details: { ...details, observations, artifacts } };
    scan(report, "case report"); write(outputPath, report);
    console.warn(JSON.stringify({ status: "PASS", testCaseId: item.testCaseId }));
  }
} catch (error) {
  const failurePath = `${directory}/attempt.json`;
  if (!fs.existsSync(path.join(root, failurePath))) {
    const safeObservation = error.observation ? safeDiagnostics(JSON.stringify(error.observation)) : null;
    const failure = { phase: 12, attemptId: plan.attemptId, status: "FAIL", artifactCommit: null, command: runnerCommand, exitCode: 1, planHash: startPlanHash, reason: safeDiagnostics(error.stack ?? error), observation: safeObservation === null ? null : (() => { try { return JSON.parse(safeObservation); } catch { return { diagnostics: safeObservation }; } })(), observations, artifacts, startedAt, recordedAt: new Date().toISOString() };
    scan(failure, "failure receipt"); write(failurePath, failure);
  }
  console.error(safeDiagnostics(error.stack ?? error)); process.exitCode = 1;
} finally { setCommandObserver(null); }
