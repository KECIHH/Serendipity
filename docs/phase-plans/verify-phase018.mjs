import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  requireInputs,
  requirePlan,
  requireVitest,
  requireDiscovery,
  requireMappings,
  requireNegative,
  mutate,
  negativeDefinitions,
  regexEscape,
  executionPaths,
  requireCaseExecution,
} from "./phase018-evidence.mjs";
import {
  root,
  plan,
  planPath,
  receiptPath,
  directory,
  json,
  read,
  hash,
  sha,
  write,
  git,
  command,
  npmRun,
  npmCli,
  scan,
  environment,
  ensureDatabase,
  resetDatabase,
  resetRegression,
  copyFixture,
  removeFixture,
  sourceFiles,
  fixtureFiles,
} from "./phase018-runtime.mjs";

const negativeOnly = process.argv.includes("--negative-controls");
const formal = !process.argv.includes("--diagnostic") && (process.argv.includes("--all") || negativeOnly);
const startedAt = new Date().toISOString();
const planHash = hash(planPath);
const archiveRoot = formal ? `${directory}${negativeOnly ? "/negative-run" : ""}` : `.scaffold/phase018/precheck-${Date.now()}`;
const observations = [];
const artifacts = new Map();
const startHashes = Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(file)]));
const dependencies = { readJson: json, hashFile: hash, git };
const fixtures = json("tests/phase018/fixtures.json");

function safe(value) {
  try {
    scan(String(value));
    return String(value);
  } catch {
    return "SECRET_SCAN_REJECTED";
  }
}
function artifact(file) {
  scan(read(file).toString(), file);
  const row = { path: file, sha256: hash(file) };
  artifacts.set(file, row);
  return row;
}
function archive(name, value) {
  scan(typeof value === "string" ? value : JSON.stringify(value));
  const file = `${archiveRoot}/${name}`;
  write(file, value);
  return artifact(file);
}
const rawPath = (name) => path.join(root, ".scaffold/phase018", `${plan.attemptId}-${Date.now()}-${name}`);
function record(result) {
  observations.push(result);
  archive(`commands/${String(observations.length).padStart(3, "0")}.json`, result);
  return result;
}
function run(label, operation) {
  console.warn(JSON.stringify({ running: label }));
  const result = record(operation());
  assert.equal(result.exitCode, 0, `${label}:${safe(result.stderr || result.stdout)}`);
  assert(!result.timedOut);
  return result;
}
function storeRaw(name, file) {
  const bytes = fs.readFileSync(file, "utf8");
  const binding = archive(name, bytes);
  return { ...binding, data: JSON.parse(bytes) };
}
function stable() {
  assert.equal(hash(planPath), planHash);
  for (const [file, expected] of Object.entries(startHashes)) assert.equal(hash(file), expected, `SOURCE_CHANGED:${file}`);
}

function checkPlan() {
  assert(!fs.existsSync(path.join(root, directory, "attempt.json")), "FAILED_ATTEMPT_USE_NEW_ATTEMPT");
  requirePlan(plan, dependencies);
  requireInputs(json(receiptPath), dependencies);
  assert.equal(hash(`${directory}/frozen-plan.json`), planHash);
  assert.equal(hash(`${directory}/input-receipt.json`), hash(receiptPath));
  assert.deepEqual(json(`${directory}/source-basis.json`).sourceHashes, startHashes, "FROZEN_SOURCE_CHANGED");
  for (const file of sourceFiles()) assert(plan.sourcePaths.includes(file), `UNDECLARED_SOURCE:${file}`);
  assert.deepEqual(fixtureFiles(), plan.fixtureSourcePaths);
  for (const file of plan.sourcePaths)
    if (/\.(?:ts|tsx|mjs|js|json|md|sql|css)$/.test(file)) assert(!read(file).includes(13), `LF_REQUIRED:${file}`);
  const changed = [
    ...git(["diff", "--name-only", plan.phaseStartCommit]).trim().split(/\r?\n/),
    ...git(["ls-files", "--others", "--exclude-standard"]).trim().split(/\r?\n/),
  ].filter(Boolean);
  for (const file of changed)
    assert(
      plan.modificationScope.some((scope) => file === scope || (scope.endsWith("/") && file.startsWith(scope))),
      `OUT_OF_SCOPE:${file}`,
    );
  for (const definition of negativeDefinitions) mutate(definition.id, read(definition.file).toString());
  for (const file of [
    plan.discoverySnapshot.path,
    `${directory}/frozen-plan.json`,
    `${directory}/freeze-command.json`,
    `${directory}/source-basis.json`,
    `${directory}/input-receipt.json`,
    plan.executionFreeze.requirementsPath,
  ])
    artifact(file);
}

function scanSources() {
  for (const file of plan.sourcePaths) scan(read(file).toString(), file);
  const report = {
    status: "PASS",
    hits: 0,
    filesScanned: plan.sourcePaths.length,
    sourceHashes: startHashes,
    scannedBeforeRedaction: true,
  };
  return { ...archive("source-scan.json", report), ...report };
}

async function precheck() {
  checkPlan();
  await ensureDatabase();
  const env = environment();
  const checks = {};
  assert.equal(process.versions.node, "24.19.0", "NODE_RUNTIME");
  assert.equal(json(".scaffold/tools/node_modules/npm/package.json").version, "11.7.0", "NPM_RUNTIME");
  checks.generator = run("generated schema provenance", () =>
    command(process.execPath, ["scripts/generate-ai-schemas.mjs", "--check"], { env }),
  );
  checks.apiContract = run("api contract provenance", () =>
    command(process.execPath, ["scripts/generate-api-contract.mjs", "--check"], { env }),
  );
  checks.typecheck = run("typecheck", () => npmRun("typecheck", [], { env }));
  checks.lint = run("lint", () => npmRun("lint", [], { env }));
  checks.format = run("format:check", () => npmRun("format:check", [], { env }));
  checks.layout = run("layout", () => command(process.execPath, ["scripts/check-project-layout.mjs"]));
  checks.whitespace = run("Git whitespace", () => command("git", ["diff", "--check"]));
  const guardFile = rawPath("guards.json");
  checks.guards = run("evidence self-check", () =>
    command(process.execPath, ["tests/phase018/evidence-guards.mjs", "--output", guardFile], { env, timeoutMs: 180000 }),
  );
  checks.guardReport = storeRaw("evidence-guards.json", guardFile);
  const routeFile = rawPath("premature-routes.json");
  checks.routes = run("premature route scan", () =>
    command(process.execPath, ["tests/phase018/premature-routes.mjs", "--output", routeFile], { env, timeoutMs: 120000 }),
  );
  checks.routeReport = storeRaw("premature-routes.json", routeFile);
  checks.scan = scanSources();
  const discoveryFile = rawPath("discovery.json");
  checks.discovery = run("test collection", () =>
    command(process.execPath, ["node_modules/vitest/vitest.mjs", "list", `--json=${discoveryFile}`], { env, timeoutMs: 180000 }),
  );
  const discovery = storeRaw("precheck-discovery.json", discoveryFile);
  assert.deepEqual(
    [...discovery.data].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [...json(plan.discoverySnapshot.path)].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    "DISCOVERY_CHANGED",
  );
  requireMappings(
    plan,
    discovery.data.map((row) => ({
      file: path.relative(root, row.file).replaceAll("\\", "/"),
      fullName: row.name.replaceAll(" > ", " "),
    })),
  );
  stable();
  return { env, checks, discovery };
}

function testCommand(logicalCommand, label, env, timeoutMs = 300000) {
  const output = rawPath(`${label}.json`);
  const attemptsFile = rawPath(`${label}-attempts.jsonl`);
  const filters = logicalCommand === "npm run test" ? ["--"] : logicalCommand.split(" ").slice(3);
  const result = run(label, () =>
    npmRun("test", [...filters, "--reporter=json", `--outputFile=${output}`], {
      env: { ...env, PHASE018_OBSERVATIONS: attemptsFile },
      timeoutMs,
    }),
  );
  const report = storeRaw(`${label}.json`, output);
  const rows = requireVitest(report.data, { base: root });
  const attempts = fs
    .readFileSync(attemptsFile, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(attempts.length > 0, "MISSING_FIXTURE_OBSERVATIONS");
  const attemptReport = archive(`${label}-attempt-audit.json`, attempts);
  return { logicalCommand, result, reportPath: report.path, reportHash: report.sha256, attemptAudit: attemptReport, rows, attempts };
}

function auditFixtures(attempts) {
  const expected = new Map(fixtures.fixtures.map((row) => [row.id, row]));
  const seen = new Map();
  for (const row of attempts) {
    assert(expected.has(row.fixture), `UNKNOWN_FIXTURE:${row.fixture}`);
    assert(!seen.has(row.fixture), `DUPLICATE_FIXTURE_REPORT:${row.fixture}`);
    assert.equal(row.formalWrites, 0, `FORMAL_WRITE:${row.fixture}`);
    assert.equal(row.persistedEvents, 0, `PERSISTED_TRANSIENT_EVENT:${row.fixture}`);
    const fixture = expected.get(row.fixture);
    if (fixture.expectedMockCalls === 0) assert.equal(row.mockCalls, 0, `UNEXPECTED_EGRESS:${row.fixture}`);
    else assert(Number.isSafeInteger(row.mockCalls) && row.mockCalls >= 1, `MISSING_EGRESS:${row.fixture}`);
    if (row.fixture === "stream-interruption") {
      assert.equal(row.providerCallsDuringGet, 0, "GET_EGRESS");
      assert.equal(row.persistedDeltas, 0, "DELTA_PERSISTED");
    }
    seen.set(row.fixture, row);
  }
  for (const id of expected.keys()) assert(seen.has(id), `MISSING_FIXTURE_REPORT:${id}`);
  assert.equal(seen.size, 8, "FIXTURE_DENOMINATOR");
  return Object.fromEntries([...seen].map(([id, row]) => [id, row]));
}

async function negativeControls() {
  const rows = [];
  const env = environment();
  for (const definition of negativeDefinitions) {
    const fixture = copyFixture(definition.id);
    const original = read(definition.file).toString();
    const mutated = mutate(definition.id, original);
    try {
      fs.writeFileSync(path.join(fixture, definition.file), mutated);
      const changes = [
        { sourcePath: definition.file, originalHash: sha(Buffer.from(original)), mutatedHash: sha(Buffer.from(mutated)) },
      ];
      const fixtureHashes = Object.fromEntries(plan.fixtureSourcePaths.map((file) => [file, hash(file, fixture)]));
      for (const [file, value] of Object.entries(fixtureHashes))
        assert.equal(value, file === definition.file ? changes[0].mutatedHash : hash(file));
      const output = rawPath(`negative-${definition.id}.json`);
      console.warn(JSON.stringify({ running: `negative:${definition.id}` }));
      const result = record(
        command(
          process.execPath,
          [npmCli, "run", "test", "--", definition.testFile, "-t", regexEscape(definition.pattern), "--reporter=json", `--outputFile=${output}`],
          { cwd: fixture, env, timeoutMs: 240000 },
        ),
      );
      assert.equal(result.exitCode, 1, `MUTATION_NOT_RED:${definition.id}`);
      assert(!result.timedOut);
      const report = storeRaw(`mutations/${definition.id}-report.json`, output);
      const failureEvidence = requireNegative(report.data, definition, fixture);
      const receipt = archive(`mutations/${definition.id}.json`, {
        id: definition.id,
        cwd: fixture,
        changes,
        testSourceHash: hash(definition.testFile),
        fixtureHashes,
      });
      rows.push({
        id: definition.id,
        originalCase: definition.caseId,
        exitCode: 1,
        cwd: fixture,
        changes,
        testSourceHash: hash(definition.testFile),
        reportPath: report.path,
        reportHash: report.sha256,
        receiptPath: receipt.path,
        receiptHash: receipt.sha256,
        failureEvidence,
        result,
      });
      stable();
    } finally {
      removeFixture(fixture);
    }
  }
  // The mutations intentionally dirty the dedicated database; restore a clean schema
  // before re-running the eight fixtures so the restored pass cannot see leaked rows.
  const reset = record(await resetDatabase());
  assert.equal(reset.exitCode, 0);
  assert(!reset.timedOut);
  const restored = testCommand(plan.engineeringRegression.dedicatedCardCommand, "restored-card", env);
  const mappings = requireMappings(plan, restored.rows);
  stable();
  return { rows, sourceUnchanged: true, restored: { ...restored, rows: undefined, mappings } };
}

async function inspectDatabase() {
  const database = await ensureDatabase();
  const { PrismaClient } = await import("@prisma/client");
  const client = new PrismaClient({ datasourceUrl: database.appUrl, log: [] });
  try {
    const [identity] = await client.$queryRawUnsafe(
      "SELECT current_database() AS name,current_setting('server_version') AS version,r.rolsuper AS superuser,(d.datdba=r.oid) AS owner FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user",
    );
    assert.equal(identity.name, database.database);
    assert.match(identity.version, /^17\./);
    assert.equal(identity.superuser, false);
    assert.equal(identity.owner, false);
    const migrations = await client.$queryRawUnsafe(
      'SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name',
    );
    assert.equal(migrations.length, 11);
    for (const row of migrations) {
      assert(row.finished_at && !row.rolled_back_at);
      assert.equal(row.checksum, hash(`prisma/migrations/${row.migration_name}/migration.sql`));
    }
    const columns = await client.$queryRawUnsafe(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='AiOutputRecord' ORDER BY ordinal_position",
    );
    const forbidden = ["rawOutputText", "parsedJson", "tokenUsageJson", "latencyMs"];
    assert(!columns.some((row) => forbidden.includes(row.column_name)));
    const rawOutputNonNull = await client.aiOutputRecord.count({ where: { rawOutput: { not: null } } });
    assert.equal(rawOutputNonNull, 0);
    const malformed = await client.$queryRawUnsafe(
      'SELECT count(*)::int AS n FROM "AiOutputRecord" WHERE "durationMs" IS NULL OR "durationMs"<0 OR "inputHash"!~\'^[a-f0-9]{64}$\' OR ("outputHash" IS NOT NULL AND "outputHash"!~\'^[a-f0-9]{64}$\')',
    );
    assert.equal(malformed[0].n, 0);
    const tables = await client.$queryRawUnsafe(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('TravelPlanVersion','PlannerRun')",
    );
    assert.equal(tables[0].n, 0);
    const debugFormalWrites = await client.$queryRawUnsafe(
      'SELECT count(*)::int AS n FROM "TravelRecord" WHERE title=\'phase018-debug\'',
    );
    assert.equal(debugFormalWrites[0].n, 0, "DEBUG_FORMAL_WRITE");
    const debugRuns = await client.aiDebugRun.count();
    const debugAttempts = await client.aiOutputRecord.count({ where: { travelRecordId: { not: null } } });
    assert.equal(debugAttempts, 0, "DEBUG_ATTEMPT_TRAVEL_RECORD");
    return {
      database: database.database,
      host: "127.0.0.1",
      isolated: true,
      productionTraffic: false,
      credentials: "SYNTHETIC_NOT_RECORDED",
      version: identity.version,
      runtimeOwner: false,
      runtimeSuperuser: false,
      appliedMigrations: 11,
      previousMigrationsPreserved: 10,
      migrations: migrations.map((row) => ({ name: row.migration_name, sha256: row.checksum })),
      AiOutputRecordFields: columns.map((row) => row.column_name),
      rawOutputNonNull,
      auditRowsMalformed: malformed[0].n,
      formalPlanTables: tables[0].n,
      debugFormalWrites: debugFormalWrites[0].n,
      debugRuns,
      chatCommandEvents: await client.chatCommandEvent.count(),
      outboxRows: await client.outbox.count(),
    };
  } finally {
    await client.$disconnect();
  }
}

async function all() {
  assert(!fs.existsSync(path.join(root, directory, "quality.json")), "ATTEMPT_ALREADY_EXECUTED");
  const { env, checks, discovery } = await precheck();
  const executionDependencyHashes = Object.fromEntries(executionPaths(json("package.json")).map((file) => [file, hash(file)]));
  console.warn(JSON.stringify({ running: "isolated PostgreSQL migrations" }));
  const migrations = record(await resetDatabase());
  assert.equal(migrations.exitCode, 0);
  const regressionMigrations = [];
  for (const result of await resetRegression()) {
    record(result);
    assert.equal(result.exitCode, 0);
    regressionMigrations.push(result);
  }
  const dedicated = testCommand(plan.engineeringRegression.dedicatedCardCommand, "dedicated-card", env);
  const dedicatedMappings = requireMappings(plan, dedicated.rows);
  const fixtureAudit = auditFixtures(dedicated.attempts);
  const expectedDedicated = discovery.data.filter((row) =>
    /mock-provider|ai-debug-api|ai-e2e/.test(path.relative(root, row.file)),
  );
  requireDiscovery(expectedDedicated, dedicated.rows, root);
  checks.build = run("build", () => npmRun("build", [], { env, timeoutMs: 600000 }));
  const full = testCommand("npm run test", "full-regression", env, 1800000);
  const coverage = requireDiscovery(discovery.data, full.rows, root);
  const fullMappings = requireMappings(plan, full.rows);
  const negativeResult = run("isolated negative controls and restored fixtures", () =>
    command(process.execPath, ["docs/phase-plans/verify-phase018.mjs", "--negative-controls"], { env, timeoutMs: 900000 }),
  );
  const negativePath = `${directory}/negative-run/negative-controls.json`;
  const negatives = json(negativePath);
  artifact(negativePath);
  for (const row of negatives.artifacts) artifact(row.path);
  for (const result of negatives.observations) record(result);
  const caseExecutions = plan.cases.map((item) => ({
    testCaseId: item.testCaseId,
    ...(item.testCaseId === "Phase018:negative-controls"
      ? { logicalCommand: item.command, result: negativeResult, reportPath: negativePath, reportHash: hash(negativePath) }
      : { ...dedicated, rows: undefined }),
  }));
  caseExecutions.forEach((execution, index) => requireCaseExecution(plan.cases[index], execution, npmCli));
  const database = await inspectDatabase();
  archive("database-audit.json", database);
  stable();
  for (const [file, value] of Object.entries(executionDependencyHashes)) assert.equal(hash(file), value);
  const shared = {
    full: { ...full, rows: undefined, mappings: fullMappings, attempts: undefined },
    dedicated: { ...dedicated, rows: undefined, mappings: dedicatedMappings, attempts: undefined },
    discovery: { reportPath: discovery.path, reportHash: discovery.sha256, ...coverage },
    database,
    fixtures: fixtureAudit,
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
        actualExecution: caseExecutions[index],
        assertionMapping: dedicatedMappings[index],
        fixture: fixtureAudit[item.testCaseId.split(":")[1]] ?? null,
        qualityReportPath: `${directory}/quality.json`,
      },
    });
  const supporting = {
    typecheck: { result: checks.typecheck },
    lint: { result: checks.lint },
    "format:check": { result: checks.format },
    build: { result: checks.build },
    "full-regression": shared.full,
    "dedicated-card": shared.dedicated,
    "import-boundary": {
      reportPath: dedicated.reportPath,
      reportHash: dedicated.reportHash,
      assertions: dedicatedMappings
        .find((row) => row.testCaseId === "Phase018:authorization")
        .assertions.filter((row) => row.file.includes("ai-debug-api")),
    },
    "secret-scan": checks.scan,
    "negative-controls": negatives,
    layout: { result: checks.layout },
    "evidence-guards": {
      result: checks.guards,
      reportPath: checks.guardReport.path,
      reportHash: checks.guardReport.sha256,
    },
    "schema-provenance": { result: checks.generator },
    "api-contract": { result: checks.apiContract },
    "database-audit": { ...database, migrations, regressionMigrations },
    "premature-route-scan": {
      result: checks.routes,
      reportPath: checks.routeReport.path,
      reportHash: checks.routeReport.sha256,
    },
  };
  archive("quality.json", {
    phase: 18,
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
    supportingResults: plan.supportingChecks.map((checkId) => {
      assert(supporting[checkId], `MISSING_SUPPORTING_RESULT:${checkId}`);
      return { checkId, status: "PASS", details: supporting[checkId] };
    }),
    artifacts: [...artifacts.values()],
    observations,
    ...shared,
    testCount: full.rows.length,
    dedicatedCount: dedicated.rows.length,
    caseExecutions,
    negativeControls: negatives,
    schemaHash: hash("prisma/schema.prisma"),
    promptVersionHash: hash("src/lib/ai/prompt-contract.json"),
    fixtureHash: hash("tests/phase018/fixtures.json"),
    scan: checks.scan,
    costAccounting: {
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - Date.parse(startedAt),
      actualCommands: observations.length,
      fullRegressionExecutions: 1,
      dedicatedExecutions: 1,
      restorationExecutions: 1,
      negativeExecutions: negativeDefinitions.length,
      crossAttemptReuse: "disabled",
    },
  });
  console.warn(
    JSON.stringify({
      status: "AUTOMATED_CHECKS_PASS",
      fixtures: 8,
      tests: full.rows.length,
      dedicated: dedicated.rows.length,
      negatives: negativeDefinitions.length,
      independentReview: "PENDING",
    }),
  );
}

try {
  if (negativeOnly) {
    checkPlan();
    const negatives = await negativeControls();
    archive("negative-controls.json", { ...negatives, artifacts: [...artifacts.values()], observations });
    console.warn(JSON.stringify({ status: "NEGATIVE_CONTROLS_PASS" }));
  } else if (formal) await all();
  else if (process.argv.includes("--precheck")) {
    await precheck();
    console.warn(JSON.stringify({ status: "PRECHECK_PASS" }));
  } else throw new Error("Use --precheck, --all or --negative-controls");
} catch (error) {
  if (formal && !negativeOnly && !fs.existsSync(path.join(root, directory, "attempt.json")))
    write(`${directory}/attempt.json`, {
      phase: 18,
      attemptId: plan.attemptId,
      status: "FAIL",
      blockedCategory: "VERIFICATION",
      artifactCommit: null,
      planHash,
      sourceHashes: startHashes,
      command: "node docs/phase-plans/verify-phase018.mjs --all",
      observations,
      artifacts: [...artifacts.values()],
      error: safe(error.stack ?? error),
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  console.error(safe(error.stack ?? error));
  process.exitCode = 1;
}
