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
} from "./phase016-evidence.mjs";
import {
  root,
  plan,
  planPath,
  receiptPath,
  directory,
  fullDatabasePath,
  json,
  read,
  hash,
  sha,
  write,
  git,
  command,
  npmRun,
  npmCli,
  scanSensitiveText,
  ensureFullDatabaseConfig,
  testEnvironment,
  resetDatabase,
  copyFixture,
  removeFixture,
  inventory,
} from "./phase016-runtime.mjs";

const negativeOnly=process.argv.includes("--negative-controls");
const formal = !process.argv.includes("--diagnostic") && (process.argv.includes("--all") || negativeOnly),
  startedAt = new Date().toISOString();
const archiveRoot=formal?`${directory}${negativeOnly?"/negative-run":""}`:`.scaffold/phase016/${startedAt.replaceAll(":","-")}`;
const planHash = hash(planPath),
  dependencies = { readJson: json, readBytes: read, hashFile: hash, git };
const observations = [],
  artifacts = new Map();
const startHashes = Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(file)]));
const vitestCli = path.join(root, "node_modules/vitest/vitest.mjs"),
  prismaCli = path.join(root, "node_modules/prisma/build/index.js");
function safe(value) {
  try {
    scanSensitiveText(value);
    return String(value);
  } catch {
    return "SECRET_SCAN_REJECTED";
  }
}
function artifact(file) {
  scanSensitiveText(read(file).toString(), file);
  const entry = { path: file, sha256: hash(file) };
  artifacts.set(file, entry);
  return entry;
}
function archive(name, value) {
  scanSensitiveText(typeof value === "string" ? value : JSON.stringify(value), name);
  const file = `${archiveRoot}/${name}`;
  write(file, value);
  return artifact(file);
}
function rawPath(name) {
  return path.join(root, ".scaffold/phase016", `${formal ? plan.attemptId : startedAt.replaceAll(":","-")}-${name}`);
}
function recordCommand(result) {
  observations.push(result);
  archive(`commands/${String(observations.length).padStart(3, "0")}.json`, result);
  return result;
}
function run(label, operation) {
  console.warn(JSON.stringify({ running: label }));
  const result = recordCommand(operation());
  assert.equal(result.exitCode, 0, `${label}: ${safe(result.stderr || result.stdout)}`);
  assert(!result.timedOut);
  return result;
}
function storeRaw(name, file) {
  const bytes = fs.readFileSync(file, "utf8");
  const binding = archive(name, bytes);
  return { data: JSON.parse(bytes), ...binding };
}
function stableSources() {
  for (const [file, expected] of Object.entries(startHashes))
    assert.equal(hash(file), expected, `SOURCE_CHANGED:${file}`);
}
function checkPlan() {
  assert(!fs.existsSync(path.join(root, directory, "attempt.json")), "FAILED_ATTEMPT_USE_RETRY");
  requirePlan(plan, dependencies);
  const receipt = requireInputs(json(receiptPath), dependencies);
  for (const file of [
    plan.discoverySnapshot.path,
    `${directory}/frozen-plan.json`,
    `${directory}/freeze-command.json`,
    `${directory}/input-receipt.json`,
    `${directory}/source-basis.json`,
  ])
    artifact(file);
  assert.equal(hash(`${directory}/input-receipt.json`), hash(receiptPath), "FROZEN_RECEIPT_CHANGED");
  assert.deepEqual(json(`${directory}/source-basis.json`).sourceHashes,startHashes,"FROZEN_SOURCE_CHANGED");
  for(const file of [...inventory("src"),...inventory("tests"),...inventory("prisma"),...inventory("scripts")])
    assert(plan.sourcePaths.includes(file),`UNDECLARED_SOURCE:${file}`);
  for (const file of plan.sourcePaths) {
    const bytes = read(file);
    if (/\.(?:ts|tsx|js|mjs|json|md|sql|css)$/.test(file))
      assert(!bytes.includes(13), `SOURCE_REQUIRES_LF:${file}`);
  }
  const changed = [
    ...git(["diff", "--name-only", receipt.phaseStartCommit]).trim().split(/\r?\n/),
    ...git(["ls-files", "--others", "--exclude-standard"]).trim().split(/\r?\n/),
  ].filter(Boolean);
  for (const file of changed) {
    const preserved = plan.sealRecovery?.metadataFiles.find(row => row.path === file);
    if (preserved) {
      assert.equal(hash(file), preserved.sha256, `UNSEALED_METADATA_CHANGED:${file}`);
      continue;
    }
    assert(
      plan.modificationScope.some(
        (scope) => file === scope || (scope.endsWith("/") && file.startsWith(scope)),
      ),
      `OUT_OF_SCOPE:${file}`,
    );
  }
  assert.equal(git(["config", "--get", "core.longpaths"]).trim(), "true", "GIT_LONG_PATHS_REQUIRED");
  for (const item of negativeDefinitions)
    assert.notEqual(mutate(item.id, read(item.file).toString()), read(item.file).toString());
  return receipt;
}
async function precheck() {
  const receipt = checkPlan(),
    database = ensureFullDatabaseConfig(),
    env = testEnvironment(database.path);
  const checks = {};
  checks.generate = run("prisma generate", () =>
    command(process.execPath, [prismaCli, "generate"], { env }),
  );
  checks.typecheck = run("typecheck", () => npmRun("typecheck", [], { env }));
  checks.lint = run("lint", () => npmRun("lint", [], { env }));
  checks.format = run("format", () => npmRun("format:check", [], { env }));
  checks.layout = run("layout", () => command(process.execPath, ["scripts/check-project-layout.mjs"]));
  const guardsPath = rawPath("evidence-guards.json");
  checks.guards = run("evidence self-check", () =>
    command(process.execPath, ["tests/phase016/evidence-guards.mjs", "--output", guardsPath], { env }),
  );
  checks.guardReport=storeRaw("evidence-guards.json",guardsPath);
  const validatorPath=rawPath("validator-regression.json");
  checks.validator=run("both shell validator regressions",()=>command(process.execPath,["scripts/test-validate-phase.mjs","--shell","both",
    ...(!formal?["--case","root-equality-empty-prefix-local-inputs-history-pass,real-parent-interposition,recovery-history-pass,omitted-recovery-history"]:[]),
    "--output",validatorPath],{env,timeoutMs:600000}));
  checks.validatorReport=storeRaw("validator-regression.json",validatorPath);
  checks.scan=scanSources();
  const discoveryPath = rawPath("precheck-discovery.json");
  checks.discovery = run("test collection", () =>
    command(process.execPath, [vitestCli, "list", `--json=${discoveryPath}`], {
      env,
      timeoutMs: 120000,
    }),
  );
  const discovery = storeRaw("precheck-discovery.json", discoveryPath);
  assert(discovery.data.length > 0);
  const rows = discovery.data.map((x) => ({
    file: path.relative(root, x.file).replaceAll("\\", "/"),
    fullName: x.name.replaceAll(" > ", " "),
  }));
  requireMappings(plan, rows);
  stableSources();
  return { receipt, database, env, checks, discovery };
}
function scanSources(){
  const candidates=[...inventory("src"),...inventory("tests"),...inventory("prisma"),...inventory("scripts"),
    ".env.example","vitest.setup.ts","package.json","package-lock.json","docs/database.md","docs/api.md","docs/privacy-and-user-data.md"];
  for(const file of candidates)scanSensitiveText(read(file).toString(),file);
  const report={status:"PASS",filesScanned:candidates.length,hits:0,scannedBeforeRedaction:true,
    sourceHashes:Object.fromEntries(candidates.map(file=>[file,hash(file)])),historicalEvidence:"Verified by immutable Git/blob hashes; unchanged history is not rewritten"};
  const binding=archive("source-scan.json",report);return {...binding,...report};
}
function testCommand(logicalCommand, label, env, timeoutMs = 180000) {
  const output = rawPath(`${label}.json`);
  const filters = logicalCommand === "npm run test" ? ["--"] : logicalCommand.split(" ").slice(3);
  const result = run(label, () =>
    npmRun("test", [...filters, "--reporter=json", `--outputFile=${output}`], { env, timeoutMs }),
  );
  const report = storeRaw(`${label}.json`, output);
  const rows = requireVitest(report.data, { base: root });
  return { logicalCommand, result, reportPath: report.path, reportHash: report.sha256, rows };
}
async function negativeControls(fixturePath) {
  const rows = [];
  for (const definition of negativeDefinitions) {
    const fixture = copyFixture(definition.id),
      original = read(definition.file).toString(),
      mutated = mutate(definition.id, original);
    try {
      fs.writeFileSync(path.join(fixture, definition.file), mutated, "utf8");
      const changes = [
        {
          sourcePath: definition.file,
          originalHash: sha(Buffer.from(original)),
          mutatedHash: sha(Buffer.from(mutated)),
        },
      ];
      const fixtureHashes = Object.fromEntries(
        [
          ...inventory("src", fixture),
          ...inventory("tests", fixture),
          ...inventory("prisma", fixture),
          ...inventory("vitest", fixture),
          "package.json",
          "package-lock.json",
          "tsconfig.json",
          "vitest.config.ts",
          "vitest.setup.ts",
        ].map((file) => [file, hash(file, fixture)]),
      );
      for (const [file, actual] of Object.entries(fixtureHashes))
        assert.equal(
          actual,
          file === definition.file ? changes[0].mutatedHash : hash(file),
          `FIXTURE_SOURCE:${file}`,
        );
      const migration=run(`prepare mutation database:${definition.id}`,()=>resetDatabase(fixture));
      const output = rawPath(`negative-${definition.id}.json`);
      console.warn(JSON.stringify({ running: `negative:${definition.id}` }));
      const result = recordCommand(
        command(
          process.execPath,
          [npmCli, "run", "test", "--", definition.testFile, "-t", regexEscape(definition.pattern), "--reporter=json", `--outputFile=${output}`],
          { cwd: fixture, env: testEnvironment(fixturePath), timeoutMs: 120000 },
        ),
      );
      assert.equal(result.exitCode, 1, `MUTATION_NOT_RED:${definition.id}`);
      assert(!result.timedOut);
      const raw = storeRaw(`mutations/${definition.id}-report.json`, output),
        failureEvidence = requireNegative(raw.data, definition, fixture);
      const receipt = {
        id: definition.id,
        changes,
        testSourceHash: hash(definition.testFile),
        expectedExitCode: 1,
        cwd: fixture,
        fixtureHashes,
        migration,
      };
      const receiptFile = archive(`mutations/${definition.id}.json`, receipt);
      rows.push({
        id: definition.id,
        originalCase: definition.caseId,
        exitCode: 1,
        reportPath: raw.path,
        reportHash: raw.sha256,
        receiptPath: receiptFile.path,
        receiptHash: receiptFile.sha256,
        failureEvidence,
        testSourceHash: receipt.testSourceHash,
        changes,
        cwd: fixture,
        result,
      });
      stableSources();
    } finally {
      removeFixture(fixture);
    }
  }
  const restore = run("restore original database", () => resetDatabase(root));
  const restored = testCommand(
    plan.engineeringRegression.dedicatedCardCommand,
    "restored-card",
    testEnvironment(fixturePath),
  );
  const mappings = requireMappings(plan, restored.rows);
  stableSources();
  return {
    rows,
    sourceUnchanged: true,
    restore,
    restored: { ...restored, rows: undefined, mappings },
  };
}
async function inspectDatabase(database) {
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
    assert.equal(migrations.length, 10);
    for (const row of migrations) {
      assert(row.finished_at && !row.rolled_back_at);
      assert.equal(row.checksum, hash(`prisma/migrations/${row.migration_name}/migration.sql`));
    }
    return {
      database: database.database,
      host: "127.0.0.1",
      isolated: true,
      productionTraffic: false,
      credentials: "SYNTHETIC_NOT_RECORDED",
      appliedMigrations: 10,
      previousMigrationsPreserved: 9,
      runtimeOwner: false,
      runtimeSuperuser: false,
      version: identity.version,
      migrations: migrations.map((x) => ({ name: x.migration_name, sha256: x.checksum })),
    };
  } finally {
    await client.$disconnect();
  }
}
async function all() {
  const prepared = await precheck(),
    { database, env, checks } = prepared;
  const executionDependencyHashes = Object.fromEntries(
    executionPaths(json("package.json")).map((file) => [file, hash(file)]),
  );
  const migration = run("isolated additive migration", () => resetDatabase(root));
  const namedMigration=run("card named migration",()=>npmRun("db:migrate",["--","--name","chat_command_events","--skip-generate"],
    {env:{...env,DATABASE_URL:database.config.url},timeoutMs:120000}));
  const regressionMigration=run("isolated regression migration",()=>resetDatabase(root,true));
  const actualCommands = new Map(),
    caseExecutions = [];
  for (const item of plan.cases) {
    if(item.testCaseId==="Phase016:mutation")continue;
    let execution = actualCommands.get(item.command);
    if (!execution) {
      execution = testCommand(item.command, `case-command-${actualCommands.size + 1}`, env);
      actualCommands.set(item.command, execution);
    }
    requireCaseExecution(item, execution, npmCli);
    caseExecutions.push({ testCaseId: item.testCaseId, ...execution, rows: undefined });
  }
  const dedicated = actualCommands.get(plan.engineeringRegression.dedicatedCardCommand);
  assert(dedicated);
  const dedicatedMappings = requireMappings(plan, dedicated.rows);
  const full = testCommand("npm run test", "full-regression", env, 900000);
  const coverage = requireDiscovery(prepared.discovery.data, full.rows, root),
    mappings = requireMappings(plan, full.rows);
  checks.build = run("build", () => npmRun("build", [], { env, timeoutMs: 300000 }));
  checks.status = run("migrate status", () =>
    command(process.execPath, [prismaCli, "migrate", "status"], {
      env: { ...env, DATABASE_URL: database.config.url },
    }),
  );
  checks.drift=run("Prisma schema drift",()=>command(process.execPath,[prismaCli,"migrate","diff","--from-schema-datasource","prisma/schema.prisma",
    "--to-schema-datamodel","prisma/schema.prisma","--exit-code"],{env:{...env,DATABASE_URL:database.config.url}}));
  const routePath=rawPath("legacy-route-http.json");
  checks.routes=run("compiled Next legacy route HTTP",()=>command(process.execPath,["tests/phase016/routes.mjs","--output",routePath],{env,timeoutMs:120000}));
  checks.routeReport=storeRaw("legacy-route-http.json",routePath);
  const importPath=rawPath("import-boundary.json");
  checks.imports=run("complete source Provider import boundary",()=>command(process.execPath,["--conditions=react-server","--import","tsx",
    "tests/phase016/import-scan.ts","--output",importPath],{env}));
  checks.importReport=storeRaw("import-boundary.json",importPath);
  const negativeResult=run("isolated negative controls and restored card",()=>command(process.execPath,
    ["docs/phase-plans/verify-phase016.mjs","--negative-controls"],{env,timeoutMs:300000}));
  const negativePath=`${directory}/negative-run/negative-controls.json`,negatives=json(negativePath);
  artifact(negativePath);
  for(const binding of negatives.artifacts)artifact(binding.path);
  for(const observation of negatives.observations)recordCommand(observation);
  caseExecutions.push({testCaseId:"Phase016:mutation",logicalCommand:plan.cases.at(-1).command,result:negativeResult,
    reportPath:negativePath,reportHash:hash(negativePath)});
  requireCaseExecution(plan.cases.at(-1),caseExecutions.at(-1),npmCli);
  const databaseEvidence = await inspectDatabase(database.config);
  stableSources();
  for (const [file, expected] of Object.entries(executionDependencyHashes))
    assert.equal(hash(file), expected, `EXECUTION_DEPENDENCY_CHANGED:${file}`);
  const shared = {
    artifacts: [...artifacts.values()],
    discovery: {
      reportPath: prepared.discovery.path,
      reportHash: prepared.discovery.sha256,
      ...coverage,
    },
    full: { ...full, rows: undefined, mappings },
    dedicated: { ...dedicated, rows: undefined, mappings: dedicatedMappings },
    database: databaseEvidence,
  };
  for (const item of plan.cases)
    archive(`${item.testCaseId.split(":")[1]}.json`, {
      testCaseId: item.testCaseId,
      command: item.command,
      status: "PASS",
      exitCode: 0,
      numerator: 1,
      denominator: 1,
      inputPath: item.inputPath,
      inputHash: hash(item.inputPath),
      planHash,
      sourceHashes: startHashes,
      simulation: true,
      productionTraffic: false,
      details: {
        ...shared,
        assertionMapping: mappings.find((x) => x.testCaseId === item.testCaseId),
        dedicatedAssertionMapping: dedicatedMappings.find((x) => x.testCaseId === item.testCaseId),
        actualExecution: caseExecutions.find((x) => x.testCaseId === item.testCaseId),
        negativeControls: item.testCaseId === "Phase016:mutation" ? negatives : undefined,
      },
    });
  const supporting = {
    lint: checks.lint,
    typecheck: checks.typecheck,
    "format:check": checks.format,
    build: checks.build,
    "full-regression": shared.full,
    "dedicated-card": shared.dedicated,
    "prisma-migrate": {result:migration,regressionResult:regressionMigration,namedResult:namedMigration},
    "prisma-migrate-status": checks.status,
    "import-boundary": {result:checks.imports,reportPath:checks.importReport.path,reportHash:checks.importReport.sha256},
    "secret-scan": checks.scan,
    "negative-controls": negatives,
    layout: checks.layout,
    "validator-regression": {result:checks.validator,reportPath:checks.validatorReport.path,reportHash:checks.validatorReport.sha256},
    "evidence-guards": {result:checks.guards,reportPath:checks.guardReport.path,reportHash:checks.guardReport.sha256},
    "recovery-guards": {result:checks.guards,reportPath:checks.guardReport.path,reportHash:checks.guardReport.sha256},
    "legacy-route-http": {result:checks.routes,reportPath:checks.routeReport.path,reportHash:checks.routeReport.sha256},
    "schema-drift": checks.drift,
  };
  archive("quality.json", {
    phase: 16,
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
      assert(supporting[checkId]);
      return { checkId, status: "PASS", details: supporting[checkId] };
    }),
    artifacts: [...artifacts.values()],
    observations,
    testCount: full.rows.length,
    dedicatedCount: dedicated.rows.length,
    discovery: shared.discovery,
    full: shared.full,
    dedicated: shared.dedicated,
    caseExecutions,
    negativeControls: negatives,
    database: databaseEvidence,
    schemaHash: hash("prisma/schema.prisma"),
    migrationHash: hash("prisma/migrations/20260914165140_chat_command_events/migration.sql"),
    scan: supporting["secret-scan"],
    costAccounting: {
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - Date.parse(startedAt),
      actualCommands: observations.length,
      logicalCaseCommands: actualCommands.size,
      fullRegressionExecutions: 1,
      dedicatedExecutions: 1,
      restorationExecutions: 1,
      negativeExecutions: negatives.rows.length,
      crossAttemptReuse: "disabled",
    },
  });
  console.warn(
    JSON.stringify({
      status: "AUTOMATED_CHECKS_PASS",
      cases: plan.cases.length,
      tests: full.rows.length,
      dedicated: dedicated.rows.length,
      negatives: negatives.rows.length,
      independentReview: "PENDING",
    }),
  );
}
try {
  if (negativeOnly) {
    checkPlan();const negatives=await negativeControls(path.join(root,fullDatabasePath));
    archive("negative-controls.json",{...negatives,artifacts:[...artifacts.values()],observations});
    console.warn(JSON.stringify({status:"NEGATIVE_CONTROLS_PASS",reportPath:`${archiveRoot}/negative-controls.json`}));
  } else if (formal) await all();
  else if (process.argv.includes("--precheck")) {
    await precheck();
    console.warn(JSON.stringify({ status: "PRECHECK_PASS", sources: plan.sourcePaths.length }));
  } else throw new Error("Use --precheck or --all");
} catch (error) {
  if (formal && !negativeOnly && !fs.existsSync(path.join(root, directory, "attempt.json")))
    write(`${directory}/attempt.json`, {
      phase: 16,
      attemptId: plan.attemptId,
      status: "FAIL",
      blockedCategory: "VERIFICATION",
      artifactCommit: null,
      planHash,
      sourceHashes: startHashes,
      command: "node docs/phase-plans/verify-phase016.mjs --all",
      observations,
      artifacts: [...artifacts.values()],
      error: safe(error.stack ?? error),
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  console.error(safe(error.stack ?? error));
  process.exitCode = 1;
}
