import { requirePhase008Generation, requirePhase008ImplementationBinding, getPhase008ImplementationSnapshot } from "./phase008-evidence.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  root, plan, planPath, receiptPath, directory, read, json, sha, hash, write, git,
  npm, command, dbConfig, assertDatabaseTarget, freshDatabase, sql, copyFixture,
  removeFixture, inventory, migrationPath, generationPath, redact,
} from "./phase008-runtime.mjs";
import { requireHashCoverage, requireReportBinding } from "../../scripts/phase-evidence.mjs";

const require = createRequire(path.join(root, "package.json"));
const observations = [];
const artifacts = [];
const key = process.argv[process.argv.indexOf("--case") + 1];
const item = plan.cases.find((entry) => entry.testCaseId === `Phase008:${key}`);
const sourceSchemaPath = "prisma/schema.prisma";
const sourceHashes = () => Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(file)]));
const cardFiles = ["travel-record", "chat-message"];

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
  assert.equal(database, target.database);
  assert.match(version, /^17\./);
  assert.equal(marker, target.marker);
  return target;
}

async function runVitest(label, { cwd = root, files = cardFiles, pattern, databaseUrl, expected = 0, legacy = false } = {}) {
  const rawPath = path.join(root, `.scaffold/phase008/${plan.attemptId}-${label}-vitest.json`);
  assert(!fs.existsSync(rawPath), `Raw report already exists: ${label}`);
  const args = ["run", "test", "--"];
  if (legacy) args.push("--config", "tests/phase006/vitest.database.config.mjs");
  args.push(...files);
  if (pattern) args.push("-t", pattern);
  args.push("--reporter=json", `--outputFile=${rawPath}`);
  const env = databaseUrl ? { DATABASE_URL: databaseUrl, PHASE007_DATABASE_URL: databaseUrl, PHASE008_DATABASE_URL: databaseUrl } : {};
  if (databaseUrl) await assertIdentity(databaseUrl);
  const result = await npm(args, { cwd, expected: null, env });
  observations.push(result);
  assert(fs.existsSync(rawPath), `Vitest produced no JSON report: ${result.stderr}`);
  const raw = JSON.parse(redact(fs.readFileSync(rawPath, "utf8")));
  archive(`${label}-vitest.json`, raw);
  assert(raw.numTotalTestSuites > 0);
  if (expected === 0) {
    assert.equal(result.exitCode, 0, JSON.stringify(raw.testResults));
    assert.equal(raw.success, true);
    assert.equal(raw.numFailedTests, 0);
    assert(raw.numPassedTests > 0);
    if (!pattern) assert.equal(raw.numPendingTests, 0, "Required integration tests must not be skipped");
  } else {
    assert(Number.isInteger(result.exitCode) && result.exitCode !== 0, "Mutation requires an actual nonzero test process");
    assert.equal(raw.success, false);
    assert(raw.numFailedTests > 0);
  }
  return { result, raw };
}

async function deploy(url, cwd = root) {
  await assertIdentity(url);
  const record = await npm(["exec", "--", "prisma", "migrate", "deploy"], { cwd, env: { DATABASE_URL: url } });
  observations.push(record);
  return record;
}

async function migrationStatus(url, cwd = root) {
  await assertIdentity(url);
  const record = await npm(["exec", "--", "prisma", "migrate", "status"], { cwd, env: { DATABASE_URL: url } });
  observations.push(record);
  assert.match(record.stdout, /Database schema is up to date/);
  return record;
}

async function disposeDatabase(database) {
  assert(database.startsWith(`${dbConfig().database}_`));
  assert.match(database, /^phase008_disposable_[a-f0-9]{12}_[a-z0-9_]+$/);
  observations.push(await sql(`DROP DATABASE "${database}" WITH (FORCE);`, "postgres"));
}

function baselineFixture(label) {
  const fixture = copyFixture(label);
  const receipt = json(receiptPath);
  const original = git(["show", `${receipt.phaseStartCommit}:${sourceSchemaPath}`], null);
  assert.equal(sha(original), receipt.prerequisites.schemaHash);
  fs.writeFileSync(path.join(fixture, sourceSchemaPath), original);
  for (const file of inventory("prisma/migrations", fixture).filter((entry) => /\/\d{14}_travel_record_chat_message\/migration\.sql$/.test(entry))) {
    const absolute = path.resolve(fixture, file);
    assert(absolute.startsWith(`${path.resolve(fixture, "prisma/migrations")}${path.sep}`));
    fs.unlinkSync(absolute);
    fs.rmdirSync(path.dirname(absolute));
  }
  return fixture;
}

async function prepareMigration() {
  assert(!fs.existsSync(path.join(root, generationPath)), "Generation receipt already exists");
  assert.equal(inventory("prisma/migrations").filter((file) => /_travel_record_chat_message\/migration\.sql$/.test(file)).length, 0);
  const target = await assertIdentity(dbConfig().url);
  const fixture = baselineFixture("generate");
  try {
    await deploy(dbConfig().url, fixture);
    await migrationStatus(dbConfig().url, fixture);
    const tables = await sql("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;");
    observations.push(tables);
    assert.deepEqual(tables.stdout.trim().split(/\r?\n/), ["SystemConfig", "User", "_prisma_migrations"]);
    fs.writeFileSync(path.join(fixture, sourceSchemaPath), read(sourceSchemaPath));
    observations.push(await npm(["run", "db:migrate", "--", "--name", "travel_record_chat_message", "--create-only", "--skip-generate"], { cwd: fixture, env: { DATABASE_URL: dbConfig().url } }));
    const generated = inventory("prisma/migrations", fixture).filter((file) => /\/\d{14}_travel_record_chat_message\/migration\.sql$/.test(file));
    assert.equal(generated.length, 1);
    const rawMigrationPath = "docs/evidence/attempts/Phase008/setup/travel_record_chat_message.generated.sql";
    const raw = read(generated[0], fixture).toString().replaceAll("\r\n", "\n");
    assert.deepEqual([...raw.matchAll(/CREATE TABLE "([^"]+)"/g)].map((match) => match[1]), ["TravelRecord", "ChatMessage"]);
    const checks = `\n-- Ownership and ordering are enforced even when bypassing repository helpers.\nALTER TABLE "TravelRecord" ADD CONSTRAINT "TravelRecord_owner_xor" CHECK (("userId" IS NOT NULL) <> ("anonTokenHash" IS NOT NULL));\nALTER TABLE "TravelRecord" ADD CONSTRAINT "TravelRecord_anonTokenHash_format" CHECK ("anonTokenHash" IS NULL OR "anonTokenHash"::text ~ '^[0-9a-f]{64}$');\nALTER TABLE "TravelRecord" ADD CONSTRAINT "TravelRecord_version_nonnegative" CHECK ("version" >= 0);\nALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_sequence_positive" CHECK ("sequence" > 0);\n`;
    write(generated[0], `${raw.trimEnd()}\n${checks}`);
    write(rawMigrationPath, raw);
    write(generationPath, {
      generatedMigrationPath: generated[0], rawMigrationPath, rawMigrationHash: hash(rawMigrationPath),
      migrationHash: hash(generated[0]), schemaPath: sourceSchemaPath, schemaHash: hash(sourceSchemaPath),
      previousSchemaHash: json(receiptPath).prerequisites.schemaHash,
      previousMigrations: json(receiptPath).prerequisites.migrations,
      target, records: observations, simulation: true, productionTraffic: false,
      checksAddedBeforeFirstApplication: ["TravelRecord_owner_xor", "TravelRecord_anonTokenHash_format", "TravelRecord_version_nonnegative", "ChatMessage_sequence_positive"],
    });
    console.warn(JSON.stringify({ status: "MIGRATION_GENERATED_NOT_APPLIED", migrationPath: generated[0], receiptHash: hash(generationPath) }));
  } finally { removeFixture(fixture); }
}

function verifyMigrationBinding() {
  const generation = json(generationPath);
  requirePhase008Generation(generation, { receipt: json(receiptPath), hashFile: hash, readText: (file) => read(file).toString(), migrationPath });
  return generation;
}

function scanScope() {
  const ts = require("typescript");
  const production = inventory("src").filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !/\.test\./.test(file));
  const sources = production.map((file) => ({ file, content: read(file).toString() }));
  assert.deepEqual(sources.filter(({ content }) => /\b(?:AiOutputRecord|PromptConfig|AiModelConfig|PromptDefinition|PromptVersion|ModelDeployment|ProviderConfigVersion|ChatCommand|ChatEvent)\b/.test(content)), []);
  const newSources = [sourceSchemaPath, migrationPath, "src/server/anonymous-owner.ts", ...inventory("src/server/repositories")];
  for (const file of newSources) {
    const content = read(file).toString();
    assert(!/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp)_[A-Za-z0-9]{16,}|postgres(?:ql)?:\/\/|\b(?:apiKey|apiSecret|accessToken|refreshToken|promptContent)\s*[:=]/i.test(content), `Secret or governed content in ${file}`);
  }
  const cleanupFiles = [...inventory("tests"), ...production].filter((file) => /\.[cm]?[jt]sx?$/.test(file));
  function assertBoundedCleanup(file, content) {
    const tree = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "deleteMany") {
        const argument = node.arguments[0];
        const where = argument && ts.isObjectLiteralExpression(argument) ? argument.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(tree).replace(/["']/g, "") === "where") : undefined;
        assert(where && ts.isObjectLiteralExpression(where.initializer) && where.initializer.properties.length > 0, `Unscoped cleanup in ${file}`);
      }
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) assert(!/(?:^|;)\s*TRUNCATE\b|\bmigrate\s+reset\b/i.test(node.text), `Unscoped SQL cleanup in ${file}`);
      if (ts.isArrayLiteralExpression(node)) assert(!/\bmigrate\s+reset\b/.test(node.elements.map((element) => ts.isStringLiteralLike(element) ? element.text : "").join(" ")), `Unscoped migration cleanup in ${file}`);
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  assertBoundedCleanup("safe-fixture.ts", "await db.user.deleteMany({ where: { id: { in: ids } } });");
  for (const unsafe of ["await db.user.deleteMany();", "await db.user.deleteMany({});", "await db.user.deleteMany({where:{}});", "await db.$executeRawUnsafe('TRUNCATE TABLE users');"]) assert.throws(() => assertBoundedCleanup("unsafe-fixture.ts", unsafe), /Unscoped/);
  for (const file of cleanupFiles) assertBoundedCleanup(file, read(file).toString());
  assert(!inventory("src/app/api").length);
  assert(!inventory("prisma").some((file) => /seed/i.test(file)));
  const schema = read(sourceSchemaPath).toString();
  assert.deepEqual([...schema.matchAll(/^model (\w+) \{/gm)].map((match) => match[1]), ["User", "SystemConfig", "TravelRecord", "ChatMessage"]);
  assert.deepEqual([...schema.matchAll(/^enum (\w+) \{/gm)].map((match) => match[1]).sort(), ["Role", "UserStatus", "TravelStatus", "MessageRole", "ChatMessageKind"].sort());
  const migration = read(migrationPath).toString();
  assert(!/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/.test(migration.replace(/ON DELETE (?:SET NULL|RESTRICT|CASCADE) ON UPDATE CASCADE/g, "")), "Migration must be additive");
  assert.deepEqual([...migration.matchAll(/CREATE TABLE "([^"]+)"/g)].map((match) => match[1]), ["TravelRecord", "ChatMessage"]);
  assert.equal([...migration.matchAll(/CREATE (?:UNIQUE )?INDEX /g)].length, 6);
  assert.equal([...migration.matchAll(/FOREIGN KEY /g)].length, 3);
  assert.equal([...migration.matchAll(/ADD CONSTRAINT "(?:TravelRecord|ChatMessage)_[^"]+" CHECK/g)].length, 4);
  assert.equal(inventory("prisma/migrations").filter((file) => /_travel_record_chat_message\/migration\.sql$/.test(file)).length, 1);
  verifyMigrationBinding();
  return { productionSourceCount: sources.length, cleanupSourceCount: cleanupFiles.length, secretMatches: 0, forbiddenModels: 0, unsafeCleanupMatches: 0, additiveTables: 2, addedEnumTypes: 3 };
}

async function verifyMigration() {
  verifyMigrationBinding();
  const target = await assertIdentity(dbConfig().url);
  observations.push(await npm(["run", "db:migrate", "--", "--name", "travel_record_chat_message"], { env: { DATABASE_URL: dbConfig().url } }));
  await migrationStatus(dbConfig().url);
  observations.push(await npm(["run", "db:generate"], { env: { DATABASE_URL: dbConfig().url } }));
  assert.equal(read("node_modules/.prisma/client/schema.prisma").toString(), read(sourceSchemaPath).toString());
  for (const model of ["TravelRecord", "ChatMessage"]) assert.match(read("node_modules/.prisma/client/index.d.ts").toString(), new RegExp(`export type ${model}\\s*=`));
  const replay = await freshDatabase(`a${plan.attemptId.split("-")[1]}_replay`);
  observations.push(...replay.observations);
  const fixture = baselineFixture("replay");
  const id = `phase008_migration_${dbConfig().runId}`;
  try {
    await deploy(replay.url, fixture);
    await migrationStatus(replay.url, fixture);
    observations.push(await sql(`INSERT INTO "User" (id,email,"passwordHash","createdAt","updatedAt") VALUES ('${id}','${id}@example.invalid','$2b$12$${"a".repeat(53)}','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z'); INSERT INTO "SystemConfig" (id,key,"valueJson",description,"group","updatedBy","createdAt","updatedAt") VALUES ('${id}','${id}','{"enabled":false}','Synthetic migration preservation','GENERAL','${id}','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z');`, replay.database));
    const rowQuery = `SELECT json_build_object('user',(SELECT row_to_json(u) FROM "User" u WHERE id='${id}'),'config',(SELECT row_to_json(c) FROM "SystemConfig" c WHERE id='${id}'));`;
    const before = await sql(rowQuery, replay.database); observations.push(before);
    await deploy(replay.url);
    const after = await sql(rowQuery, replay.database); observations.push(after);
    assert.deepEqual(JSON.parse(after.stdout.trim()), JSON.parse(before.stdout.trim()));
    observations.push(await npm(["exec", "--", "prisma", "migrate", "diff", "--from-url", replay.url, "--to-schema-datamodel", sourceSchemaPath, "--exit-code"], { env: { DATABASE_URL: replay.url } }));
    await migrationStatus(replay.url);
    await runVitest("migration-replay", { pattern: "lifecycle-version:", databaseUrl: replay.url });
    observations.push(await sql(`DELETE FROM "SystemConfig" WHERE id='${id}'; DELETE FROM "User" WHERE id='${id}';`, replay.database));
  } finally { removeFixture(fixture); await disposeDatabase(replay.database); }
  return { target, generationPath, generationHash: hash(generationPath), migrationPath, migrationHash: hash(migrationPath), schemaHash: hash(sourceSchemaPath), preservedPriorModels: ["User", "SystemConfig"], drift: false };
}

async function mutations() {
  const rows = [];
  const specs = [
    { key: "owner", pattern: "ownership: ownerless rows are rejected", remove: /ALTER TABLE "TravelRecord" ADD CONSTRAINT "TravelRecord_owner_xor" CHECK \([^;]*\);\n?/ },
    { key: "sequence", pattern: "ordered-messages: duplicate sequence is rejected", remove: /CREATE UNIQUE INDEX "ChatMessage_travelRecordId_sequence_key"[^;]*;\n?/ },
    { key: "client", pattern: "client-idempotency: duplicate client id is rejected", remove: /CREATE UNIQUE INDEX "ChatMessage_travelRecordId_clientMessageId_key"[^;]*;\n?/ },
  ];
  for (const spec of specs) {
    const fixture = copyFixture(`mutation-${spec.key}`);
    const original = read(migrationPath).toString();
    const changed = original.replace(spec.remove, "");
    assert.notEqual(changed, original, `Mutation did not change ${spec.key}`);
    fs.writeFileSync(path.join(fixture, migrationPath), changed);
    archive(`mutations/${spec.key}.sql`, changed);
    const db = await freshDatabase(`a${plan.attemptId.split("-")[1]}_mut_${spec.key}`);
    observations.push(...db.observations);
    try {
      await deploy(db.url, fixture);
      const failed = await runVitest(`negative-${spec.key}`, { cwd: fixture, pattern: spec.pattern, databaseUrl: db.url, expected: 1 });
      const assertions = failed.raw.testResults.flatMap((result) => result.assertionResults).filter((entry) => entry.status === "failed");
      assert.equal(assertions.length, 1);
      assert(assertions[0].fullName.includes(spec.pattern));
      assert(assertions[0].failureMessages.some((message) => /promise resolved|did not throw|not to resolve/i.test(message)), "Mutation failed for an unrelated reason");
      rows.push({ mutation: spec.key, underlyingExitCode: failed.result.exitCode, failedTests: failed.raw.numFailedTests, failedAssertion: assertions[0].fullName });
    } finally { await disposeDatabase(db.database); removeFixture(fixture); }
    const restored = await freshDatabase(`a${plan.attemptId.split("-")[1]}_ok_${spec.key}`);
    observations.push(...restored.observations);
    try {
      await deploy(restored.url);
      const passed = await runVitest(`restored-${spec.key}`, { pattern: spec.pattern, databaseUrl: restored.url });
      rows.at(-1).restoredTests = passed.raw.numPassedTests;
      await migrationStatus(restored.url);
    } finally { await disposeDatabase(restored.database); }
  }
  const restored = await runVitest("restored-card-tests", { databaseUrl: dbConfig().url });
  await migrationStatus(dbConfig().url);
  return { rows, restoredCardTests: restored.raw.numPassedTests, allMutationsObserved: rows.length === 3, sourceAndAppliedMigrationsUnchanged: true };
}

async function evaluate() {
  if (key === "lifecycle-version") {
    const migration = await verifyMigration();
    const scan = scanScope();
    const checked = await runVitest("lifecycle-version", { pattern: "lifecycle-version:", databaseUrl: dbConfig().url });
    return { ...migration, scan, tests: checked.raw.numPassedTests };
  }
  if (key === "mutation") return mutations();
  if (["ownership", "hash", "ordered-messages", "client-idempotency", "reply-relation", "delete-policy"].includes(key)) {
    const checked = await runVitest(key, { pattern: `${key}:`, databaseUrl: dbConfig().url });
    return { tests: checked.raw.numPassedTests };
  }
  throw new Error(`Unknown case ${key}`);
}

async function quality(startHashes) {
  const implementationSnapshot = getPhase008ImplementationSnapshot({ root, plan, receipt: json(receiptPath), git, hashFile: hash, inventory, migrationPath });
  const changed = [...git(["diff", "--name-only", "HEAD"]).trim().split(/\r?\n/), ...git(["ls-files", "--others", "--exclude-standard"]).trim().split(/\r?\n/)].filter(Boolean);
  for (const file of changed) assert(plan.modificationScope.some((scope) => scope.endsWith("/") ? file.startsWith(scope) : scope === file), `Out-of-scope file ${file}`);
  for (const input of json(receiptPath).pinnedInputs) assert.equal(hash(input.path), input.sha256);
  const scan = scanScope();
  const pkg = json("package.json"), lock = json("package-lock.json"), runtime = json("docs/runtime-baseline.json");
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.equal(version, runtime.dependencyVersions[name]);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
  }
  const version = await command("node --version", ["--version"]);
  observations.push(version); assert.equal(version.stdout.trim(), "v24.19.0");
  const npmVersion = await npm(["--version"]);
  observations.push(npmVersion); assert.equal(npmVersion.stdout.trim(), "11.7.0");
  observations.push(await command("Prisma CLI and checkpoint network regression", ["tests/phase008/cli-network.mjs"]));
  artifacts.push({ path: `${directory}/cli-network.json`, sha256: hash(`${directory}/cli-network.json`) });
  for (const script of ["lint", "typecheck"]) observations.push(await npm(["run", script]));
  const tests = await runVitest("all-tests", { files: [], databaseUrl: dbConfig().url });
  const configResults = tests.raw.testResults.filter((result) => /config-models\.test|public-user\.test/.test(result.name));
  const configRegressionTestCount = configResults.flatMap((result) => result.assertionResults).filter((result) => result.status === "passed").length;
  assert(configResults.length >= 2 && configRegressionTestCount > 0);
  const legacy = await runVitest("phase006-user-regression", { files: [], legacy: true, databaseUrl: dbConfig().url });
  observations.push(await npm(["run", "format:check"]));
  observations.push(await npm(["exec", "--", "prettier", "--check", "tests/lib/travel-record.test.ts", "tests/lib/chat-message.test.ts", "tests/integration/travel-record.test.ts", "tests/integration/chat-message.test.ts", "tests/phase008/*.{ts,mjs}", "tests/integration/config-models.test.ts", "tests/phase006/database.integration.ts"]));
  observations.push(await npm(["run", "build"]));
  observations.push(await command("node scripts/check-project-layout.mjs", ["scripts/check-project-layout.mjs"]));
  observations.push(await npm(["run", "verify:phase003"]));
  observations.push(await command("node scripts/test-phase-input-paths.mjs", ["scripts/test-phase-input-paths.mjs"]));
  const regressionPath = path.join(root, `.scaffold/phase008/${plan.attemptId}-validator-regression.json`);
  observations.push(await command("Dual-shell validator compatibility regression", ["scripts/test-validate-phase.mjs", "--shell", "both", "--case", "root-equality-empty-prefix-local-inputs-history-pass,recovery-history-pass,previous-required-case-removal", "--output", regressionPath]));
  const regression = JSON.parse(fs.readFileSync(regressionPath, "utf8"));
  assert.equal(regression.status, "PASS");
  assert.equal(regression.caseCount, 3);
  for (const [file, expected] of Object.entries(regression.testedSourceHashes)) assert.equal(hash(file), expected);
  archive("validator-regression.json", regression);
  const evidenceGuardPath = path.join(root, `.scaffold/phase008/${plan.attemptId}-evidence-guards.json`);
  observations.push(await command("Phase008 evidence rejection regression", ["tests/phase008/evidence-guards.mjs", "--output", evidenceGuardPath]));
  const evidenceGuards = JSON.parse(fs.readFileSync(evidenceGuardPath, "utf8"));
  assert.equal(evidenceGuards.status, "PASS");
  archive("evidence-guards.json", evidenceGuards);
  const prototype = json(plan.cases[0].outputPath);
  requireReportBinding(prototype, plan.cases[0], hash(planPath), plan.sourcePaths, hash);
  for (const field of ["planHash", "inputHash", "denominator"]) {
    const mutated = structuredClone(prototype);
    mutated[field] = field === "denominator" ? 999 : "0".repeat(64);
    assert.throws(() => requireReportBinding(mutated, plan.cases[0], hash(planPath), plan.sourcePaths, hash), /REPORT_BINDING/);
  }
  assert.throws(() => requireHashCoverage({ ...startHashes, [sourceSchemaPath]: "0".repeat(64) }, plan.sourcePaths, hash, "SOURCE_HASH"), /SOURCE_HASH/);
  const rows = await sql('SELECT (SELECT count(*) FROM "TravelRecord"), (SELECT count(*) FROM "ChatMessage"), (SELECT count(*) FROM "User"), (SELECT count(*) FROM "SystemConfig");');
  observations.push(rows); assert.equal(rows.stdout.trim(), "0|0|0|0", "Exact fixture cleanup must leave no test rows");
  requirePhase008ImplementationBinding(implementationSnapshot, getPhase008ImplementationSnapshot({ root, plan, receipt: json(receiptPath), git, hashFile: hash, inventory, migrationPath }));
  return { status: "PASS", planHash: hash(planPath), sourceHashes: startHashes, implementationSnapshot, supportingChecks: plan.supportingChecks, observations, artifacts, testCount: tests.raw.numPassedTests, userRegressionTestCount: legacy.raw.numPassedTests, configRegressionTestCount, scan, simulation: true, productionTraffic: false };
}

try {
  if (process.argv.includes("--prepare-migration")) await prepareMigration();
  else {
    assert(!fs.existsSync(path.join(root, directory, "attempt.json")), "Record and freeze a new attempt after a failure");
    assert.equal(hash(`${directory}/frozen-plan.json`), hash(planPath));
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
      requireHashCoverage(startHashes, plan.sourcePaths, hash, "SOURCE_CHANGED_DURING_TEST");
      verifyMigrationBinding();
      write(item.outputPath, { testCaseId: item.testCaseId, command: item.command, status: "PASS", exitCode: 0, numerator: item.denominator, denominator: item.denominator, inputPath: item.inputPath, inputHash: hash(item.inputPath), planHash: hash(planPath), sourceHashes: startHashes, simulation: true, productionTraffic: false, details: { ...details, observations, artifacts } });
      console.warn(JSON.stringify({ status: "PASS", testCaseId: item.testCaseId }));
    }
  }
} catch (error) {
  const failure = `${directory}/attempt.json`;
  if (!fs.existsSync(path.join(root, failure))) write(failure, { phase: 8, attemptId: plan.attemptId, status: "FAIL", artifactCommit: null, command: item?.command ?? (process.argv.includes("--prepare-migration") ? "node docs/phase-plans/verify-phase008.mjs --prepare-migration" : "node docs/phase-plans/verify-phase008.mjs --quality"), planHash: hash(planPath), reason: redact(error.stack), observation: error.observation, observations, artifacts, recordedAt: new Date().toISOString() });
  console.error(redact(error.stack));
  process.exitCode = 1;
}
