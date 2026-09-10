import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  root, plan, planPath, receiptPath, directory, read, json, sha, hash, write, git,
  npm, command, dbConfig, assertDatabaseTarget, freshDatabase, sql, copyFixture,
  removeFixture, inventory, migrationPath, redact,
} from "./phase007-runtime.mjs";
import { requireHashCoverage, requireReportBinding } from "../../scripts/phase-evidence.mjs";

const require = createRequire(path.join(root, "package.json"));
const observations = [];
const artifacts = [];
const key = process.argv[process.argv.indexOf("--case") + 1];
const item = plan.cases.find((entry) => entry.testCaseId === `Phase007:${key}`);
const sourceHashes = () => Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(file)]));
const generationPath = "docs/evidence/attempts/Phase007/setup/migration-generation.json";
const sourceSchemaPath = "prisma/schema.prisma";

function archive(name, content) {
  const file = `${directory}/${name}`;
  write(file, content);
  artifacts.push({ path: file, sha256: hash(file) });
  return file;
}

async function runVitest(label, { cwd = root, files = ["tests/integration/config-models.test.ts"], pattern, databaseUrl, expected = 0, legacy = false } = {}) {
  const rawPath = path.join(root, `.scaffold/phase007/${plan.attemptId}-${label}-vitest.json`);
  assert(!fs.existsSync(rawPath), `Raw report already exists: ${label}`);
  const args = ["run", "test", "--"];
  if (legacy) args.push("--config", "tests/phase006/vitest.database.config.mjs");
  args.push(...files);
  if (pattern) args.push("-t", pattern);
  args.push("--reporter=json", `--outputFile=${rawPath}`);
  const env = databaseUrl ? { DATABASE_URL: databaseUrl, PHASE007_DATABASE_URL: databaseUrl } : {};
  if (databaseUrl) await assertDatabaseTarget(dbConfig(), databaseUrl);
  const result = await npm(args, { cwd, expected: null, env });
  observations.push(result);
  assert(fs.existsSync(rawPath), `Vitest produced no JSON report: ${result.stderr}`);
  const raw = JSON.parse(redact(fs.readFileSync(rawPath, "utf8")));
  archive(`${label}-vitest.json`, raw);
  assert.equal(raw.numTotalTestSuites > 0, true);
  if (expected === 0) {
    assert.equal(result.exitCode, 0, JSON.stringify(raw.testResults));
    assert.equal(raw.success, true);
    assert.equal(raw.numFailedTests, 0);
    assert(raw.numPassedTests > 0);
    if (!pattern) assert.equal(raw.numPendingTests, 0, "Required integration tests must not be skipped");
  } else {
    assert(Number.isInteger(result.exitCode) && result.exitCode !== 0, "The mutation requires an actual nonzero test process");
    assert.equal(raw.success, false);
    assert(raw.numFailedTests > 0);
  }
  return { result, raw };
}

async function deploy(url, cwd = root) {
  await assertDatabaseTarget(dbConfig(), url);
  const record = await npm(["exec", "--", "prisma", "migrate", "deploy"], { cwd, env: { DATABASE_URL: url } });
  observations.push(record);
  return record;
}

async function migrationStatus(url, cwd = root) {
  await assertDatabaseTarget(dbConfig(), url);
  const record = await npm(["exec", "--", "prisma", "migrate", "status"], { cwd, env: { DATABASE_URL: url } });
  observations.push(record);
  assert.match(record.stdout, /Database schema is up to date/);
  return record;
}

async function disposeDatabase(database) {
  assert(database.startsWith(`${dbConfig().database}_`));
  assert.match(database, /^phase007_disposable_[a-f0-9]{12}_[a-z0-9_]+$/);
  observations.push(await sql(`DROP DATABASE "${database}" WITH (FORCE);`, "postgres"));
}

function baselineFixture(label) {
  const fixture = copyFixture(label);
  const receipt = json(receiptPath);
  const original = git(["show", `${receipt.phaseStartCommit}:${sourceSchemaPath}`], null);
  assert.equal(sha(original), receipt.prerequisites.schemaHash);
  fs.writeFileSync(path.join(fixture, sourceSchemaPath), original);
  for (const file of inventory("prisma/migrations", fixture).filter((entry) => /\/\d{14}_system_config\/migration\.sql$/.test(entry))) {
    const absolute = path.resolve(fixture, file);
    assert(absolute.startsWith(`${path.resolve(fixture, "prisma/migrations")}${path.sep}`));
    fs.unlinkSync(absolute);
    fs.rmdirSync(path.dirname(absolute));
  }
  return fixture;
}

async function prepareMigration() {
  assert(!fs.existsSync(path.join(root, generationPath)), "Generation receipt already exists");
  assert.equal(inventory("prisma/migrations").filter((file) => /_system_config\/migration\.sql$/.test(file)).length, 0);
  const target = await assertDatabaseTarget();
  const fixture = baselineFixture("generate");
  try {
    await deploy(dbConfig().url, fixture);
    await migrationStatus(dbConfig().url, fixture);
    const tables = await sql("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;");
    observations.push(tables);
    assert.deepEqual(tables.stdout.trim().split(/\r?\n/), ["User", "_prisma_migrations"]);
    fs.writeFileSync(path.join(fixture, sourceSchemaPath), read(sourceSchemaPath));
    observations.push(await npm(["run", "db:migrate", "--", "--name", "system_config", "--create-only", "--skip-generate"], { cwd: fixture, env: { DATABASE_URL: dbConfig().url } }));
    const generated = inventory("prisma/migrations", fixture).filter((file) => /\/\d{14}_system_config\/migration\.sql$/.test(file));
    assert.equal(generated.length, 1);
    const rawMigrationPath = "docs/evidence/attempts/Phase007/setup/system_config.generated.sql";
    const raw = read(generated[0], fixture).toString().replaceAll("\r\n", "\n");
    write(generated[0], raw);
    write(rawMigrationPath, raw);
    write(generationPath, {
      generatedMigrationPath: generated[0], rawMigrationPath, rawMigrationHash: hash(rawMigrationPath),
      previousSchemaHash: json(receiptPath).prerequisites.schemaHash,
      schemaHash: hash(sourceSchemaPath), previousMigrationHash: json(receiptPath).prerequisites.migrationHash,
      target, records: observations, simulation: true, productionTraffic: false,
    });
    console.warn(JSON.stringify({ status: "MIGRATION_GENERATED_NOT_APPLIED", migrationPath: generated[0], receiptHash: hash(generationPath) }));
  } finally { removeFixture(fixture); }
}

function scanScope() {
  const ts = require("typescript");
  const production = inventory("src").filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !/\.test\./.test(file));
  const source = production.map((file) => ({ file, content: read(file).toString() }));
  const forbiddenModels = source.filter(({ content }) => /\b(?:PromptConfig|AiModelConfig|PromptDefinition|PromptVersion|ModelDeployment|ProviderConfigVersion)\b/.test(content));
  assert.deepEqual(forbiddenModels, []);
  const consumers = [];
  for (const { file, content } of source) {
    const tree = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (/projections\/admin-user|(?:^|\/)admin-user$/.test(node.moduleSpecifier.text)) consumers.push(file);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  assert.deepEqual(consumers, [], "No production admin endpoint exists in Phase007");
  const newSources = [sourceSchemaPath, migrationPath, "src/server/projections/public-user.ts", "src/server/projections/admin-user.ts", "src/lib/schemas/system-config.ts"];
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
        const where = argument && ts.isObjectLiteralExpression(argument)
          ? argument.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(tree).replace(/["']/g, "") === "where")
          : undefined;
        assert(where && ts.isObjectLiteralExpression(where.initializer) && where.initializer.properties.length > 0, `Unscoped cleanup in ${file}`);
      }
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        assert(!/(?:^|;)\s*TRUNCATE\b|\bmigrate\s+reset\b/i.test(node.text), `Unscoped SQL or migration cleanup in ${file}`);
      }
      if (ts.isArrayLiteralExpression(node)) {
        const argumentsText = node.elements.map((element) => ts.isStringLiteralLike(element) ? element.text : "").join(" ");
        assert(!/\bmigrate\s+reset\b/.test(argumentsText), `Unscoped migration cleanup in ${file}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  assertBoundedCleanup("text-tool.ts", "export function truncate(value: string) { return value.slice(0, 8); }");
  assertBoundedCleanup("owned-rows.ts", "await db.user.deleteMany({ where: { id: { in: ids } } });");
  for (const unsafe of ["await db.user.deleteMany();", "await db.user.deleteMany({});", "await db.user.deleteMany({ where: {} });", "await db.$executeRawUnsafe('TRUNCATE TABLE users');", "run(['migrate', 'reset']);"]) {
    assert.throws(() => assertBoundedCleanup("unsafe-fixture.ts", unsafe), /Unscoped/);
  }
  for (const file of cleanupFiles) {
    assertBoundedCleanup(file, read(file).toString());
  }
  assert(!inventory("src/app/api").length);
  assert(!inventory("prisma").some((file) => /seed/i.test(file)));
  assert(!fs.existsSync(path.join(root, "src/lib/db.ts")));
  const schema = read(sourceSchemaPath).toString();
  assert.deepEqual([...schema.matchAll(/^model (\w+) \{/gm)].map((match) => match[1]), ["User", "SystemConfig"]);
  const migration = read(migrationPath).toString();
  assert(!/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/.test(migration.replace(/ON DELETE SET NULL ON UPDATE CASCADE/g, "")), "Migration must only add this model's structure");
  assert.deepEqual([...migration.matchAll(/CREATE TABLE "([^"]+)"/g)].map((match) => match[1]), ["SystemConfig"]);
  assert.equal([...migration.matchAll(/CREATE (?:UNIQUE )?INDEX /g)].length, 3);
  assert.equal([...migration.matchAll(/FOREIGN KEY /g)].length, 1);
  assert.equal([...migration.matchAll(/ADD CONSTRAINT "SystemConfig_(?:group_check|revision_nonnegative)" CHECK/g)].length, 2);
  assert.equal(inventory("prisma/migrations").filter((file) => /_system_config\/migration\.sql$/.test(file)).length, 1);
  return { productionSourceCount: source.length, cleanupSourceCount: cleanupFiles.length, secretMatches: 0, forbiddenModelMatches: 0, unsafeCleanupMatches: 0, unauthorizedAdminConsumers: 0 };
}

async function verifyMigration() {
  const target = await assertDatabaseTarget();
  const generation = json(generationPath);
  assert.equal(generation.generatedMigrationPath, migrationPath);
  assert.equal(hash(generation.rawMigrationPath), generation.rawMigrationHash);
  assert.equal(hash(sourceSchemaPath), generation.schemaHash);
  assert.equal(generation.previousSchemaHash, json(receiptPath).prerequisites.schemaHash);
  assert.equal(generation.previousMigrationHash, hash(json(receiptPath).prerequisites.migrationPath));
  assert(generation.records.some((record) => record.command.includes("--create-only") && record.exitCode === 0));
  const raw = read(generation.rawMigrationPath).toString().trimEnd();
  assert(read(migrationPath).toString().startsWith(raw), "Preserve the actual generated SQL before adding CHECKs");
  observations.push(await npm(["run", "db:migrate", "--", "--name", "system_config"], { env: { DATABASE_URL: dbConfig().url } }));
  await migrationStatus(dbConfig().url);
  observations.push(await npm(["run", "db:generate"], { env: { DATABASE_URL: dbConfig().url } }));
  assert.equal(read("node_modules/.prisma/client/schema.prisma").toString(), read(sourceSchemaPath).toString());
  assert.match(read("node_modules/.prisma/client/index.d.ts").toString(), /export type SystemConfig\s*=/);
  const replay = await freshDatabase(`a${plan.attemptId.split("-")[1]}_replay`);
  observations.push(...replay.observations);
  const fixture = baselineFixture("replay");
  const id = `phase007_migration_${dbConfig().runId}`;
  try {
    await deploy(replay.url, fixture);
    await migrationStatus(replay.url, fixture);
    observations.push(await sql(`INSERT INTO "User" (id,email,"passwordHash","createdAt","updatedAt") VALUES ('${id}','${id}@example.invalid','$2b$12$${"a".repeat(53)}','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z');`, replay.database));
    const before = await sql(`SELECT row_to_json(u) FROM "User" u WHERE id='${id}';`, replay.database);
    observations.push(before);
    await deploy(replay.url);
    const after = await sql(`SELECT row_to_json(u) FROM "User" u WHERE id='${id}';`, replay.database);
    observations.push(after);
    assert.deepEqual(JSON.parse(after.stdout.trim()), JSON.parse(before.stdout.trim()));
    const diff = await npm(["exec", "--", "prisma", "migrate", "diff", "--from-url", replay.url, "--to-schema-datamodel", sourceSchemaPath, "--exit-code"], { env: { DATABASE_URL: replay.url } });
    observations.push(diff);
    assert.equal(diff.exitCode, 0);
    await migrationStatus(replay.url);
    await runVitest("migration-replay", { pattern: "migration:", databaseUrl: replay.url });
    observations.push(await sql(`DELETE FROM "User" WHERE id='${id}';`, replay.database));
  } finally { removeFixture(fixture); await disposeDatabase(replay.database); }
  return { target, generationPath, generationHash: hash(generationPath), migrationHash: hash(migrationPath), schemaHash: hash(sourceSchemaPath), replayPreservedUser: true, drift: false };
}

async function mutations() {
  const rows = [];
  for (const mutation of ["default", "group"]) {
    const fixture = copyFixture(`mutation-${mutation}`);
    const original = read(migrationPath).toString();
    const changed = mutation === "default"
      ? original.replace('"isPublic" BOOLEAN NOT NULL DEFAULT false', '"isPublic" BOOLEAN NOT NULL DEFAULT true')
      : original.replace(/ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_group_check" CHECK \([^;]*\);\n?/, "");
    assert.notEqual(changed, original, `Mutation did not change ${mutation}`);
    fs.writeFileSync(path.join(fixture, migrationPath), changed);
    archive(`mutations/${mutation}.sql`, changed);
    const db = await freshDatabase(`a${plan.attemptId.split("-")[1]}_mut_${mutation}`);
    observations.push(...db.observations);
    try {
      await deploy(db.url, fixture);
      const pattern = mutation === "default" ? "default-private:" : "group-validation: unknown";
      const failed = await runVitest(`negative-${mutation}`, { cwd: fixture, pattern, databaseUrl: db.url, expected: 1 });
      const assertions = failed.raw.testResults.flatMap((result) => result.assertionResults).filter((entry) => entry.status === "failed");
      assert.equal(assertions.length, 1);
      assert(assertions[0].fullName.includes(mutation === "default" ? "default-private:" : "group-validation:"));
      assert(assertions[0].failureMessages.some((message) => mutation === "default" ? /false/.test(message) && /true/.test(message) : /promise resolved/i.test(message)), "Mutation failed for the wrong reason");
      rows.push({ mutation, underlyingExitCode: failed.result.exitCode, failedTests: failed.raw.numFailedTests, failedAssertion: assertions[0].fullName });
    } finally { await disposeDatabase(db.database); removeFixture(fixture); }
    const restored = await freshDatabase(`a${plan.attemptId.split("-")[1]}_ok_${mutation}`);
    observations.push(...restored.observations);
    try {
      await deploy(restored.url);
      const passed = await runVitest(`restored-${mutation}`, { pattern: mutation === "default" ? "default-private:" : "group-validation:", databaseUrl: restored.url });
      rows.at(-1).restoredTests = passed.raw.numPassedTests;
      await migrationStatus(restored.url);
    } finally { await disposeDatabase(restored.database); }
  }
  const fixture = copyFixture("mutation-projection");
  try {
    const file = "src/server/projections/public-user.ts";
    const original = read(file).toString();
    const mutated = original.replace('  "createdAt",', '  "createdAt",\n  "sessionVersion",');
    assert.notEqual(mutated, original);
    fs.writeFileSync(path.join(fixture, file), mutated);
    archive("mutations/public-user.ts", mutated);
    const failed = await runVitest("negative-projection", { cwd: fixture, files: ["config-models", "public-user"], pattern: "projection:", databaseUrl: dbConfig().url, expected: 1 });
    const assertions = failed.raw.testResults.flatMap((result) => result.assertionResults).filter((entry) => entry.status === "failed");
    assert(assertions.some((entry) => entry.fullName.includes("real Prisma selects")));
    assert(assertions.every((entry) => entry.fullName.includes("projection:")));
    assert(assertions.some((entry) => entry.failureMessages.some((message) => message.includes("sessionVersion"))));
    fs.writeFileSync(path.join(fixture, file), original);
    const passed = await runVitest("restored-projection", { cwd: fixture, files: ["config-models", "public-user"], pattern: "projection:", databaseUrl: dbConfig().url });
    rows.push({ mutation: "projection", underlyingExitCode: failed.result.exitCode, failedTests: failed.raw.numFailedTests, restoredTests: passed.raw.numPassedTests });
  } finally { removeFixture(fixture); }
  const restored = await runVitest("restored-card-tests", { files: ["config-models", "public-user"], databaseUrl: dbConfig().url });
  await migrationStatus(dbConfig().url);
  return { rows, restoredCardTests: restored.raw.numPassedTests, allMutationsObserved: rows.length === 3 };
}

async function evaluate() {
  if (key === "migration") return verifyMigration();
  if (key === "schema") {
    const scan = scanScope();
    const target = await assertDatabaseTarget();
    const checked = await runVitest("schema-cleanup", { pattern: "schema:|cleanup:", databaseUrl: dbConfig().url });
    const { Prisma } = require("@prisma/client");
    assert.deepEqual(Prisma.dmmf.datamodel.models.map(({ name }) => name), ["User", "SystemConfig"]);
    assert.equal(Prisma.prismaVersion.client, "6.19.0");
    const counts = await sql('SELECT (SELECT count(*) FROM "SystemConfig") AS configs, (SELECT count(*) FROM "User") AS users;');
    observations.push(counts);
    assert.equal(counts.stdout.trim(), "0|0");
    return { target, scan, tests: checked.raw.numPassedTests, fixtureRowsRemaining: 0 };
  }
  if (["default-private", "key-uniqueness", "group-validation", "user-fk"].includes(key)) {
    const checked = await runVitest(key, { files: key === "group-validation" ? ["config-models", "public-user"] : ["config-models"], pattern: `${key}:`, databaseUrl: dbConfig().url });
    return { tests: checked.raw.numPassedTests };
  }
  if (key === "projection") {
    const scan = scanScope();
    const checked = await runVitest("projection", { files: ["config-models", "public-user"], pattern: "projection:", databaseUrl: dbConfig().url });
    observations.push(await npm(["run", "typecheck"]));
    return { publicFields: 8, adminFields: 9, secretFields: 0, tests: checked.raw.numPassedTests, scan };
  }
  if (key === "mutation") return mutations();
  throw new Error(`Unknown case ${key}`);
}

async function quality(startHashes) {
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
  observations.push(await command("Prisma CLI and checkpoint network regression", ["tests/phase007/cli-network.mjs"]));
  artifacts.push({ path: `${directory}/cli-network.json`, sha256: hash(`${directory}/cli-network.json`) });
  for (const script of ["lint", "typecheck"]) observations.push(await npm(["run", script]));
  const tests = await runVitest("all-tests", { files: [], databaseUrl: dbConfig().url });
  const legacy = await runVitest("phase006-user-regression", { files: [], legacy: true, databaseUrl: dbConfig().url });
  observations.push(await npm(["run", "format:check"]));
  observations.push(await npm(["exec", "--", "prettier", "--check", "tests/lib/public-user.test.ts", "tests/integration/config-models.test.ts", "tests/phase007/*.{ts,mjs}", "tests/phase006/database.integration.ts"]));
  observations.push(await npm(["run", "build"]));
  observations.push(await command("node scripts/check-project-layout.mjs", ["scripts/check-project-layout.mjs"]));
  observations.push(await npm(["run", "verify:phase003"]));
  observations.push(await command("node scripts/test-phase-input-paths.mjs", ["scripts/test-phase-input-paths.mjs"]));
  const regressionPath = path.join(root, `.scaffold/phase007/${plan.attemptId}-validator-regression.json`);
  observations.push(await command("Dual-shell validator compatibility regression", [
    "scripts/test-validate-phase.mjs", "--shell", "both", "--case",
    "root-equality-empty-prefix-local-inputs-history-pass,recovery-history-pass,previous-required-case-removal",
    "--output", regressionPath,
  ]));
  const regression = JSON.parse(fs.readFileSync(regressionPath, "utf8"));
  assert.equal(regression.status, "PASS");
  assert.equal(regression.caseCount, 3);
  for (const [file, expected] of Object.entries(regression.testedSourceHashes)) assert.equal(hash(file), expected);
  archive("validator-regression.json", regression);
  const prototype = json(plan.cases[0].outputPath);
  requireReportBinding(prototype, plan.cases[0], hash(planPath), plan.sourcePaths, hash);
  for (const field of ["planHash", "inputHash", "denominator"]) {
    const mutated = structuredClone(prototype);
    mutated[field] = field === "denominator" ? 999 : "0".repeat(64);
    assert.throws(() => requireReportBinding(mutated, plan.cases[0], hash(planPath), plan.sourcePaths, hash), /REPORT_BINDING/);
  }
  assert.throws(() => requireHashCoverage({ ...startHashes, [sourceSchemaPath]: "0".repeat(64) }, plan.sourcePaths, hash, "SOURCE_HASH"), /SOURCE_HASH/);
  return { status: "PASS", planHash: hash(planPath), sourceHashes: startHashes, supportingChecks: plan.supportingChecks, observations, artifacts, testCount: tests.raw.numPassedTests, userRegressionTestCount: legacy.raw.numPassedTests, scan, simulation: true, productionTraffic: false };
}

try {
  if (process.argv.includes("--prepare-migration")) await prepareMigration();
  else {
    assert(!fs.existsSync(path.join(root, directory, "attempt.json")), "Record and freeze a new attempt after a failure");
    assert.equal(hash(`${directory}/frozen-plan.json`), hash(planPath));
    const startHashes = sourceHashes();
    if (process.argv.includes("--quality")) {
      const report = await quality(startHashes);
      requireHashCoverage(startHashes, plan.sourcePaths, hash, "QUALITY_SOURCE_CHANGED");
      write(`${directory}/quality.json`, report);
      console.warn(JSON.stringify({ status: "PASS", supportingChecks: report.supportingChecks.length, testCount: report.testCount }));
    } else {
      assert(item, "Pass a frozen --case or --quality");
      const details = await evaluate();
      requireHashCoverage(startHashes, plan.sourcePaths, hash, "SOURCE_CHANGED_DURING_TEST");
      write(item.outputPath, { testCaseId: item.testCaseId, command: item.command, status: "PASS", exitCode: 0, numerator: item.denominator, denominator: item.denominator, inputPath: item.inputPath, inputHash: hash(item.inputPath), planHash: hash(planPath), sourceHashes: startHashes, simulation: true, productionTraffic: false, details: { ...details, observations, artifacts } });
      console.warn(JSON.stringify({ status: "PASS", testCaseId: item.testCaseId }));
    }
  }
} catch (error) {
  const failure = `${directory}/attempt.json`;
  if (!fs.existsSync(path.join(root, failure))) write(failure, { phase: 7, attemptId: plan.attemptId, status: "FAIL", artifactCommit: null, command: item?.command ?? (process.argv.includes("--prepare-migration") ? "node docs/phase-plans/verify-phase007.mjs --prepare-migration" : "node docs/phase-plans/verify-phase007.mjs --quality"), planHash: hash(planPath), reason: redact(error.stack), observation: error.observation, observations, artifacts, recordedAt: new Date().toISOString() });
  console.error(redact(error.stack));
  process.exitCode = 1;
}
