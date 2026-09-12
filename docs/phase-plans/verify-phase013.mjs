import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  requirePhase013Inputs,
  requirePhase013Generation,
  requirePhase013FailureChain,
  requirePhase013ImplementationBinding,
  getPhase013ImplementationSnapshot,
  requirePhase013Vitest,
  requirePhase013CaseMapping,
  requirePhase013Discovery,
  phase013NegativeControlDefinitions,
  phase013NegativeControlContract,
  requirePhase013NegativeControl,
  phase013BusinessObservations,
  phase013FixtureBinding,
  requirePhase013BrowserReport,
} from "./phase013-evidence.mjs";
import {
  requireHashCoverage,
  requireReportBinding,
  requirePriorCaseBinding,
} from "../../scripts/phase-evidence.mjs";
import {
  root,
  plan,
  planPath,
  receiptPath,
  directory,
  configPath,
  generationPath,
  migrationPath,
  read,
  json,
  sha,
  hash,
  write,
  git,
  npm,
  command,
  dbConfig,
  assertDatabaseTarget,
  sql,
  copyFixture,
  removeFixture,
  inventory,
  setCommandObserver,
  scanSensitiveText,
  safeDiagnostics,
} from "./phase013-runtime.mjs";

const runnerCommand = "node docs/phase-plans/verify-phase013.mjs --all";
const startedAt = new Date().toISOString();
const startPlanHash = hash(planPath);
const observations = [];
const artifacts = new Map();
const requiredKeys = [
  "create-read",
  "disable-enable",
  "rotate-revoke",
  "authorization",
  "crypto-redaction",
  "failure-atomicity",
];
const supportingChecks = [
  "plan-and-inputs",
  "dependency-versions",
  "format-check",
  "lint",
  "typecheck",
  "test-discovery",
  "phase013-evidence-guards",
  "validator-regression",
  "prisma-cli-network-isolation",
  "migration-schema",
  "api-contract",
  "card-test",
  "test",
  "phase006-user-regression",
  "browser",
  "negative-controls",
  "evidence-binding",
  "secret-and-scope-scan",
  "project-layout",
  "build",
];
const tables = [
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
];
const sourceHashes = () => Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(file)]));
const inputDependencies = { hashFile: hash, readJson: json, readBytes: read, git };

function scan(value, label) {
  return scanSensitiveText(typeof value === "string" ? value : JSON.stringify(value), label);
}

function artifact(file) {
  if (!/\.(?:png|ico|woff2?)$/i.test(file)) scan(read(file).toString(), file);
  const entry = { path: file, sha256: hash(file) };
  artifacts.set(file, entry);
  return entry;
}

function archive(name, value) {
  scan(value, name);
  const file = directory + "/" + name;
  write(file, value);
  artifact(file);
  return file;
}

function readRawReport(file) {
  assert(fs.existsSync(file), "The actual process did not produce its raw report");
  const value = fs.readFileSync(file, "utf8");
  scan(value, path.basename(file));
  return JSON.parse(value);
}

function testEnvironment() {
  const config = dbConfig();
  const fixture = path.join(root, configPath);
  return {
    DATABASE_URL: config.appUrl,
    PHASE007_DATABASE_URL: config.url,
    PHASE008_DATABASE_URL: config.url,
    PHASE009_DATABASE_URL: config.url,
    PHASE009_RUNTIME_DATABASE_URL: config.appUrl,
    PHASE010_FIXTURE_CONFIG: fixture,
    PHASE011_FIXTURE_CONFIG: fixture,
    PHASE012_FIXTURE_CONFIG: fixture,
    PHASE013_FIXTURE_CONFIG: fixture,
    PHASE012_DATABASE_URL: config.url,
    PHASE012_RUNTIME_DATABASE_URL: config.appUrl,
    PHASE013_DATABASE_URL: config.url,
    PHASE013_RUNTIME_DATABASE_URL: config.appUrl,
  };
}

async function assertIdentity() {
  const config = dbConfig();
  const target = await assertDatabaseTarget(config);
  const identity = await sql(
    "SELECT current_database(), current_setting('server_version'), shobj_description(oid, 'pg_database') FROM pg_database WHERE datname=current_database();",
  );
  const [database, version, marker] = identity.stdout.trim().split("|");
  assert.equal(database, target.database);
  assert.match(version, /^17\./);
  assert.equal(marker, target.marker);
  return { ...target, version };
}

function generationBinding() {
  const generation = json(generationPath);
  requirePhase013Generation(generation, {
    receipt: json(receiptPath),
    hashFile: hash,
    readText: (file) => read(file).toString(),
    migrationPath,
  });
  return generation;
}

async function migrationChecks() {
  generationBinding();
  const target = await assertIdentity();
  await npm(["exec", "--", "prisma", "migrate", "deploy"], {
    env: { DATABASE_URL: dbConfig().url },
  });
  const status = await npm(["exec", "--", "prisma", "migrate", "status"], {
    env: { DATABASE_URL: dbConfig().url },
  });
  assert.match(status.stdout, /Database schema is up to date/);
  await npm(["run", "db:generate"], { env: { DATABASE_URL: dbConfig().url } });
  await sql(
    "REVOKE CREATE ON SCHEMA public FROM PUBLIC;\n" +
      "GRANT USAGE ON SCHEMA public TO phase013_app;\n" +
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "User", "SystemConfig", "TravelRecord", "ChatMessage", "ApiKeyConfig" TO phase013_app;\n' +
      'GRANT SELECT, INSERT ON TABLE "AuditLog" TO phase013_app;\n' +
      'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "AuditLog" FROM phase013_app;\n' +
      'GRANT SELECT ON TABLE "_prisma_migrations" TO phase013_app;\n' +
      'GRANT SELECT, INSERT ON TABLE "AuthSession", "AuthLoginAttempt" TO phase013_app;\n' +
      'GRANT UPDATE (status, "lastSeenAt", "revokedAt") ON TABLE "AuthSession" TO phase013_app;\n' +
      'GRANT UPDATE (status, "completedAt") ON TABLE "AuthLoginAttempt" TO phase013_app;\n' +
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AdminCommandReceipt", "KeyRotationRun" TO phase013_app;\n' +
      "GRANT EXECUTE ON FUNCTION public.auth_now() TO phase013_app;",
  );
  const privilege = await sql(
    "SELECT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR d.datdba=r.oid) FROM pg_roles r CROSS JOIN pg_database d WHERE r.rolname='phase013_app' AND d.datname=current_database();",
  );
  assert.equal(privilege.stdout.trim(), "f");
  const tableReport = await sql(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;",
  );
  assert.deepEqual(tableReport.stdout.trim().split(/\r?\n/), [...tables, "_prisma_migrations"]);
  const repaired = await sql(
    "SELECT public.key_rotation_candidates_valid('[]'::jsonb), public.key_rotation_candidates_valid('[{}]'::jsonb);",
  );
  assert.equal(repaired.stdout.trim(), "t|f");
  const applied = await sql(
    'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name;',
  );
  const expected = json(receiptPath).prerequisites.migrations.map(
    (entry) => entry.path.split("/")[2],
  );
  expected.push(migrationPath.split("/")[2]);
  assert.deepEqual(applied.stdout.trim().split(/\r?\n/), expected);
  artifact(migrationPath);
  artifact(generationPath);
  return {
    target,
    schemaHash: hash("prisma/schema.prisma"),
    migrationHash: hash(migrationPath),
    previousMigrationsPreserved: 7,
    appliedMigrations: 8,
    productTables: tables,
    runtimeRole: "phase013_app",
    migrationRole: "phase013_runner",
    runtimeOwner: false,
    runtimeSuperuser: false,
  };
}

async function runVitest(
  label,
  { files = [], cwd = root, pattern, legacy = false, expectedFailure = false } = {},
) {
  assert.match(label, /^[a-z0-9-]+$/);
  const rawPath = path.join(
    root,
    ".scaffold/phase013/" + plan.attemptId + "-" + label + "-vitest.json",
  );
  assert(!fs.existsSync(rawPath), "Raw evidence is immutable: " + label);
  const args = ["run", "test", "--"];
  if (legacy) args.push("--config", "tests/phase006/vitest.database.config.mjs");
  args.push(...files);
  if (pattern) args.push("-t", pattern);
  args.push(
    "--no-file-parallelism",
    "--reporter=default",
    "--reporter=json",
    "--outputFile=" + rawPath,
  );
  const result = await npm(args, {
    cwd,
    env: testEnvironment(),
    expected: null,
    timeoutMs: 1_800_000,
  });
  const raw = readRawReport(rawPath);
  const reportPath = archive(label + "-vitest.json", raw);
  assert(Number.isInteger(result.exitCode) && !result.timedOut);
  if (expectedFailure)
    assert.notEqual(
      result.exitCode,
      0,
      "The security mutation did not make an original assertion fail",
    );
  else assert.equal(result.exitCode, 0, "The actual required test command failed");
  const assertions = requirePhase013Vitest(raw, {
    base: cwd,
    expectedFailure,
    allowFiltered: Boolean(pattern),
  });
  return { result, raw, assertions, reportPath };
}

async function discoverTests() {
  const rawPath = path.join(root, ".scaffold/phase013/" + plan.attemptId + "-test-discovery.json");
  assert(!fs.existsSync(rawPath));
  const result = await npm(
    ["exec", "--", "vitest", "list", "--no-file-parallelism", "--json=" + rawPath],
    { env: testEnvironment() },
  );
  const discovery = readRawReport(rawPath);
  assert(Array.isArray(discovery) && discovery.length > 0);
  const reportPath = archive("test-discovery.json", discovery);
  return { result, discovery, reportPath };
}

function executionDependencyHashes() {
  const pkg = json("package.json");
  const files = [
    ...Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).map(
      (name) => "node_modules/" + name + "/package.json",
    ),
    ".scaffold/tools/node_modules/npm/package.json",
    ".scaffold/tools/node_modules/npm/bin/npm-cli.js",
    "node_modules/prisma/build/index.js",
    "node_modules/.prisma/client/schema.prisma",
    "node_modules/vitest/vitest.mjs",
    "node_modules/tsx/dist/cli.mjs",
    "vitest/stubs/server-only.ts",
    "scripts/test-phase-input-paths.mjs",
    "scripts/verify-phase003.mjs",
    "scripts/phase003-evidence.mjs",
    "scripts/checkpoint-history.mjs",
  ];
  return Object.fromEntries([...new Set(files)].sort().map((file) => [file, hash(file)]));
}

function scanScope() {
  const receipt = json(receiptPath);
  assert.deepEqual(
    inventory("prisma/migrations")
      .filter((file) => file.endsWith("/migration.sql"))
      .sort(),
    [...receipt.prerequisites.migrations.map((entry) => entry.path), migrationPath].sort(),
  );
  for (const previous of receipt.prerequisites.migrations)
    assert.equal(hash(previous.path), previous.sha256);
  const schema = read("prisma/schema.prisma").toString();
  assert.deepEqual(
    [...schema.matchAll(/^model (\w+)\s*\{/gm)].map((match) => match[1]).sort(),
    tables,
  );
  const files = [
    ...inventory("src/server/security"),
    ...inventory("src/server/admin"),
    ...inventory("src/components/admin"),
    ...inventory("src/app/api/admin"),
    ...inventory("src/app/admin"),
    ...inventory("docs/evidence/attempts/Phase013"),
  ];
  for (const file of files)
    if (!/\.(?:png|ico|woff2?)$/i.test(file)) scan(read(file).toString(), file);
  scan(observations, "actual command observations");
  return {
    previousMigrationsPreserved: 7,
    modelCount: tables.length,
    generatedSecretHits: 0,
    sensitiveEvidenceHits: 0,
    scannedBeforeRedaction: true,
    filesScanned: files.length,
  };
}

async function negativeControls() {
  const definitions = phase013NegativeControlDefinitions();
  assert.deepEqual(
    definitions.map((entry) => entry.id),
    plan.negativeControls.map((entry) => entry.id),
  );
  const rows = [];
  for (const definition of definitions) {
    const control = plan.negativeControls.find((entry) => entry.id === definition.id);
    assert.equal(
      definition.file,
      control.sourcePath,
      "Frozen negative control must bind its actual mutation source",
    );
    const failureContract = phase013NegativeControlContract(definition.id, read);
    const baseline = await runVitest("baseline-" + definition.id, {
      files: definition.files,
      pattern: definition.pattern,
    });
    const fixture = copyFixture("mutation-" + definition.id);
    const original = read(definition.file, fixture).toString();
    const changedSources = [];
    let negative;
    let failureEvidence;
    try {
      for (const [file, expected] of Object.entries(failureContract.testSourceHashes))
        assert.equal(hash(file, fixture), expected, "Mutation must preserve original test bytes");
      for (const point of [definition, ...(definition.additionalMutations ?? [])]) {
        assert(plan.sourcePaths.includes(point.file));
        const source = read(point.file, fixture).toString();
        assert.equal(
          source.split(point.before).length - 1,
          1,
          "A mutation must match exactly one intended guard",
        );
        const mutated = source.replace(point.before, point.after);
        fs.writeFileSync(path.join(fixture, point.file), mutated);
        changedSources.push({
          sourcePath: point.file,
          originalHash: sha(source),
          mutatedHash: sha(mutated),
        });
      }
      archive("mutations/" + definition.id + ".json", {
        sourcePath: definition.file,
        changedSources,
        testFiles: definition.files,
        testPattern: definition.pattern ?? null,
        originalCase: control.originalCase,
        failureContract,
        simulation: true,
        productionTraffic: false,
      });
      negative = await runVitest("negative-" + definition.id, {
        files: definition.files,
        pattern: definition.pattern,
        cwd: fixture,
        expectedFailure: true,
      });
      failureEvidence = requirePhase013NegativeControl(definition.id, {
        baselineRaw: baseline.raw,
        baselineRecord: baseline.result,
        negativeRaw: negative.raw,
        negativeRecord: negative.result,
        readBytes: read,
        expectedContract: failureContract,
      });
      assert.deepEqual(failureEvidence.contract, failureContract);
      for (const [file, expected] of Object.entries(failureContract.testSourceHashes))
        assert.equal(
          hash(file, fixture),
          expected,
          "Negative execution changed original test bytes",
        );
    } finally {
      removeFixture(fixture);
    }
    assert.equal(
      hash(definition.file),
      sha(original),
      "The isolated mutation changed the real product source",
    );
    for (const entry of changedSources) assert.equal(hash(entry.sourcePath), entry.originalHash);
    rows.push({
      id: definition.id,
      sourcePath: definition.file,
      originalHash: sha(original),
      changedSources,
      baseline: baseline.result,
      baselineReportPath: baseline.reportPath,
      negative: negative.result,
      negativeReportPath: negative.reportPath,
      failureEvidence,
      failedAssertions: negative.assertions
        .filter((entry) => entry.status === "failed")
        .map(({ file, fullName }) => ({ file, fullName })),
      restoredSourceHash: hash(definition.file),
    });
  }
  const restored = await runVitest("restored-card", {
    files: ["admin/api-keys", "admin/logs", "secret-envelope"],
  });
  const restoredMappings = requirePhase013CaseMapping(plan, restored.assertions);
  return {
    rows,
    restoredReportPath: restored.reportPath,
    restoredTestCount: restored.raw.numPassedTests,
    restoredMappings,
    sourceUnchanged: true,
  };
}

async function browserChecks() {
  const rawPath = path.join(root, ".scaffold/phase013/" + plan.attemptId + "-browser.json");
  assert(!fs.existsSync(rawPath));
  const result = await command(
    "Phase013 real Auth.js HTTP and browser checks",
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "tests/phase013/browser.mjs",
      "--output",
      rawPath,
    ],
    {
      env: testEnvironment(),
      expected: null,
      timeoutMs: 900_000,
    },
  );
  const report = readRawReport(rawPath);
  const reportPath = archive("browser.json", report);
  assert.equal(result.exitCode, 0);
  const summary = requirePhase013BrowserReport(report);
  for (const entry of report.artifacts) {
    assert.equal(hash(entry.path), entry.sha256);
    artifact(entry.path);
  }
  return { reportPath, reportHash: hash(reportPath), ...summary, result };
}

function checkPlan() {
  assert(
    !fs.existsSync(path.join(root, directory, "attempt.json")),
    "Create a new attempt after a recorded failure",
  );
  assert.equal(plan.phase, 13);
  assert.equal(plan.testMode, "full");
  assert.equal(plan.crossAttemptReuse, "disabled");
  assert.deepEqual(
    plan.requiredCaseIds,
    requiredKeys.map((key) => "Phase013:" + key),
  );
  assert.deepEqual(
    plan.cases.map((item) => item.testCaseId),
    plan.requiredCaseIds,
  );
  assert(plan.cases.every((item) => item.denominator === 1 && item.command === runnerCommand));
  assert.deepEqual(plan.supportingChecks, supportingChecks);
  assert.equal(hash(directory + "/frozen-plan.json"), startPlanHash);
  const receipt = json(receiptPath);
  requirePhase013Inputs(receipt, inputDependencies);
  requirePhase013FailureChain(plan, { readJson: json, hashFile: hash, git });
  for (const previous of plan.previousAttempts)
    requirePriorCaseBinding(plan, json(previous.planPath), { readJson: json, hashFile: hash });
  generationBinding();
  return receipt;
}

async function all() {
  const receipt = checkPlan();
  for (const item of plan.cases) assert(!fs.existsSync(path.join(root, item.outputPath)));
  assert(!fs.existsSync(path.join(root, directory, "quality.json")));
  const snapshotArgs = { root, plan, receipt, git, hashFile: hash, inventory, migrationPath };
  const implementationSnapshot = getPhase013ImplementationSnapshot(snapshotArgs);
  const startHashes = sourceHashes();
  const dependencyHashes = executionDependencyHashes();
  const checks = new Map();
  const checked = (id, details = {}) => {
    assert(supportingChecks.includes(id) && !checks.has(id));
    checks.set(id, { checkId: id, status: "PASS", ...details });
  };
  checked("plan-and-inputs", {
    planHash: startPlanHash,
    testMode: "full",
    crossAttemptReuse: "disabled",
    validationPolicy: receipt.validationPolicy,
  });
  const pkg = json("package.json"),
    lock = json("package-lock.json"),
    runtime = json("docs/runtime-baseline.json");
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.equal(version, runtime.dependencyVersions[name]);
    assert.equal(lock.packages["node_modules/" + name].version, version);
    assert.equal(json("node_modules/" + name + "/package.json").version, version);
  }
  assert.equal(
    (await command("node --version", ["--version"])).stdout.trim(),
    "v" + runtime.runtimePolicy.node,
  );
  assert.equal((await npm(["--version"])).stdout.trim(), runtime.runtimePolicy.npm);
  assert.equal(sha(fs.readFileSync(process.execPath)), runtime.nodeExecutableSha256);
  checked("dependency-versions", { nodeExecutableSha256: runtime.nodeExecutableSha256 });
  await npm(["run", "format:check"]);
  const changedTests = git(["diff", "--name-only", receipt.phaseStartCommit, "--", "tests"])
    .trim()
    .split(/\r?\n/)
    .filter((file) => /\.(?:ts|tsx|mjs)$/.test(file));
  const extraFormats = [
    ...new Set([
      ...changedTests,
      ...inventory("tests/phase013"),
      ...inventory("tests/admin"),
      ...inventory("docs/phase-plans").filter((file) =>
        /(?:prepare-|setup-|verify-|complete-)?phase013(?:-runtime|-evidence)?\.mjs$/.test(file),
      ),
    ]),
  ].filter((file) => /\.(?:ts|tsx|mjs)$/.test(file));
  await npm(["exec", "--", "prettier", "--check", "--ignore-path", ".gitignore", ...extraFormats]);
  checked("format-check");
  for (const key of ["lint", "typecheck"]) {
    await npm(["run", key]);
    checked(key);
  }
  const discovered = await discoverTests();
  checked("test-discovery", {
    reportPath: discovered.reportPath,
    testCount: discovered.discovery.length,
  });
  const guardsRaw = path.join(
    root,
    ".scaffold/phase013/" + plan.attemptId + "-evidence-guards.json",
  );
  await command("Phase013 evidence rejection regression", [
    "tests/phase013/evidence-guards.mjs",
    "--output",
    guardsRaw,
  ]);
  const guards = readRawReport(guardsRaw);
  assert.equal(guards.status, "PASS");
  assert.equal(guards.phase, 13);
  assert.equal(guards.caseCount, guards.results.length);
  assert(guards.results.length > 0 && guards.results.every((entry) => entry.status === "PASS"));
  requireHashCoverage(
    guards.testedSourceHashes,
    [
      "docs/phase-plans/phase013-evidence.mjs",
      "docs/phase-plans/phase013-runtime.mjs",
      "scripts/phase-evidence.mjs",
      "tests/phase013/evidence-guards.mjs",
    ],
    hash,
    "EVIDENCE_GUARD_DEPENDENCY_HASH",
  );
  checked("phase013-evidence-guards", {
    reportPath: archive("evidence-guards.json", guards),
    caseCount: guards.caseCount,
  });
  const validatorRaw = path.join(
    root,
    ".scaffold/phase013/" + plan.attemptId + "-validator-regression.json",
  );
  await command("Dual-shell validator compatibility regression", [
    "scripts/test-validate-phase.mjs",
    "--shell",
    "both",
    "--case",
    "root-equality-empty-prefix-local-inputs-history-pass,recovery-history-pass,previous-required-case-removal",
    "--output",
    validatorRaw,
  ]);
  const validator = readRawReport(validatorRaw);
  assert.equal(validator.status, "PASS");
  assert.equal(validator.caseCount, 3);
  for (const [file, expected] of Object.entries(validator.testedSourceHashes))
    assert.equal(hash(file), expected);
  checked("validator-regression", {
    reportPath: archive("validator-regression.json", validator),
    caseCount: 3,
  });
  await command("Prisma CLI and checkpoint network regression", ["tests/phase013/cli-network.mjs"]);
  const networkPath = directory + "/cli-network.json",
    network = json(networkPath);
  assert.equal(network.status, "PASS");
  assert.equal(network.publicRequestsCompleted, 0);
  assert.equal(network.productionTraffic, false);
  assert.equal(network.guardHash, hash(network.guardPath));
  assert.equal(network.prismaCliHash, hash("node_modules/prisma/build/index.js"));
  assert.deepEqual(
    network.reports.map((probe) => probe.label),
    ["disabled", "mutation-enable-checkpoint"],
  );
  assert.equal(network.reports[0].publicAttempts.length, 0);
  assert(network.reports[1].publicAttempts.length > 0);
  for (const probe of network.reports) {
    assert.equal(probe.result.exitCode, 0);
    assert.equal(probe.result.timedOut, false);
  }
  artifact(networkPath);
  checked("prisma-cli-network-isolation", { reportPath: networkPath });
  const migration = await migrationChecks();
  checked("migration-schema", migration);
  await command("node scripts/test-phase-input-paths.mjs", ["scripts/test-phase-input-paths.mjs"]);
  await command("node scripts/generate-api-contract.mjs --check", [
    "scripts/generate-api-contract.mjs",
    "--check",
  ]);
  checked("api-contract");
  const card = await runVitest("card", {
    files: ["admin/api-keys", "admin/logs", "secret-envelope"],
  });
  const mappings = requirePhase013CaseMapping(plan, card.assertions);
  const mappingPath = archive("case-assertion-mapping.json", {
    planHash: startPlanHash,
    sourceReportPath: card.reportPath,
    sourceReportHash: hash(card.reportPath),
    actualCommand: card.result.command,
    mappings,
    uniqueBusinessScenarioCount: 6,
    actualReportExecutionCount: 1,
  });
  const cardCommandPath = archive("card-command.json", card.result);
  const business = phase013BusinessObservations(card.result);
  const businessPath = archive("business-observations.json", {
    planHash: startPlanHash,
    command: card.result.command,
    sourceCommandPath: cardCommandPath,
    sourceCommandHash: hash(cardCommandPath),
    sourceReportPath: card.reportPath,
    sourceReportHash: hash(card.reportPath),
    rows: business,
  });
  const fixtures = phase013FixtureBinding(plan, hash);
  checked("card-test", {
    reportPath: card.reportPath,
    testCount: card.raw.numPassedTests,
    mappingPath,
    businessPath,
  });
  const negative = await negativeControls();
  checked("negative-controls", {
    mutationCount: negative.rows.length,
    restoredReportPath: negative.restoredReportPath,
    restoredTestCount: negative.restoredTestCount,
  });
  const tests = await runVitest("all-tests");
  const coverage = requirePhase013Discovery(discovered.discovery, tests.assertions, root);
  const coveragePath = archive("repository-test-coverage.json", {
    ...coverage,
    discoveryPath: discovered.reportPath,
    discoveryHash: hash(discovered.reportPath),
    reportPath: tests.reportPath,
    reportHash: hash(tests.reportPath),
    testMode: "full",
    omittedAssertions: [],
    skippedAssertions: [],
  });
  checked("test", {
    reportPath: tests.reportPath,
    testCount: tests.raw.numPassedTests,
    coveragePath,
  });
  const legacy = await runVitest("phase006-user-regression", { legacy: true });
  checked("phase006-user-regression", {
    reportPath: legacy.reportPath,
    testCount: legacy.raw.numPassedTests,
  });
  await npm(["run", "build"]);
  checked("build");
  const browser = await browserChecks();
  checked("browser", browser);
  await command("node scripts/check-project-layout.mjs", ["scripts/check-project-layout.mjs"]);
  checked("project-layout");
  const mappingRaw = json(mappingPath);
  assert.deepEqual(mappingRaw.mappings, requirePhase013CaseMapping(plan, card.assertions));
  assert.equal(mappingRaw.sourceReportHash, hash(card.reportPath));
  checked("evidence-binding", { reportPath: mappingPath, exactlyOnceCaseResults: 6 });
  const scope = scanScope();
  checked("secret-and-scope-scan", scope);
  requireHashCoverage(startHashes, plan.sourcePaths, hash, "SOURCE_CHANGED_DURING_ACCEPTANCE");
  requireHashCoverage(
    dependencyHashes,
    Object.keys(executionDependencyHashes()),
    hash,
    "EXECUTION_DEPENDENCY_CHANGED",
  );
  requirePhase013ImplementationBinding(
    implementationSnapshot,
    getPhase013ImplementationSnapshot(snapshotArgs),
  );
  assert.deepEqual([...checks.keys()].sort(), [...supportingChecks].sort());
  for (const item of plan.cases) {
    const report = {
      testCaseId: item.testCaseId,
      command: runnerCommand,
      status: "PASS",
      exitCode: 0,
      numerator: 1,
      denominator: 1,
      inputPath: item.inputPath,
      inputHash: hash(item.inputPath),
      planHash: startPlanHash,
      sourceHashes: startHashes,
      simulation: true,
      productionTraffic: false,
      details: {
        target: migration.target,
        sourceReportPath: card.reportPath,
        sourceReportHash: hash(card.reportPath),
        assertionMapping: mappings[item.testCaseId],
        mappingPath,
        mappingHash: hash(mappingPath),
        businessObservationPath: businessPath,
        businessObservationHash: hash(businessPath),
        businessObservations: business.filter(
          (row) => row.group === item.testCaseId.slice("Phase013:".length),
        ),
        ...fixtures,
        actualCommand: card.result.command,
        negativeControlReportPath: negative.restoredReportPath,
        browserReportPath: browser.reportPath,
        browserReportHash: hash(browser.reportPath),
        scan: scope,
        artifacts: [...artifacts.values()],
      },
    };
    requireReportBinding(report, item, startPlanHash, plan.sourcePaths, hash);
    scan(report, item.testCaseId);
    write(item.outputPath, report);
  }
  const quality = {
    status: "PASS",
    phase: 13,
    attemptId: plan.attemptId,
    planHash: startPlanHash,
    testMode: "full",
    crossAttemptReuse: "disabled",
    sourceHashes: startHashes,
    implementationSnapshot,
    executionDependencyHashes: dependencyHashes,
    supportingChecks,
    supportingResults: supportingChecks.map((id) => checks.get(id)),
    observations,
    artifacts: [...artifacts.values()],
    testCount: tests.raw.numPassedTests,
    cardTestCount: card.raw.numPassedTests,
    legacyTestCount: legacy.raw.numPassedTests,
    negativeControls: negative,
    discoveryCoverage: coverage,
    mappingsPath: mappingPath,
    businessObservationPath: businessPath,
    businessObservationHash: hash(businessPath),
    businessObservations: business,
    ...fixtures,
    browser,
    sensitiveOutputHits: 0,
    scan: scope,
    simulation: true,
    productionTraffic: false,
    costAccounting: {
      ...plan.costAccounting,
      actualCommandExecutions: observations.length,
      actualCommandDurationMs: observations.reduce((total, entry) => total + entry.durationMs, 0),
      dedicatedCardExecutions: 1,
      fullRepositoryExecutions: 1,
      restoredCardExecutions: 1,
      negativeControlExecutions: negative.rows.length,
      negativeBaselineExecutions: negative.rows.length,
      databasePreparation: {
        commandDurationMs: observations
          .filter((entry) => /prisma migrate|db:generate/.test(entry.command))
          .reduce((total, entry) => total + entry.durationMs, 0),
        perTestPreparationDurationMs: null,
        perTestMeasurementStatus: "INCLUDED_IN_TEST_PROCESS_DURATION_NOT_SEPARATELY_MEASURED",
      },
      repeatReason:
        "Separate frozen card/full commands and mandatory baseline/negative/restored security verification; no cross-attempt result reuse.",
    },
    startedAt,
    completedAt: new Date().toISOString(),
  };
  scan(quality, "quality");
  write(directory + "/quality.json", quality);
  console.warn(
    JSON.stringify({
      status: "PASS",
      phase: 13,
      cases: 6,
      supportingChecks: supportingChecks.length,
      testMode: "full",
      testCount: quality.testCount,
    }),
  );
}

setCommandObserver((record) => {
  scan(record, "actual command");
  observations.push(record);
});
try {
  assert.deepEqual(process.argv.slice(2), ["--all"], "Use the frozen --all command");
  await all();
} catch (error) {
  const failurePath = directory + "/attempt.json";
  if (!fs.existsSync(path.join(root, failurePath))) {
    const failure = {
      phase: 13,
      attemptId: plan.attemptId,
      status: "FAIL",
      artifactCommit: null,
      planHash: startPlanHash,
      command: runnerCommand,
      exitCode: 1,
      reason: safeDiagnostics(error.stack ?? error),
      observations,
      artifacts: [...artifacts.values()],
      startedAt,
      recordedAt: new Date().toISOString(),
    };
    scan(failure, "failure receipt");
    write(failurePath, failure);
  }
  console.error(safeDiagnostics(error.stack ?? error));
  process.exitCode = 1;
} finally {
  setCommandObserver(null);
}
