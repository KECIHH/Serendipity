import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { root, plan, planPath, receiptPath, directory, read, json, sha, hash, write, git, npm, npmCli, command, environment, dbConfig, assertDatabaseTarget, freshDatabase, sql, copyFixture, removeFixture, inventory, migrationPath, redact, terminateChild } from "./phase006-runtime.mjs";
import { requireHashCoverage, requireReportBinding } from "../../scripts/phase-evidence.mjs";

const sourceHashes = () => Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(file)]));
const observations = [];
const artifacts = [];
const key = process.argv[process.argv.indexOf("--case") + 1];
const item = plan.cases.find((entry) => entry.testCaseId === `Phase006:${key}`);
const require = createRequire(path.join(root, "package.json"));

function archive(name, bytes) {
  const file = `${directory}/${name}`;
  write(file, bytes);
  artifacts.push({ path: file, sha256: hash(file) });
  return file;
}

async function runVitest(label, { cwd = root, files = ["tests/lib/db.test.ts"], pattern, databaseUrl, expected = 0 } = {}) {
  const rawFile = path.join(root, `.scaffold/phase006/${plan.attemptId}-${label}-vitest.json`);
  assert(!fs.existsSync(rawFile), `Refuse to overwrite raw test run: ${rawFile}`);
  const args = ["run", "test", "--"];
  if (databaseUrl) args.push("--config", "tests/phase006/vitest.database.config.mjs");
  args.push(...files);
  if (pattern) args.push("-t", pattern);
  args.push("--reporter=json", `--outputFile=${rawFile}`);
  const result = await npm(args, { cwd, expected: null, env: databaseUrl ? { DATABASE_URL: databaseUrl } : {} });
  observations.push(result);
  assert(fs.existsSync(rawFile), `Vitest did not generate a real report: ${result.stderr}`);
  const raw = JSON.parse(redact(fs.readFileSync(rawFile, "utf8")));
  archive(`${label}-vitest.json`, raw);
  if (expected === 0) {
    assert.equal(result.exitCode, 0, JSON.stringify(raw.testResults));
    assert.equal(raw.numFailedTests, 0);
    assert(raw.numPassedTests > 0);
    assert.equal(raw.success, true);
  } else {
    assert(result.exitCode !== 0 && result.exitCode !== null, "Mutation must have a real nonzero test exit");
    assert(raw.numFailedTests > 0);
    assert.equal(raw.success, false);
  }
  return { result, raw };
}

async function deploy(url, cwd = root) {
  await assertDatabaseTarget(dbConfig(), url);
  const result = await npm(["exec", "--", "prisma", "migrate", "deploy"], { cwd, env: { DATABASE_URL: url } });
  observations.push(result);
  return result;
}

async function drop(database) {
  assert(database.startsWith(`${dbConfig().database}_`));
  observations.push(await sql(`DROP DATABASE "${database}" WITH (FORCE);`, "postgres"));
}

async function status(url, cwd = root) {
  await assertDatabaseTarget(dbConfig(), url);
  const result = await npm(["exec", "--", "prisma", "migrate", "status"], { cwd, env: { DATABASE_URL: url } });
  observations.push(result);
  assert.match(result.stdout, /Database schema is up to date/);
  return result;
}

async function negativeEmail() {
  const rows = [];
  for (const mutation of ["unique", "check"]) {
    const fixture = copyFixture(`email-${mutation}`);
    const original = read(migrationPath).toString();
    let mutated;
    if (mutation === "unique") {
      const schema = read("prisma/schema.prisma", fixture).toString();
      const next = schema.replace(/(email\s+String)\s+@unique/, "$1");
      assert.notEqual(next, schema);
      fs.writeFileSync(path.join(fixture, "prisma/schema.prisma"), next);
      mutated = original.replace(/CREATE UNIQUE INDEX "User_email_key" ON "User"\("email"\);\n/, "");
    } else mutated = original.replace(/ALTER TABLE "User" ADD CONSTRAINT "User_email_canonical_check" CHECK \([\s\S]*?\n\);\n/, "");
    assert.notEqual(mutated, original);
    fs.writeFileSync(path.join(fixture, migrationPath), mutated);
    archive(`mutations/email-${mutation}.sql`, mutated);
    archive(`mutations/email-${mutation}.prisma`, read("prisma/schema.prisma", fixture));
    const prefix = plan.attemptId.replaceAll("-", "_");
    const database = await freshDatabase(`${prefix}_${mutation}`);
    try {
      await deploy(database.url, fixture);
      const outcome = await runVitest(`negative-email-${mutation}`, { cwd: fixture, files: [], pattern: mutation === "unique" ? "email-unique:" : "email-check: rejects", databaseUrl: database.url, expected: 1 });
      const failed = outcome.raw.testResults.flatMap((result) => result.assertionResults).filter((entry) => entry.status === "failed");
      assert(failed.some((entry) => entry.failureMessages.some((message) => /promise resolved/i.test(message))), "Mutation must expose a successful forbidden database write");
      rows.push({ mutation, failedTests: outcome.raw.numFailedTests, underlyingExitCode: outcome.result.exitCode, failedAssertions: failed.map(({ fullName }) => fullName) });
    } finally { await drop(database.database); removeFixture(fixture); }
    const restored = await freshDatabase(`${prefix}_${mutation}_restored`);
    try {
      await deploy(restored.url);
      const outcome = await runVitest(`restored-email-${mutation}`, { files: [], pattern: mutation === "unique" ? "email-unique:" : "email-check:", databaseUrl: restored.url });
      rows.at(-1).restoredTests = outcome.raw.numPassedTests;
      await status(restored.url);
    } finally { await drop(restored.database); }
  }
  return { rows };
}

async function negativeRole() {
  const fixture = copyFixture("role");
  const original = read("prisma/schema.prisma").toString();
  const mutated = original.replace(/enum Role \{\n([\s\S]*?)\n\}/, "enum Role {\n$1\n  TEST_ONLY_ROLE\n}");
  assert.notEqual(mutated, original);
  const database = await freshDatabase(`${plan.attemptId.replaceAll("-", "_")}_role`);
  let generated;
  try {
    await deploy(database.url, fixture);
    fs.writeFileSync(path.join(fixture, "prisma/schema.prisma"), mutated);
    archive("mutations/third-role.prisma", mutated);
    const result = await npm(["run", "db:migrate", "--", "--name", "mutation_role", "--skip-generate"], { cwd: fixture, env: { DATABASE_URL: database.url } });
    observations.push(result);
    generated = inventory("prisma/migrations", fixture).filter((file) => file.includes("_mutation_role/") && file.endsWith("migration.sql"));
    assert.equal(generated.length, 1);
    const content = read(generated[0], fixture).toString();
    assert.match(content, /ALTER TYPE "Role" ADD VALUE 'TEST_ONLY_ROLE'/);
    archive("mutations/third-role-generated.sql", content);
    const values = await sql('SELECT unnest(enum_range(NULL::"Role"));', database.database);
    observations.push(values);
    assert.deepEqual(values.stdout.trim().split(/\r?\n/), ["USER", "ADMIN", "TEST_ONLY_ROLE"]);
    const failed = await runVitest("negative-role", { cwd: fixture, files: [], pattern: "schema:", databaseUrl: database.url, expected: 1 });
    const assertions = failed.raw.testResults.flatMap((result) => result.assertionResults).filter((entry) => entry.status === "failed");
    assert.equal(assertions.length, 1);
    assert.match(assertions[0].fullName, /schema:/);
    assert(assertions[0].failureMessages.some((message) => message.includes("TEST_ONLY_ROLE")), "The enum contract must reject the actual third PostgreSQL value");
  } finally { await drop(database.database); removeFixture(fixture); }
  const restored = await freshDatabase(`${plan.attemptId.replaceAll("-", "_")}_role_restored`);
  try {
    await deploy(restored.url);
    await runVitest("restored-role", { files: [], pattern: "schema:", databaseUrl: restored.url });
    await status(restored.url);
  } finally { await drop(restored.database); }
  return { generatedMigration: generated[0], generatedEnumChange: true, restoredEnum: ["USER", "ADMIN"] };
}

async function negativeCache() {
  const fixture = copyFixture("cache");
  try {
    const original = read("src/server/db.ts").toString();
    const mutated = original.replace("if (!globalForDb[DB_CACHE_KEY]) {", "{ // mutation: discard cache reuse");
    assert.notEqual(mutated, original);
    fs.writeFileSync(path.join(fixture, "src/server/db.ts"), mutated);
    archive("mutations/no-cache.ts", mutated);
    const failed = await runVitest("negative-cache", { cwd: fixture, pattern: "cache: repeated", expected: 1 });
    const assertions = failed.raw.testResults.flatMap((result) => result.assertionResults).filter((entry) => entry.status === "failed");
    assert.equal(assertions.length, 1);
    assert.match(assertions[0].fullName, /cache: repeated/);
    assert(assertions[0].failureMessages.some((message) => /toBe|Object.is/.test(message)));
    fs.writeFileSync(path.join(fixture, "src/server/db.ts"), original);
    await runVitest("restored-cache", { cwd: fixture, pattern: "cache: repeated" });
    return { underlyingExitCode: failed.result.exitCode, failedAssertion: assertions[0].fullName, restored: true };
  } finally { removeFixture(fixture); }
}

async function studio() {
  const config = dbConfig();
  const target = await assertDatabaseTarget(config);
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const selected = server.address().port; server.close(() => resolve(selected)); });
  });
  const child = spawn(process.execPath, [npmCli, "run", "db:studio", "--", "--hostname", "127.0.0.1", "--port", String(port), "--browser", "none"], { cwd: root, env: environment({ DATABASE_URL: config.url }), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const record = { command: `npm run db:studio -- --hostname 127.0.0.1 --port ${port} --browser none`, stdout: "", stderr: "", exitCode: null, shutdown: null };
  child.stdout.on("data", (chunk) => { record.stdout += redact(chunk); });
  child.stderr.on("data", (chunk) => { record.stderr += redact(chunk); });
  const closed = new Promise((resolve) => child.once("close", (code) => { record.exitCode = code; resolve(); }));
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null) {
      try { const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1000) }); if (response.ok) { ready = true; break; } } catch { /* Startup poll is local and bounded. */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(ready, `Studio failed readiness: ${record.stderr}`);
    const result = await command("Playwright Prisma Studio User inventory", ["tests/phase006/studio.mjs", baseUrl, directory]);
    observations.push(result);
    for (const file of ["studio.json", "studio.html", "studio.png"]) artifacts.push({ path: `${directory}/${file}`, sha256: hash(`${directory}/${file}`) });
    const browser = json(`${directory}/studio.json`);
    assert.equal(browser.status, "PASS");
    assert.equal(browser.verifiedFields.length, 13);
    assert.equal(browser.publicRequestsCompleted, 0);
    return { target, browser, startupObserved: true };
  } finally { terminateChild(child); await closed; record.shutdown = "TASK_OWNED_SERVER_TERMINATED_AFTER_BROWSER_CHECK"; observations.push(record); }
}

async function evaluate() {
  if (key === "unit-cache" || key === "unit-errors" || key === "unit-modes") {
    const outcome = await runVitest(key, { pattern: `${key.replace("unit-", "")}:` });
    assert.equal(outcome.raw.numPassedTests, 1);
    return { testCount: 1 };
  }
  if (key === "auto-generate") {
    observations.push(await npm(["run", "db:generate"]));
    assert.match(read("node_modules/.prisma/client/index.d.ts").toString(), /export type User\s*=/);
    return { generatedTypesHash: hash("node_modules/.prisma/client/index.d.ts") };
  }
  if (key === "auto-migrate") {
    const target = await assertDatabaseTarget();
    const generation = json("docs/evidence/attempts/Phase006/setup/migration-generation.json");
    assert.equal(generation.migrationHash, hash(migrationPath));
    assert(generation.records.some((entry) => entry.command.includes("--create-only") && entry.exitCode === 0));
    const before = await sql('SELECT tablename FROM pg_tables WHERE schemaname=\'public\' ORDER BY tablename;');
    observations.push(before);
    observations.push(await npm(["run", "db:migrate", "--", "--name", "init_user"], { env: { DATABASE_URL: dbConfig().url } }));
    const checks = await sql('SELECT conname FROM pg_constraint WHERE conrelid=\'"User"\'::regclass AND contype=\'c\' ORDER BY conname;');
    observations.push(checks);
    assert.deepEqual(checks.stdout.trim().split(/\r?\n/), ["User_email_canonical_check", "User_revision_nonnegative", "User_session_version_nonnegative"]);
    return { target, constraints: checks.stdout.trim().split(/\r?\n/), generationHash: hash("docs/evidence/attempts/Phase006/setup/migration-generation.json") };
  }
  if (key === "auto-status") {
    await status(dbConfig().url);
    const version = await sql("SHOW server_version;"); observations.push(version); assert.match(version.stdout, /^17\./);
    return { version: version.stdout.trim(), migrations: inventory("prisma/migrations") };
  }
  if (key === "integration-client") {
    assert(fs.statSync(path.join(root, "node_modules/.prisma/client")).isDirectory());
    assert.equal(require("@prisma/client/package.json").version, "6.19.0");
    const { Prisma } = require("@prisma/client");
    assert.equal(Prisma.prismaVersion.client, "6.19.0");
    assert.deepEqual(Prisma.dmmf.datamodel.models.map(({ name }) => name), ["User"]);
    assert.equal(read("node_modules/.prisma/client/schema.prisma").toString(), read("prisma/schema.prisma").toString());
    return { clientVersion: Prisma.prismaVersion.client, generatedSchemaHash: hash("node_modules/.prisma/client/schema.prisma"), typeDeclarationsHash: hash("node_modules/.prisma/client/index.d.ts") };
  }
  if (key === "integration-types") {
    observations.push(await npm(["exec", "--", "tsc", "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "tests/phase006/user-types.ts"]));
    return { exactUserFields: 13, exactRoles: ["USER", "ADMIN"], exactStatuses: ["ACTIVE", "DISABLED"] };
  }
  if (key === "integration-revision") {
    const target = await assertDatabaseTarget();
    const database = await runVitest("database-integration", { files: [], databaseUrl: dbConfig().url });
    const auth = await runVitest("email-normalizer", { files: ["tests/lib/auth.test.ts"] });
    return { target, integrationTests: database.raw.numPassedTests, normalizationTests: auth.raw.numPassedTests };
  }
  if (key === "negative-email") return negativeEmail();
  if (key === "negative-role") return negativeRole();
  if (key === "negative-cache") return negativeCache();
  if (key === "auto-studio") return studio();
  throw new Error(`Unknown case ${key}`);
}

async function quality(startHashes) {
  const changed = [...git(["diff", "--name-only", "HEAD"]).trim().split(/\r?\n/), ...git(["ls-files", "--others", "--exclude-standard"]).trim().split(/\r?\n/)].filter(Boolean);
  for (const file of changed) assert(plan.modificationScope.some((scope) => scope.endsWith("/") ? file.startsWith(scope) : file === scope), `Out-of-scope change: ${file}`);
  assert(!fs.existsSync(path.join(root, "src/lib/db.ts")));
  assert(!inventory("src/app/api").length);
  assert(!inventory("prisma").some((file) => /seed/i.test(file)));
  for (const input of json(receiptPath).pinnedInputs) assert.equal(hash(input.path), input.sha256);
  const scripts = json("package.json").scripts;
  assert.equal(scripts["db:generate"], "prisma generate");
  assert.equal(scripts["db:migrate"], "prisma migrate dev");
  assert.equal(scripts["db:studio"], "prisma studio");
  assert.equal(json("package.json").dependencies["@prisma/client"], "6.19.0");
  assert.equal(json("package.json").devDependencies.prisma, "6.19.0");
  const node = await command("node --version", ["--version"]); observations.push(node); assert.equal(node.stdout.trim(), "v24.19.0");
  const npmVersion = await npm(["--version"]); observations.push(npmVersion); assert.equal(npmVersion.stdout.trim(), "11.7.0");
  observations.push(await command("Prisma CLI and forked checkpoint network regression", ["tests/phase006/cli-network.mjs"]));
  artifacts.push({ path: `${directory}/cli-network.json`, sha256: hash(`${directory}/cli-network.json`) });
  for (const name of ["lint", "typecheck"]) observations.push(await npm(["run", name]));
  const tests = await runVitest("all-tests", { files: [] });
  assert.equal(tests.raw.numPendingTests, 0);
  observations.push(await npm(["run", "format:check"]));
  observations.push(await npm(["exec", "--", "prettier", "--check", "tests/lib/*.ts", "tests/phase006/*.{ts,mjs,cjs}"]));
  observations.push(await npm(["run", "build"]));
  observations.push(await command("node scripts/check-project-layout.mjs", ["scripts/check-project-layout.mjs"]));
  observations.push(await npm(["run", "verify:phase003"]));
  const baseline = json("docs/runtime-baseline.json");
  const pkg = json("package.json"), lock = json("package-lock.json");
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.equal(version, baseline.dependencyVersions[name], `Runtime registry ${name}`);
    assert.equal(lock.packages[`node_modules/${name}`].version, version, `Lockfile version ${name}`);
    assert.equal(lock.packages[""].dependencies?.[name] ?? lock.packages[""].devDependencies?.[name], version, `Lockfile root ${name}`);
  }
  const prototype = json(plan.cases[0].outputPath);
  requireReportBinding(prototype, plan.cases[0], hash(planPath), plan.sourcePaths, hash);
  for (const field of ["planHash", "inputHash", "denominator"]) {
    const mutated = structuredClone(prototype);
    mutated[field] = field === "denominator" ? 999 : "0".repeat(64);
    assert.throws(() => requireReportBinding(mutated, plan.cases[0], hash(planPath), plan.sourcePaths, hash), /REPORT_BINDING/);
  }
  const modifiedHashes = { ...startHashes, "src/server/db.ts": "0".repeat(64) };
  assert.throws(() => requireHashCoverage(modifiedHashes, plan.sourcePaths, hash, "SOURCE_HASH"), /SOURCE_HASH/);
  return { status: "PASS", testCount: tests.raw.numPassedTests, supportingChecks: plan.supportingChecks, sourceHashes: startHashes, planHash: hash(planPath), artifacts, observations, simulation: true, productionTraffic: false };
}

try {
  assert(!fs.existsSync(path.join(root, directory, "attempt.json")), "Failed attempt requires a new frozen plan");
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
} catch (error) {
  const failure = `${directory}/attempt.json`;
  if (!fs.existsSync(path.join(root, failure))) write(failure, { phase: 6, attemptId: plan.attemptId, status: "FAIL", artifactCommit: null, command: item?.command ?? "node docs/phase-plans/verify-phase006.mjs --quality", planHash: hash(planPath), reason: redact(error.stack), observation: error.observation, observations, artifacts, recordedAt: new Date().toISOString() });
  console.error(redact(error.stack));
  process.exitCode = 1;
}
