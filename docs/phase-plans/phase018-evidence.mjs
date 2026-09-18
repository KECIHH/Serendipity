import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  requireEvidenceSources,
  requireHashCoverage,
  requireReportBinding,
  requireReviewIdentity,
} from "../../scripts/phase-evidence.mjs";

export const startCommit = "de741a4580cdd2b80e28cb7075fa1160f2696783";
export const dedicatedCommand = "npm run test -- mock-provider ai-debug-api ai-e2e";
export const caseTags = Object.fromEntries(
  [
    "success",
    "timeout",
    "invalid-json",
    "schema-mismatch",
    "repair",
    "stream-interruption",
    "cost",
    "authorization",
  ].map((tag) => [`Phase018:${tag}`, `${tag}:`]),
);
export const caseIds = [...Object.keys(caseTags), "Phase018:negative-controls"];
export const supportingCheckIds = [
  "typecheck",
  "lint",
  "format:check",
  "build",
  "full-regression",
  "dedicated-card",
  "import-boundary",
  "secret-scan",
  "negative-controls",
  "layout",
  "evidence-guards",
  "schema-provenance",
  "api-contract",
  "database-audit",
  "premature-route-scan",
];
export const negativeDefinitions = [
  {
    id: "admin-guard",
    file: "src/app/api/admin/ai-debug/test/route.ts",
    testFile: "tests/phase018/ai-debug-api.test.ts",
    pattern: "ai-debug-api: anonymous, non-admin, disabled and invalidated sessions write nothing",
    witness: "ADMIN_GUARD_REQUIRED",
    caseId: "Phase018:authorization",
  },
  {
    id: "mock-determinism",
    file: "src/server/ai/mock-provider.ts",
    testFile: "tests/phase018/mock-provider.test.ts",
    pattern: "mock-provider: success, clock, usage, chunk boundaries and trace are caller supplied",
    witness: "MOCK_DETERMINISM_REQUIRED",
    caseId: "Phase018:success",
  },
  {
    id: "schema-parse",
    file: "src/lib/ai/json-parser.ts",
    testFile: "tests/integration/ai-e2e.test.ts",
    pattern: "schema-mismatch: well-formed but non-conforming JSON is classified SCHEMA_MISMATCH",
    witness: "SCHEMA_MISMATCH_REQUIRED",
    caseId: "Phase018:schema-mismatch",
  },
  {
    id: "formal-write",
    file: "src/server/ai/debug-runner.ts",
    testFile: "tests/integration/ai-e2e.test.ts",
    pattern: "success: a Mock success reaches SUCCEEDED with one attempt and no formal plan write",
    witness: "FORMAL_PLAN_WRITE_BOUNDARY_REQUIRED",
    caseId: "Phase018:success",
  },
  {
    id: "delta-persistence",
    file: "src/app/api/admin/ai-debug/stream/route.ts",
    testFile: "tests/integration/ai-e2e.test.ts",
    pattern:
      "stream-interruption: deltas stay transient, a lost first response resumes and GET recovers with zero calls",
    witness: "TRANSIENT_DELTA_REQUIRED",
    caseId: "Phase018:stream-interruption",
  },
];
export const guardPaths = [
  "docs/phase-plans/phase018-evidence.mjs",
  "docs/phase-plans/phase018-runtime.mjs",
  "docs/phase-plans/prepare-phase018.mjs",
  "docs/phase-plans/verify-phase018.mjs",
  "docs/phase-plans/complete-phase018.mjs",
  "scripts/phase-evidence.mjs",
  "tests/phase018/evidence-guards.mjs",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sortedBindings = (rows) =>
  rows
    .map(({ file, fullName }) => ({ file, fullName }))
    .sort((a, b) => `${a.file}:${a.fullName}`.localeCompare(`${b.file}:${b.fullName}`, "en"));

export function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function executionPaths(pkg) {
  return [
    ...Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).map(
      (name) => `node_modules/${name}/package.json`,
    ),
    ".scaffold/tools/node_modules/npm/package.json",
    ".scaffold/tools/node_modules/npm/bin/npm-cli.js",
    "node_modules/.prisma/client/schema.prisma",
    "node_modules/prisma/build/index.js",
    "node_modules/vitest/vitest.mjs",
    "node_modules/tsx/dist/cli.mjs",
  ].sort();
}

export function requireVitest(raw, { expectedFailure = false, allowFiltered = false, base = process.cwd() } = {}) {
  assert(raw && Array.isArray(raw.testResults), "VITEST_REPORT_REQUIRED");
  const rows = raw.testResults.flatMap((file) => {
    assert.equal(typeof file.name, "string");
    assert(Array.isArray(file.assertionResults));
    const relative = path.relative(base, file.name).replaceAll("\\", "/");
    assert(!relative.startsWith("../") && !path.isAbsolute(relative), "VITEST_ROOT");
    return file.assertionResults.map((item) => ({
      file: relative,
      name: [...item.ancestorTitles, item.title].join(" "),
      fullName: item.fullName,
      title: item.title,
      status: item.status,
      failureMessages: item.failureMessages ?? [],
    }));
  });
  assert(rows.length > 0, "ZERO_TESTS");
  assert.equal(
    new Set(rows.map((row) => row.file + "::" + row.fullName)).size,
    rows.length,
    "DUPLICATE_TEST",
  );
  assert.equal(raw.numTotalTests, rows.length, "TEST_COUNTER");
  assert.equal(raw.numPassedTests, rows.filter((row) => row.status === "passed").length, "PASSED_COUNTER");
  assert.equal(raw.numFailedTests, rows.filter((row) => row.status === "failed").length, "FAILED_COUNTER");
  assert.equal(
    raw.numPendingTests,
    rows.filter((row) => ["skipped", "pending"].includes(row.status)).length,
    "PENDING_COUNTER",
  );
  assert.equal(raw.numTodoTests ?? 0, rows.filter((row) => row.status === "todo").length, "TODO_COUNTER");
  assert.equal(raw.numRuntimeErrors ?? 0, 0, "RUNTIME_ERRORS");
  if (expectedFailure) {
    assert.equal(raw.success, false, "NEGATIVE_UNEXPECTEDLY_GREEN");
    assert.equal(raw.numFailedTests, 1, "NEGATIVE_FAILURE_COUNT");
    if (!allowFiltered) assert.equal(raw.numPendingTests, 0);
    assert.equal(raw.numPassedTests, 0, "NEGATIVE_EXTRA_PASSES");
  } else {
    assert.equal(raw.success, true, "VITEST_FAILED");
    assert(rows.every((row) => row.status === "passed"), "NONPASSING_TEST");
  }
  return rows;
}

export function requireDiscovery(discovery, rows, base = process.cwd()) {
  assert(Array.isArray(discovery) && discovery.length > 0, "DISCOVERY_REQUIRED");
  const expected = discovery.map(
    (row) => `${path.relative(base, row.file).replaceAll("\\", "/")}::${row.name.replaceAll(" > ", " ")}`,
  );
  const observed = rows.map((row) => `${row.file}::${row.name}`);
  assert.equal(new Set(expected).size, expected.length, "DUPLICATE_DISCOVERY");
  assert.deepEqual(expected.sort(), observed.sort(), "DISCOVERY_MISMATCH");
  return { discovered: expected.length, executed: observed.length };
}

export function requireMappings(plan, rows) {
  return plan.cases.map((item) => {
    if (item.testCaseId === caseIds.at(-1))
      return { testCaseId: item.testCaseId, observedIn: "five-mutations-and-restored-eight-fixtures" };
    const assertions = sortedBindings(
      rows.filter(
        (row) =>
          row.file.startsWith("tests/integration/") &&
          row.fullName.includes(caseTags[item.testCaseId]),
      ),
    );
    assert.deepEqual(assertions, plan.assertionBindings[item.testCaseId], `CASE_MAPPING:${item.testCaseId}`);
    return { testCaseId: item.testCaseId, tag: caseTags[item.testCaseId], assertions };
  });
}

export function mutate(id, original) {
  const once = (search, replacement) => {
    const index = original.indexOf(search);
    assert(index >= 0, `MUTATION_ANCHOR:${id}`);
    assert.equal(original.indexOf(search, index + search.length), -1, `MUTATION_ANCHOR_ONCE:${id}`);
    return original.slice(0, index) + replacement + original.slice(index + search.length);
  };
  if (id === "admin-guard")
    return once(
      "export const POST = withAdminRoute(async (request, _route, principal) => {",
      'export const POST = (async (request: Request, _route: unknown) => {\n  const principal = { id: "phase018-bypass", email: "bypass@serendipity.invalid", role: "ADMIN" as const, audience: "ADMIN" as const, expiresAt: new Date() };',
    );
  if (id === "mock-determinism")
    return once(
      "  private fixtureOutput(request: ProviderRequest): string {\n    return (\n      this.options.output ??",
      '  private fixtureOutput(request: ProviderRequest): string {\n    return (\n      (this.options.output ?? "") + Math.random().toString(36).slice(2) ||',
    );
  if (id === "schema-parse")
    return once(
      "  const parsed = schema.safeParse(value);",
      "  const parsed = { success: true, data: value as T, issues: [] };",
    );
  if (id === "formal-write")
    return once(
      "  await client.$transaction(async (tx) => {\n    await assertTaskLease(tx, lease);\n    await tx.aiDebugRun.updateMany({",
      '  await client.$transaction(async (tx) => {\n    await assertTaskLease(tx, lease);\n    await tx.travelRecord.create({ data: { title: "phase018-debug", status: "DRAFT", requirementJson: (parsedData ?? {}) as Prisma.InputJsonObject } });\n    await tx.aiDebugRun.updateMany({',
    );
  if (id === "delta-persistence")
    return once(
      '        const handler = debugTaskHandler(async (text) => {\n          send("delta", { debugRunId: runId, text });\n        });',
      '        const handler = debugTaskHandler(async (text) => {\n          await db.outbox.create({ data: { aggregateId: await debugTaskAggregateId(db, runId), type: "ai-debug.delta", eventId: "evt_" + randomUUID().replaceAll("-", ""), payloadHash: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""), payloadJson: { text } } });\n          send("delta", { debugRunId: runId, text });\n        });',
    );
  throw new Error("UNKNOWN_MUTATION");
}

export function requireNegative(raw, definition, base) {
  const rows = requireVitest(raw, { expectedFailure: true, allowFiltered: true, base });
  const target = rows.find((row) => row.status === "failed");
  assert.equal(target.file, definition.testFile, "NEGATIVE_WRONG_FILE");
  assert(target.fullName.includes(definition.pattern), "NEGATIVE_WRONG_ASSERTION");
  assert(target.failureMessages.length > 0, "NEGATIVE_NO_FAILURE");
  const messages = target.failureMessages.join("\n");
  assert(messages.includes(definition.witness), "NEGATIVE_BUSINESS_WITNESS");
  assert(/\bAssertionError\b|\bERR_ASSERTION\b/.test(messages), "NEGATIVE_ASSERTION_CLASS");
  assert(
    !/\b(?:TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError):/.test(messages),
    "NEGATIVE_INFRASTRUCTURE_FAILURE",
  );
  assert(
    !/Cannot find module|Failed to resolve import|Transform failed/.test(messages),
    "NEGATIVE_INFRASTRUCTURE_FAILURE",
  );
  return {
    id: definition.id,
    file: definition.file,
    testFile: definition.testFile,
    assertion: target.fullName,
    signal: messages.slice(0, 500),
  };
}

export function requireInputs(receipt, { hashFile, readJson, git }) {
  assert.equal(receipt.phase, 18);
  assert.equal(receipt.requestedThrough, 18);
  assert.equal(receipt.phaseStartCommit, startCommit, "START_COMMIT");
  const previous = JSON.parse(git(["show", `${startCommit}:docs/phase-plans/Phase017-inputs.json`]));
  const state = JSON.parse(git(["show", `${startCommit}:docs/roadmap-run.json`]));
  assert.equal(state.completedThrough, 17);
  assert.equal(state.currentPhase, 18);
  for (const key of ["baselineCommit", "executionBaselineCommit"])
    assert.equal(receipt[key], state.executionBaselineCommit);
  assert.equal(receipt.manifestHash, state.manifestHash);
  for (const key of [
    "pinnedInputs",
    "checkpointMigration",
    "checkpointMaintenance",
    "validationPolicy",
    "executionMaintenance",
    "executionPolicy",
  ])
    assert.deepEqual(receipt[key], previous[key], `INPUT_CHAIN:${key}`);
  for (const item of [
    ...receipt.pinnedInputs,
    receipt.checkpointMigration,
    receipt.checkpointMaintenance,
    receipt.validationPolicy,
    receipt.executionMaintenance,
    receipt.executionPolicy,
  ])
    assert.equal(hashFile(item.path), item.sha256, `INPUT_HASH:${item.path}`);
  const checkpoint = state.checkpoints.at(-1);
  const prerequisite = receipt.prerequisites;
  assert.equal(prerequisite.phase, 17);
  assert.equal(prerequisite.metadataCommit, startCommit);
  for (const key of ["artifactCommit", "evidencePath", "evidenceHash"])
    assert.equal(prerequisite[key], checkpoint[key], `PREVIOUS_${key}`);
  assert.equal(git(["rev-parse", `${startCommit}^`]).trim(), prerequisite.artifactCommit, "PREVIOUS_DIRECT_PARENT");
  assert.equal(hashFile(prerequisite.evidencePath), prerequisite.evidenceHash);
  assert.equal(readJson(prerequisite.evidencePath).status, "PASS");
  assert.equal(prerequisite.schemaPath, "prisma/schema.prisma");
  // Phase018 changes the schema, so the frozen predecessor bytes are read from the start commit.
  assert.equal(
    digest(git(["show", `${startCommit}:${prerequisite.schemaPath}`], null)),
    prerequisite.schemaHash,
    "SCHEMA_CHANGED",
  );
  assert.equal(prerequisite.migrations.length, 10);
  for (const item of prerequisite.migrations) {
    assert.equal(hashFile(item.path), item.sha256, `PREDECESSOR_MIGRATION_PRESENT:${item.path}`);
    assert.equal(digest(git(["show", `${startCommit}:${item.path}`], null)), item.sha256);
  }
  assert.equal(receipt.preflight.head, startCommit);
  assert.equal(receipt.preflight.originMain, startCommit);
  assert.equal(receipt.preflight.porcelain, "");
  assert.deepEqual(receipt.preflight.seals.map((row) => row.executable), ["powershell", "pwsh"]);
  for (const seal of receipt.preflight.seals) {
    assert.equal(seal.exitCode, 0);
    const value = JSON.parse(seal.stdout || seal.stderr);
    assert.equal(value.status, "PASS");
    assert.equal(value.completedThrough, 17);
  }
  return receipt;
}

export function requirePlan(plan, { hashFile, readJson, allowUnwrittenDiscovery = false }) {
  assert.equal(plan.phase, 18);
  assert.match(plan.attemptId, /^attempt-[1-9]\d*$/);
  assert.equal(plan.phaseStartCommit, startCommit);
  assert.equal(plan.engineeringRegression.baseCommit, startCommit);
  assert.equal(plan.testMode, "full");
  assert.equal(plan.crossAttemptReuse, "disabled");
  assert.equal(plan.engineeringRegression.fullCommand, "npm run test");
  assert.equal(plan.engineeringRegression.dedicatedCardCommand, dedicatedCommand);
  assert.deepEqual(plan.requiredCaseIds, caseIds);
  assert.deepEqual(plan.cases.map((item) => item.testCaseId), caseIds);
  assert.deepEqual(plan.threshold, {
    originalThreshold: 8,
    automatedThreshold: 8,
    requiredPassRate: 1,
    formalPlanWrites: 0,
    mockNetworkCalls: 0,
    waived: false,
  });
  assert.deepEqual(plan.negativeControls, negativeDefinitions.map((row) => row.id));
  assert.equal(new Set(plan.sourcePaths).size, plan.sourcePaths.length);
  for (const item of plan.cases) {
    const negative = item.testCaseId === caseIds.at(-1);
    assert.equal(
      item.command,
      negative ? "node docs/phase-plans/verify-phase018.mjs --negative-controls" : dedicatedCommand,
    );
    assert.equal(item.denominator, negative ? 5 : 1);
    assert.equal(item.inputPath, "tests/phase018/fixtures.json");
    assert(plan.sourcePaths.includes(item.inputPath));
    assert.equal(
      item.outputPath,
      `docs/evidence/attempts/Phase018/${plan.attemptId}/${item.testCaseId.split(":")[1]}.json`,
    );
    if (!negative) {
      const bindings = plan.assertionBindings[item.testCaseId];
      assert(Array.isArray(bindings) && bindings.length > 0, "ASSERTION_BINDINGS_REQUIRED");
      assert.equal(new Set(bindings.map((row) => row.file + "::" + row.fullName)).size, bindings.length);
      for (const row of bindings)
        assert(
          row.file.startsWith("tests/integration/") &&
            plan.sourcePaths.includes(row.file) &&
            row.fullName.includes(caseTags[item.testCaseId]),
          "FOREIGN_CASE_ASSERTION",
        );
    }
  }
  assert.deepEqual(Object.keys(plan.assertionBindings).sort(), Object.keys(caseTags).sort());
  assert.equal(plan.previousAttempts.length, Number(plan.attemptId.split("-")[1]) - 1);
  assert.equal(plan.discoverySnapshot.path, `docs/evidence/attempts/Phase018/${plan.attemptId}/frozen-discovery.json`);
  if (!allowUnwrittenDiscovery)
    assert.equal(hashFile(plan.discoverySnapshot.path), plan.discoverySnapshot.sha256, "DISCOVERY_HASH");
  assert.deepEqual(plan.supportingChecks, supportingCheckIds);
  assert.equal(plan.executionFreeze.requirementsPath, `docs/evidence/attempts/Phase018/attempt-1/requirements-freeze.json`);
  assert.equal(hashFile(plan.executionFreeze.requirementsPath), plan.executionFreeze.requirementsHash);
  void readJson;
  return plan;
}

export function requireCaseExecution(item, execution, npmCli) {
  assert.equal(execution.logicalCommand, item.command);
  assert.equal(execution.result.exitCode, 0);
  assert.equal(execution.result.timedOut, false);
  assert.match(execution.reportHash, /^[a-f0-9]{64}$/);
  if (item.testCaseId === caseIds.at(-1)) {
    assert.deepEqual(
      execution.result.arguments,
      ["docs/phase-plans/verify-phase018.mjs", "--negative-controls"],
      "NEGATIVE_COMMAND",
    );
    return;
  }
  const prefix = [npmCli, "run", "test", ...item.command.split(" ").slice(3)];
  assert.deepEqual(execution.result.arguments.slice(0, prefix.length), prefix, "UNEXECUTED_CASE_COMMAND");
  assert.equal(execution.result.arguments.length, prefix.length + 2);
  assert.equal(execution.result.arguments.at(-2), "--reporter=json");
  assert(execution.result.arguments.at(-1).startsWith("--outputFile="));
}

export function requireArtifactParent(
  { artifactCommit, phaseStartCommit, recoveryParents = [] },
  git,
) {
  assert.equal(phaseStartCommit, startCommit);
  assert.equal(git(["show", "-s", "--format=%s", artifactCommit]).trim(), "phase(018): artifact");
  const parent = git(["rev-parse", `${artifactCommit}^`]).trim();
  assert(
    [startCommit, ...recoveryParents].includes(parent),
    "ARTIFACT_DIRECT_PARENT",
  );
}

export function requireSupportingResults(plan, quality, npmCli) {
  assert.deepEqual(quality.supportingChecks, plan.supportingChecks);
  assert.deepEqual(
    quality.supportingResults.map((row) => row.checkId),
    plan.supportingChecks,
  );
  const commands = Object.fromEntries(
    ["typecheck", "lint", "format:check", "build"].map((name) => [name, [npmCli, "run", name]]),
  );
  commands.layout = ["scripts/check-project-layout.mjs"];
  commands["schema-provenance"] = ["scripts/generate-ai-schemas.mjs", "--check"];
  commands["api-contract"] = ["scripts/generate-api-contract.mjs", "--check"];
  commands["evidence-guards"] = ["tests/phase018/evidence-guards.mjs", "--output"];
  commands["premature-route-scan"] = ["tests/phase018/premature-routes.mjs", "--output"];
  for (const row of quality.supportingResults) {
    assert.equal(row.status, "PASS");
    assert(row.details && Object.keys(row.details).length > 0, "EMPTY_SUPPORTING_EVIDENCE");
    if (commands[row.checkId]) {
      const result = row.details.result;
      assert(result, "MISSING_SUPPORTING_COMMAND");
      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, false);
      const expected = commands[row.checkId];
      assert.deepEqual(result.arguments.slice(0, expected.length), expected, "WRONG_SUPPORTING_COMMAND");
      assert.equal(result.arguments.length, expected.length + (row.checkId === "evidence-guards" || row.checkId === "premature-route-scan" ? 1 : 0));
      assert(
        quality.observations.some((record) => JSON.stringify(record) === JSON.stringify(result)),
        "SUPPORTING_NOT_EXECUTED",
      );
    }
  }
}

export function auditEvidence(
  plan,
  { root, planPath, receiptPath, directory, readJson, hashFile, readBytes, git, npmCli },
  withReview = true,
) {
  const dependencies = { readJson, hashFile, git };
  requirePlan(plan, dependencies);
  const receipt = requireInputs(readJson(receiptPath), dependencies);
  const planHash = hashFile(planPath);
  assert.equal(hashFile(`${directory}/frozen-plan.json`), planHash, "FROZEN_PLAN");
  const qualityPath = `${directory}/quality.json`;
  const quality = readJson(qualityPath);
  for (const [field, expected] of Object.entries({
    phase: 18,
    attemptId: plan.attemptId,
    planHash,
    status: "PASS",
    simulation: true,
    productionTraffic: false,
    testMode: "full",
    crossAttemptReuse: "disabled",
  }))
    assert.equal(quality[field], expected, `QUALITY_${field}`);
  requireHashCoverage(quality.sourceHashes, plan.sourcePaths, hashFile, "QUALITY_SOURCE");
  requireHashCoverage(
    quality.executionDependencyHashes,
    executionPaths(readJson("package.json")),
    hashFile,
    "EXECUTION_DEPENDENCIES",
  );
  for (const item of quality.artifacts) assert.equal(hashFile(item.path), item.sha256, `RAW_ARTIFACT:${item.path}`);
  const reports = plan.cases.map((item) => {
    const report = readJson(item.outputPath);
    requireReportBinding(report, item, planHash, plan.sourcePaths, hashFile);
    assert.equal(report.simulation, true);
    assert.equal(report.productionTraffic, false);
    return report;
  });
  function testExecution(execution, logicalCommand) {
    assert.equal(hashFile(execution.reportPath), execution.reportHash, "RAW_REPORT_HASH");
    assert.equal(execution.logicalCommand, logicalCommand);
    assert.equal(execution.result.exitCode, 0);
    assert.equal(execution.result.cwd, root);
    assert(
      quality.observations.some((row) => JSON.stringify(row) === JSON.stringify(execution.result)),
      "COMMAND_NOT_RECORDED",
    );
    const args = [npmCli, "run", "test", ...(logicalCommand === "npm run test" ? ["--"] : logicalCommand.split(" ").slice(3))];
    assert.deepEqual(execution.result.arguments.slice(0, args.length), args, "TEST_COMMAND_MISMATCH");
    const rows = requireVitest(readJson(execution.reportPath), { base: root });
    assert.deepEqual(execution.mappings, requireMappings(plan, rows));
    return rows;
  }
  const fullRows = testExecution(quality.full, "npm run test");
  const dedicatedRows = testExecution(quality.dedicated, dedicatedCommand);
  assert.equal(quality.testCount, fullRows.length);
  assert.equal(quality.dedicatedCount, dedicatedRows.length);
  assert.equal(hashFile(quality.discovery.reportPath), quality.discovery.reportHash);
  const discovery = requireDiscovery(readJson(quality.discovery.reportPath), fullRows, root);
  requireDiscovery(readJson(plan.discoverySnapshot.path), fullRows, root);
  for (const [key, value] of Object.entries(discovery)) assert.equal(quality.discovery[key], value);
  const expectedDedicated = readJson(plan.discoverySnapshot.path).filter((row) =>
    /mock-provider|ai-debug-api|ai-e2e/.test(path.relative(root, row.file)),
  );
  requireDiscovery(expectedDedicated, dedicatedRows, root);
  assert.deepEqual(
    quality.caseExecutions.map((row) => row.testCaseId),
    caseIds,
  );
  for (const [index, execution] of quality.caseExecutions.entries()) {
    requireCaseExecution(plan.cases[index], execution, npmCli);
    assert.equal(hashFile(execution.reportPath), execution.reportHash);
    assert.deepEqual(reports[index].details.actualExecution, execution);
    assert.deepEqual(reports[index].details.assertionMapping, quality.dedicated.mappings[index]);
  }
  const negatives = quality.negativeControls;
  assert.deepEqual(
    negatives.rows.map((row) => row.id),
    negativeDefinitions.map((row) => row.id),
  );
  assert.equal(negatives.sourceUnchanged, true);
  for (const [index, row] of negatives.rows.entries()) {
    const definition = negativeDefinitions[index];
    const mutation = readJson(row.receiptPath);
    assert.equal(hashFile(row.receiptPath), row.receiptHash);
    assert.equal(hashFile(row.reportPath), row.reportHash);
    assert.equal(row.testSourceHash, hashFile(definition.testFile));
    assert.deepEqual(row.failureEvidence, requireNegative(readJson(row.reportPath), definition, row.cwd));
    assert.deepEqual(row.changes, [
      {
        sourcePath: definition.file,
        originalHash: hashFile(definition.file),
        mutatedHash: digest(Buffer.from(mutate(row.id, readBytes(definition.file).toString()))),
      },
    ]);
    assert.deepEqual(row.changes, mutation.changes);
    assert.equal(mutation.testSourceHash, row.testSourceHash);
    assert.equal(mutation.cwd, row.cwd);
    assert.deepEqual(
      Object.keys(mutation.fixtureHashes).sort(),
      [...plan.fixtureSourcePaths].sort(),
      "INCOMPLETE_MUTATION_SOURCES",
    );
    for (const [file, expected] of Object.entries(mutation.fixtureHashes))
      assert.equal(expected, file === definition.file ? row.changes[0].mutatedHash : hashFile(file));
    assert.equal(row.result.exitCode, 1);
    assert.equal(row.result.cwd, row.cwd);
    assert.equal(row.originalCase, definition.caseId);
    assert.deepEqual(row.result.arguments.slice(0, 6), [npmCli, "run", "test", "--", definition.testFile, "-t"]);
  }
  const restored = testExecution(negatives.restored, dedicatedCommand);
  requireDiscovery(expectedDedicated, restored, root);
  requireSupportingResults(plan, quality, npmCli);
  for (const [index, result] of quality.observations.entries()) {
    assert.deepEqual(readJson(`${directory}/commands/${String(index + 1).padStart(3, "0")}.json`), result);
    assert.equal(result.timedOut, false);
    assert(Number.isFinite(result.durationMs) && result.durationMs >= 0);
    assert(
      result.exitCode === 0 ||
        negatives.rows.some(
          (row) => row.result.exitCode === 1 && JSON.stringify(row.result) === JSON.stringify(result),
        ),
      "UNEXPLAINED_COMMAND_FAILURE",
    );
  }
  const guards = readJson(`${directory}/evidence-guards.json`);
  assert.equal(guards.status, "PASS");
  assert.equal(guards.caseCount, guards.results.length);
  assert(guards.caseCount >= 24 && guards.results.every((row) => row.status === "PASS"));
  requireHashCoverage(guards.testedSourceHashes, guardPaths, hashFile, "GUARD_SOURCE");
  assert.equal(quality.database.appliedMigrations, 11);
  assert.equal(quality.database.runtimeOwner, false);
  assert.equal(quality.database.runtimeSuperuser, false);
  assert.equal(quality.schemaHash, hashFile("prisma/schema.prisma"));
  assert.equal(quality.fixtureHash, hashFile("tests/phase018/fixtures.json"));
  assert.equal(quality.promptVersionHash, hashFile("src/lib/ai/prompt-contract.json"));
  assert.equal(quality.database.rawOutputNonNull, 0);
  assert.equal(quality.database.formalPlanTables, 0);
  assert.equal(quality.database.debugFormalWrites, 0);
  assert.equal(quality.scan.hits, 0);
  assert.equal(quality.database.auditRowsMalformed, 0);
  let review = null;
  if (withReview) {
    review = readJson(`${directory}/review.json`);
    assert.equal(review.phase, 18);
    assert.equal(review.attemptId, plan.attemptId);
    assert.equal(review.planPath, planPath);
    assert.equal(review.planHash, planHash);
    assert.equal(review.decision, "PASS");
    requireReviewIdentity(review, plan.implementationContextId);
    requireHashCoverage(review.sourceHashes, requireEvidenceSources(plan), hashFile, "REVIEW_SOURCE");
    requireHashCoverage(review.reportHashes, plan.cases.map((row) => row.outputPath), hashFile, "REVIEW_REPORT");
    requireHashCoverage(review.supplementalReportHashes, [qualityPath], hashFile, "REVIEW_QUALITY");
    assert(Array.isArray(review.issues) && Array.isArray(review.dispositions));
    assert(
      review.issues.every((issue) =>
        review.dispositions.some((row) => row.issueId === issue.id && row.status === "RESOLVED"),
      ),
      "UNRESOLVED_REVIEW_ISSUE",
    );
  }
  return { receipt, reports, quality, review };
}
