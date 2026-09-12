import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { requireHashCoverage } from "../../scripts/phase-evidence.mjs";
import {
  executionPaths,
  requireInputs,
  requirePlan,
  requireVitest,
  requireDiscovery,
  requireMappings,
  negativeDefinitions,
  mutate,
  requireNegative,
  requireBrowser,
  requireBusiness,
  tables,
} from "./phase014-evidence.mjs";
import {
  root,
  plan,
  planPath,
  receiptPath,
  directory,
  configPath,
  json,
  read,
  hash,
  sha,
  git,
  write,
  npm,
  command,
  dbConfig,
  assertDatabaseTarget,
  sql,
  inventory,
  copyFixture,
  removeFixture,
  setCommandObserver,
  scanSensitiveText,
  safeDiagnostics,
} from "./phase014-runtime.mjs";

const formal = process.argv.includes("--all");
const startedAt = new Date().toISOString(),
  planHash = hash(planPath);
const observations = [],
  artifacts = new Map();
let startHashes = null;
const hashes = () => Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(file)]));
const dependencies = { readJson: json, readBytes: read, hashFile: hash, git };
const rawPath = (name) =>
  path.join(
    root,
    ".scaffold/phase014",
    `${formal ? plan.attemptId : "precheck-" + Date.now()}-${name}`,
  );
const scan = (value, label) =>
  scanSensitiveText(typeof value === "string" ? value : JSON.stringify(value), label);
function artifact(file) {
  if (!/\.(?:png|ico|woff2?)$/i.test(file)) scan(read(file).toString(), file);
  const binding = { path: file, sha256: hash(file) };
  artifacts.set(file, binding);
  return binding;
}
function archive(name, value) {
  scan(value, name);
  const file = `${directory}/${name}`;
  write(file, value);
  artifact(file);
  return file;
}
function rawJson(file) {
  const bytes = fs.readFileSync(file, "utf8");
  scan(bytes, path.basename(file));
  return JSON.parse(bytes);
}
function storeRaw(name, file) {
  const data = rawJson(file);
  return { data, path: formal ? archive(name, readAbsolute(file)) : file };
}
function readAbsolute(file) {
  return fs.readFileSync(file, "utf8");
}
setCommandObserver((record) => {
  const finishedAt = new Date().toISOString();
  const observation = {
    ...record,
    startedAt: new Date(Date.parse(finishedAt) - record.durationMs).toISOString(),
    finishedAt,
  };
  observations.push(observation);
  if (formal) archive(`commands/${String(observations.length).padStart(3, "0")}.json`, observation);
});
export function testEnvironment() {
  const config = dbConfig(),
    fixture = path.join(root, configPath);
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
    PHASE014_FIXTURE_CONFIG: fixture,
    PHASE012_DATABASE_URL: config.url,
    PHASE012_RUNTIME_DATABASE_URL: config.appUrl,
    PHASE013_DATABASE_URL: config.url,
    PHASE013_RUNTIME_DATABASE_URL: config.appUrl,
  };
}
function checkPlan() {
  assert(
    !fs.existsSync(path.join(root, directory, "attempt.json")),
    "Failed attempt must advance with --retry",
  );
  assert.equal(hash(`${directory}/frozen-plan.json`), planHash, "FROZEN_PLAN_CHANGED");
  requirePlan(plan, dependencies);
  const receipt = json(receiptPath);
  requireInputs(receipt, dependencies);
  const paths = [
    ...inventory("src"),
    ...inventory("tests"),
    ...inventory("prisma"),
    ...inventory("scripts"),
  ];
  assert(
    paths.every((file) => plan.sourcePaths.includes(file)),
    "UNDECLARED_SOURCE",
  );
  for (const file of plan.sourcePaths) {
    assert(fs.existsSync(path.join(root, file)), `MISSING_SOURCE:${file}`);
    if (/\.(?:ts|tsx|js|mjs|json|md|sql|css)$/.test(file))
      assert(!read(file).includes(13), `SOURCE_REQUIRES_LF:${file}`);
  }
  const changed = [
    ...git(["diff", "--name-only", receipt.phaseStartCommit]).trim().split(/\r?\n/),
    ...git(["ls-files", "--others", "--exclude-standard"]).trim().split(/\r?\n/),
  ].filter(Boolean);
  for (const file of changed)
    assert(
      plan.modificationScope.some(
        (scope) => file === scope || (scope.endsWith("/") && file.startsWith(scope)),
      ),
      `OUT_OF_SCOPE:${file}`,
    );
  assert.deepEqual(
    inventory("prisma/migrations")
      .filter((file) => file.endsWith("/migration.sql"))
      .sort(),
    receipt.prerequisites.migrations.map((item) => item.path).sort(),
  );
  assert.deepEqual(
    [
      ...read("prisma/schema.prisma")
        .toString()
        .matchAll(/^model (\w+)\s*\{/gm),
    ]
      .map((m) => m[1])
      .sort(),
    tables,
  );
  return receipt;
}
function dependencyHashes() {
  return Object.fromEntries(executionPaths(json("package.json")).map((file) => [file, hash(file)]));
}

async function precheck() {
  const receipt = checkPlan();
  for (const file of [...inventory("src"), ...inventory("tests/phase014")]) {
    if (!/\.(?:png|ico|woff2?)$/.test(file)) scan(read(file).toString(), file);
  }
  const baseline = json("docs/runtime-baseline.json"),
    pkg = json("package.json"),
    lock = json("package-lock.json");
  assert.equal(process.version, `v${baseline.runtimePolicy.node}`);
  assert.equal(sha(fs.readFileSync(process.execPath)), baseline.nodeExecutableSha256);
  assert.equal((await npm(["--version"])).stdout.trim(), baseline.runtimePolicy.npm);
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.equal(version, baseline.dependencyVersions[name]);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
    assert.equal(json(`node_modules/${name}/package.json`).version, version);
  }
  const checks = {};
  for (const script of ["format:check", "lint", "typecheck"])
    checks[script] = await npm(["run", script]);
  const changed = [
    ...git(["diff", "--name-only", receipt.phaseStartCommit]).trim().split(/\r?\n/),
    ...git(["ls-files", "--others", "--exclude-standard"]).trim().split(/\r?\n/),
  ];
  const extraFormats = [...new Set(changed)].filter(
    (file) => /^(?:tests\/|docs\/phase-plans\/)/.test(file) && /\.(?:ts|tsx|mjs)$/.test(file),
  );
  checks.extraFormat = await npm([
    "exec",
    "--",
    "prettier",
    "--check",
    "--ignore-path",
    ".gitignore",
    ...extraFormats,
  ]);
  checks.whitespace = await command("git diff --check", ["diff", "--check"], { executable: "git" });
  checks.layout = await command("node scripts/check-project-layout.mjs", [
    "scripts/check-project-layout.mjs",
  ]);
  checks.api = await command("node scripts/generate-api-contract.mjs --check", [
    "scripts/generate-api-contract.mjs",
    "--check",
  ]);
  const guardPath = rawPath("guards.json");
  checks.guards = await command("Phase014 evidence collector self-test", [
    "tests/phase014/evidence-guards.mjs",
    "--output",
    guardPath,
  ]);
  const guards = storeRaw("evidence-guards.json", guardPath);
  assert.equal(guards.data.status, "PASS");
  assert(guards.data.caseCount > 0);
  const validatorPath = rawPath("validator.json");
  checks.validator = await command("Dual-shell validator regression", [
    "scripts/test-validate-phase.mjs",
    "--shell",
    "both",
    "--case",
    "root-equality-empty-prefix-local-inputs-history-pass,recovery-history-pass,previous-required-case-removal",
    "--output",
    validatorPath,
  ]);
  const validator = storeRaw("validator-regression.json", validatorPath);
  assert.equal(validator.data.status, "PASS");
  assert.equal(validator.data.shells.length, 2);
  const target = await assertDatabaseTarget();
  return {
    checks,
    guards: { path: guards.path, count: guards.data.caseCount },
    validator: { path: validator.path, count: validator.data.caseCount },
    target,
  };
}
async function prepareDatabase() {
  const config = dbConfig(),
    receipt = json(receiptPath);
  const target = await assertDatabaseTarget();
  const identity = await sql(
    "SELECT current_database(), current_setting('server_version'), shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database();",
  );
  const [database, version, marker] = identity.stdout.trim().split("|");
  assert.equal(database, target.database);
  assert.match(version, /^17\./);
  assert.equal(marker, target.marker);
  await npm(["exec", "--", "prisma", "migrate", "deploy"], { env: { DATABASE_URL: config.url } });
  const status = await npm(["exec", "--", "prisma", "migrate", "status"], {
    env: { DATABASE_URL: config.url },
  });
  assert.match(status.stdout, /Database schema is up to date/);
  await npm(["run", "db:generate"], { env: { DATABASE_URL: config.url } });
  await sql(
    [
      "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
      "GRANT USAGE ON SCHEMA public TO phase014_app",
      'GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE "User","SystemConfig","TravelRecord","ChatMessage","ApiKeyConfig" TO phase014_app',
      'GRANT SELECT,INSERT ON TABLE "AuditLog","AuthSession","AuthLoginAttempt" TO phase014_app',
      'REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE "AuditLog" FROM phase014_app',
      'GRANT UPDATE (status,"lastSeenAt","revokedAt") ON "AuthSession" TO phase014_app',
      'GRANT UPDATE (status,"completedAt") ON "AuthLoginAttempt" TO phase014_app',
      'GRANT SELECT,INSERT,UPDATE ON TABLE "AdminCommandReceipt","KeyRotationRun" TO phase014_app',
      'GRANT SELECT ON "_prisma_migrations" TO phase014_app',
      "GRANT EXECUTE ON FUNCTION public.auth_now() TO phase014_app",
    ].join(";\n") + ";",
  );
  const roles = await sql(
    "SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,(r.oid=d.datdba) FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname='phase014_app';",
  );
  assert.equal(roles.stdout.trim(), "f|f|f|f|f");
  const applied = await sql(
    'SELECT migration_name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count>0 ORDER BY migration_name;',
  );
  assert.deepEqual(
    applied.stdout.trim().split(/\r?\n/),
    receipt.prerequisites.migrations.map((item) => `${item.path.split("/")[2]}|${item.sha256}`),
  );
  const present = await sql(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;",
  );
  assert.deepEqual(present.stdout.trim().split(/\r?\n/), [...tables, "_prisma_migrations"]);
  return {
    target,
    version,
    appliedMigrations: 8,
    previousMigrationsPreserved: 8,
    tables,
    schemaHash: hash("prisma/schema.prisma"),
    runtimeRole: config.appUser,
    runtimeOwner: false,
    runtimeSuperuser: false,
  };
}
async function vitest(label, { files = [], cwd = root, pattern, negative = false } = {}) {
  const output = rawPath(`${label}.json`),
    businessPath = rawPath(`${label}-business.jsonl`);
  assert(!fs.existsSync(output) && !fs.existsSync(businessPath), "RAW_REPORT_IMMUTABLE");
  const args = [
    "run",
    "test",
    "--",
    ...files,
    ...(pattern ? ["-t", pattern] : []),
    "--no-file-parallelism",
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${output}`,
  ];
  const result = await npm(args, {
    cwd,
    env: { ...testEnvironment(), PHASE014_OBSERVATIONS_PATH: businessPath },
    expected: null,
    timeoutMs: 1_800_000,
  });
  const report = storeRaw(`${label}-vitest.json`, output);
  assert(Number.isInteger(result.exitCode) && !result.timedOut);
  if (negative) assert.notEqual(result.exitCode, 0);
  else assert.equal(result.exitCode, 0, `REQUIRED_TEST_FAILED:${label}`);
  const rows = requireVitest(report.data, {
    base: cwd,
    expectedFailure: negative,
    allowFiltered: !!pattern,
  });
  let business = null;
  if (fs.existsSync(businessPath)) {
    const bytes = readAbsolute(businessPath);
    scan(bytes, `${label}-business`);
    business = {
      path: archive(`${label}-business.jsonl`, bytes),
      rows: bytes
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    };
  }
  return { reportPath: report.path, result, rows, business, raw: report.data };
}
async function negativeControls() {
  const rows = [];
  for (const definition of negativeDefinitions) {
    const fixture = copyFixture(definition.id);
    try {
      const original = read(definition.file).toString(),
        changed = mutate(definition.id, original);
      fs.writeFileSync(path.join(fixture, definition.file), changed);
      const changes = [
        { sourcePath: definition.file, originalHash: sha(original), mutatedHash: sha(changed) },
      ];
      const testHash = hash(definition.testFile);
      assert.equal(hash(definition.testFile, fixture), testHash);
      archive(`mutations/${definition.id}.json`, {
        ...definition,
        fixture,
        changes,
        testSourceHash: testHash,
      });
      const result = await vitest(`negative-${definition.id}`, {
        files: [definition.testFile],
        cwd: fixture,
        pattern: definition.pattern,
        negative: true,
      });
      const failureEvidence = requireNegative(result.raw, definition, fixture, (file) =>
        read(file).toString(),
      );
      rows.push({
        id: definition.id,
        originalCase: definition.caseId,
        changes,
        testSourceHash: testHash,
        cwd: fixture,
        reportPath: result.reportPath,
        result: result.result,
        failureEvidence,
      });
      assert.equal(hash(definition.file), changes[0].originalHash, "PRODUCT_SOURCE_MUTATED");
    } finally {
      removeFixture(fixture);
    }
  }
  return { rows, sourceUnchanged: true };
}
function archiveDiagnostics() {
  const files = fs
    .readdirSync(path.join(root, ".scaffold/phase014"))
    .filter((name) =>
      /^(?:diagnostic-\d+(?:-command|-business)?|browser-diagnostic-\d+(?:-command)?|negative-diagnostic-[a-z-]+|build-diagnostic-command|precheck-\d+-(?:guards|validator))\.jsonl?$/.test(
        name,
      ),
    );
  const bindings = files.map((name) => {
    const bytes = readAbsolute(path.join(root, ".scaffold/phase014", name));
    return artifact(archive(`diagnostics/${name}`, bytes));
  });
  return archive("diagnostics/index.json", {
    notGate: true,
    purpose: "Implementation debugging; failed and filtered runs do not count as formal acceptance",
    artifacts: bindings,
  });
}
async function all() {
  checkPlan();
  assert(!fs.existsSync(path.join(root, directory, "quality.json")), "FORMAL_REPORT_IMMUTABLE");
  startHashes = hashes();
  const setup = await precheck();
  archiveDiagnostics();
  const database = await prepareDatabase(),
    executionDependencyHashes = dependencyHashes();
  const discoveredPath = rawPath("discovery.json");
  const discoveryResult = await npm(
    ["exec", "--", "vitest", "list", "--no-file-parallelism", `--json=${discoveredPath}`],
    { env: testEnvironment() },
  );
  const discovery = storeRaw("test-discovery.json", discoveredPath);
  const negatives = await negativeControls();
  const dedicated = await vitest("restored-card", {
    files: ["admin/settings", "admin/dashboard", "admin/security"],
  });
  const dedicatedMappings = requireMappings(plan, dedicated.rows);
  requireBusiness(dedicated.business.rows);
  const full = await vitest("full-regression");
  const coverage = requireDiscovery(discovery.data, full.rows, root),
    mappings = requireMappings(plan, full.rows);
  const business = requireBusiness(full.business.rows);
  const build = await npm(["run", "build"], { env: testEnvironment() });
  const browserOutput = rawPath("browser.json");
  const browserResult = await command(
    "Phase014 real browser and accessibility",
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "tests/phase014/browser.mjs",
      "--output",
      browserOutput,
    ],
    { env: testEnvironment(), expected: null, timeoutMs: 600_000 },
  );
  const browserRaw = storeRaw("browser.json", browserOutput);
  assert.equal(browserResult.exitCode, 0);
  const browserSummary = requireBrowser(browserRaw.data);
  for (const item of browserRaw.data.artifacts) {
    assert.equal(hash(item.path), item.sha256);
    artifact(item.path);
  }
  const scanFiles = [
    ...inventory("src"),
    ...inventory("tests/phase014"),
    ...inventory("docs/evidence/attempts/Phase014"),
  ];
  for (const file of scanFiles)
    if (!/\.(?:png|ico|woff2?)$/.test(file)) scan(read(file).toString(), file);
  requireHashCoverage(startHashes, plan.sourcePaths, hash, "TESTED_SOURCE_CHANGED");
  assert.deepEqual(dependencyHashes(), executionDependencyHashes, "EXECUTION_DEPENDENCY_CHANGED");
  const supporting = {
    lint: setup.checks.lint,
    typecheck: setup.checks.typecheck,
    "format:check": setup.checks["format:check"],
    build,
    "full-regression": { result: full.result, reportPath: full.reportPath, ...coverage },
    "dedicated-card": {
      result: dedicated.result,
      reportPath: dedicated.reportPath,
      mappings: dedicatedMappings,
    },
    "prerequisite-migrations": database,
    "database-failures": {
      observations: business.filter((row) =>
        ["dashboard-partial", "readiness", "database-recovery"].includes(row.kind),
      ),
    },
    "browser-a11y": { result: browserResult, reportPath: browserRaw.path, ...browserSummary },
    "negative-controls": negatives,
    "evidence-guards": setup.guards,
    layout: setup.checks.layout,
    "validator-regression": setup.validator,
  };
  const shared = {
    artifacts: [...artifacts.values()],
    fullReportPath: full.reportPath,
    dedicatedReportPath: dedicated.reportPath,
    browserReportPath: browserRaw.path,
    businessObservationPath: full.business.path,
    target: database.target,
  };
  for (const [index, item] of plan.cases.entries())
    archive(`${item.testCaseId.split(":")[1]}.json`, {
      testCaseId: item.testCaseId,
      command: item.command,
      status: "PASS",
      exitCode: 0,
      numerator: item.denominator,
      denominator: item.denominator,
      inputPath: item.inputPath,
      inputHash: hash(item.inputPath),
      planHash,
      sourceHashes: startHashes,
      simulation: true,
      productionTraffic: false,
      details: {
        ...shared,
        assertionMapping: mappings[index],
        dedicatedAssertionMapping: dedicatedMappings[index],
      },
    });
  const quality = {
    phase: 14,
    attemptId: plan.attemptId,
    planHash,
    status: "PASS",
    simulation: true,
    productionTraffic: false,
    testMode: "full",
    crossAttemptReuse: "disabled",
    sourceHashes: startHashes,
    executionDependencyHashes,
    supportingChecks: plan.supportingChecks,
    supportingResults: plan.supportingChecks.map((checkId) => ({
      checkId,
      status: "PASS",
      details: supporting[checkId],
    })),
    artifacts: [...artifacts.values()],
    observations,
    testCount: full.rows.length,
    dedicatedCount: dedicated.rows.length,
    discovery: { reportPath: discovery.path, result: discoveryResult, ...coverage },
    full: { reportPath: full.reportPath, mappings, result: full.result },
    dedicated: {
      reportPath: dedicated.reportPath,
      mappings: dedicatedMappings,
      result: dedicated.result,
    },
    negativeControls: negatives,
    browser: {
      reportPath: browserRaw.path,
      reportHash: hash(browserRaw.path),
      result: browserResult,
      ...browserSummary,
    },
    businessObservationPath: full.business.path,
    businessObservationHash: hash(full.business.path),
    businessObservations: business,
    database,
    registryHash: hash("src/server/config/config-registry.ts"),
    schemaHash: hash("prisma/schema.prisma"),
    apiHash: hash("docs/api.md"),
    scan: { filesScanned: scanFiles.length, hits: 0, scannedBeforeRedaction: true },
    costAccounting: {
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - Date.parse(startedAt),
      actualCommands: observations.length,
      fullRegressionExecutions: 1,
      dedicatedExecutions: 1,
      negativeExecutions: 4,
      browserExecutions: 1,
      implementationDurationMs: null,
      crossAttemptReuse: "disabled",
    },
  };
  archive("quality.json", quality);
  console.warn(
    JSON.stringify({
      status: "AUTOMATED_CHECKS_PASS",
      cases: 5,
      tests: full.rows.length,
      browserCases: browserSummary.caseCount,
      independentReview: "PENDING",
    }),
  );
}
try {
  if (formal) await all();
  else if (process.argv.includes("--precheck")) {
    const result = await precheck();
    console.warn(
      JSON.stringify({
        status: "PRECHECK_PASS",
        guards: result.guards.count,
        validatorCases: result.validator.count,
      }),
    );
  } else throw new Error("Use --precheck or --all");
} catch (error) {
  if (formal && !fs.existsSync(path.join(root, directory, "attempt.json"))) {
    write(`${directory}/attempt.json`, {
      phase: 14,
      attemptId: plan.attemptId,
      status: "FAIL",
      blockedCategory: "VERIFICATION",
      artifactCommit: null,
      planHash,
      sourceHashes: startHashes,
      command: "node docs/phase-plans/verify-phase014.mjs --all",
      observations,
      artifacts: [...artifacts.values()],
      error: safeDiagnostics(error.stack ?? error),
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  }
  console.error(safeDiagnostics(error.stack ?? error));
  process.exitCode = 1;
}
