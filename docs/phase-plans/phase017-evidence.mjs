import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { requirePriorCaseBinding, requireHashCoverage, requireReportBinding, requireReviewIdentity } from "../../scripts/phase-evidence.mjs";
export { requireVitest, requireDiscovery, regexEscape, executionPaths } from "./phase016-evidence.mjs";
import { requireVitest, requireDiscovery, requireNegative as priorRequireNegative, executionPaths } from "./phase016-evidence.mjs";

export const startCommit = "f57fae935e5657980433f8009d1c1e3a7ac97849";
export const dedicatedCommand = "npm run test -- json-parser schemas context-manager json-repair";
export const caseTags = Object.fromEntries(["clean", "parse", "schema", "repair-success", "repair-failure", "truncation"].map(tag => [`Phase017:${tag}`, `${tag}:`]));
export const caseIds = [...Object.keys(caseTags), "Phase017:negative-controls"];
export const negativeDefinitions = [
  { id: "fence-cleaning", file: "src/lib/ai/json-parser.ts", testFile: "tests/phase017/json-parser.test.ts", pattern: "clean: paired fences and BOM preserve the complete JSON", witness: "FENCE_CLEANING_REQUIRED", caseId: "Phase017:clean" },
  { id: "schema-validation", file: "src/lib/ai/json-parser.ts", testFile: "tests/phase017/json-parser.test.ts", pattern: "parse: data is typed only after strict schema validation", witness: "SCHEMA_VALIDATION_REQUIRED", caseId: "Phase017:parse" },
  { id: "retry-bound", file: "src/server/ai/json-repair.ts", testFile: "tests/phase017/json-repair.test.ts", pattern: "repair-failure: two unsuccessful repairs stop without a third call or partial write", witness: "REPAIR_LIMIT_REQUIRED", caseId: "Phase017:repair-failure" },
  { id: "fact-preservation", file: "src/server/ai/json-repair.ts", testFile: "tests/phase017/json-repair.test.ts", pattern: "repair-failure: altered facts fail even when both schema and original input references allow them", witness: "FACT_PRESERVATION_REQUIRED", caseId: "Phase017:repair-failure" },
  { id: "system-retention", file: "src/lib/ai/context-manager.ts", testFile: "tests/phase017/context-manager.test.ts", pattern: "truncation: system and newest turns survive message limits without mutating history", witness: "SYSTEM_RETENTION_REQUIRED", caseId: "Phase017:truncation" },
];
export const guardPaths = ["docs/phase-plans/phase017-evidence.mjs", "docs/phase-plans/phase017-runtime.mjs", "docs/phase-plans/prepare-phase017.mjs", "docs/phase-plans/verify-phase017.mjs", "docs/phase-plans/complete-phase017.mjs", "docs/phase-plans/phase016-evidence.mjs", "scripts/phase-evidence.mjs", "tests/phase017/evidence-guards.mjs"];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const sortedBindings = rows => rows.map(({ file, fullName }) => ({ file, fullName })).sort((a,b) => `${a.file}:${a.fullName}`.localeCompare(`${b.file}:${b.fullName}`, "en"));
export function requireNegative(raw, definition, base) {
  const value = priorRequireNegative(raw, definition, base);
  const messages = raw.testResults.flatMap(file => file.assertionResults).filter(row => row.status === "failed").flatMap(row => row.failureMessages).join("\n");
  assert(/\bAssertionError\b|\bERR_ASSERTION\b/.test(messages) && !/\b(?:TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError):/.test(messages), "NEGATIVE_ASSERTION_CLASS");
  return value;
}
export function requireInputs(receipt, { hashFile, readJson, git }) {
  assert.equal(receipt.phase, 17); assert.equal(receipt.requestedThrough, 17);
  assert.equal(receipt.phaseStartCommit, startCommit, "START_COMMIT");
  const previous = JSON.parse(git(["show", `${startCommit}:docs/phase-plans/Phase016-inputs.json`]));
  const state = JSON.parse(git(["show", `${startCommit}:docs/roadmap-run.json`]));
  assert.equal(state.completedThrough, 16); assert.equal(state.currentPhase, 17);
  for (const key of ["baselineCommit", "executionBaselineCommit"]) assert.equal(receipt[key], state.executionBaselineCommit);
  assert.equal(receipt.manifestHash, state.manifestHash);
  for (const key of ["pinnedInputs", "checkpointMigration", "checkpointMaintenance", "validationPolicy", "executionMaintenance", "executionPolicy"]) assert.deepEqual(receipt[key], previous[key], `INPUT_CHAIN:${key}`);
  for (const item of [...receipt.pinnedInputs, receipt.checkpointMigration, receipt.checkpointMaintenance, receipt.validationPolicy, receipt.executionMaintenance, receipt.executionPolicy]) assert.equal(hashFile(item.path), item.sha256, `INPUT_HASH:${item.path}`);
  const checkpoint = state.checkpoints.at(-1), prerequisite = receipt.prerequisites;
  assert.equal(prerequisite.phase, 16); assert.equal(prerequisite.metadataCommit, startCommit);
  for (const key of ["artifactCommit", "evidencePath", "evidenceHash"]) assert.equal(prerequisite[key], checkpoint[key], `PREVIOUS_${key}`);
  assert.equal(git(["rev-parse", `${startCommit}^`]).trim(), prerequisite.artifactCommit, "PREVIOUS_DIRECT_PARENT");
  assert.equal(hashFile(prerequisite.evidencePath), prerequisite.evidenceHash);
  assert.equal(readJson(prerequisite.evidencePath).status, "PASS");
  assert.equal(prerequisite.schemaPath, "prisma/schema.prisma");
  assert.equal(hashFile(prerequisite.schemaPath), prerequisite.schemaHash, "SCHEMA_CHANGED");
  assert.equal(digest(git(["show", `${startCommit}:${prerequisite.schemaPath}`], null)), prerequisite.schemaHash);
  assert.equal(prerequisite.migrations.length, 10);
  for (const item of prerequisite.migrations) { assert.equal(hashFile(item.path), item.sha256); assert.equal(digest(git(["show", `${startCommit}:${item.path}`], null)), item.sha256); }
  assert.equal(receipt.preflight.head, startCommit); assert.equal(receipt.preflight.originMain, startCommit); assert.equal(receipt.preflight.porcelain, "");
  assert.deepEqual(receipt.preflight.seals.map(row => row.executable), ["powershell", "pwsh"]);
  for (const seal of receipt.preflight.seals) { assert.equal(seal.exitCode, 0); const value = JSON.parse(seal.stdout || seal.stderr); assert.equal(value.status, "PASS"); assert.equal(value.completedThrough, 16); }
  return receipt;
}
export function requirePlan(plan, { hashFile, readJson, allowUnwrittenDiscovery = false }) {
  assert.equal(plan.phase, 17); assert.match(plan.attemptId, /^attempt-[1-9]\d*$/);
  assert.equal(plan.phaseStartCommit, startCommit); assert.equal(plan.engineeringRegression.baseCommit, startCommit);
  assert.equal(plan.testMode, "full"); assert.equal(plan.crossAttemptReuse, "disabled");
  assert.equal(plan.engineeringRegression.fullCommand, "npm run test"); assert.equal(plan.engineeringRegression.dedicatedCardCommand, dedicatedCommand);
  assert.deepEqual(plan.requiredCaseIds, caseIds); assert.deepEqual(plan.cases.map(item => item.testCaseId), caseIds);
  assert.deepEqual(plan.threshold, { originalThreshold: 6, automatedThreshold: 6, requiredPassRate: 1, unvalidatedPlanWrites: 0, maxRepairAttempts: 2, waived: false });
  assert.deepEqual(plan.negativeControls, negativeDefinitions.map(row => row.id));
  assert.equal(new Set(plan.sourcePaths).size, plan.sourcePaths.length);
  for (const item of plan.cases) {
    const negative = item.testCaseId === caseIds.at(-1);
    assert.equal(item.command, negative ? "node docs/phase-plans/verify-phase017.mjs --negative-controls" : dedicatedCommand);
    assert.equal(item.denominator, negative ? 5 : 1);
    assert.equal(item.inputPath, "tests/phase017/fixtures.json"); assert(plan.sourcePaths.includes(item.inputPath));
    assert.equal(item.outputPath, `docs/evidence/attempts/Phase017/${plan.attemptId}/${item.testCaseId.split(":")[1]}.json`);
    if (!negative) {
      const bindings = plan.assertionBindings[item.testCaseId];
      assert(Array.isArray(bindings) && bindings.length > 0, "ASSERTION_BINDINGS_REQUIRED");
      assert.equal(new Set(bindings.map(row => row.file + "::" + row.fullName)).size, bindings.length);
      for (const row of bindings) assert(row.file.startsWith("tests/phase017/") && plan.sourcePaths.includes(row.file) && row.fullName.includes(caseTags[item.testCaseId]), "FOREIGN_CASE_ASSERTION");
    }
  }
  assert.deepEqual(Object.keys(plan.assertionBindings).sort(), Object.keys(caseTags).sort());
  const original = readJson("docs/evidence/attempts/Phase017/attempt-1/requirements-freeze.json");
  requirePriorCaseBinding(plan, original, { readJson, hashFile });
  for (const check of original.supportingChecks) assert(plan.supportingChecks.includes(check), "REMOVED_SUPPORTING_CHECK");
  assert.equal(plan.executionFreeze.requirementsHash, hashFile("docs/evidence/attempts/Phase017/attempt-1/requirements-freeze.json"));
  assert.equal(plan.previousAttempts.length, Number(plan.attemptId.split("-")[1]) - 1);
  for (const [index, previous] of plan.previousAttempts.entries()) {
    assert.equal(previous.attemptId, `attempt-${index + 1}`); assert.equal(hashFile(previous.planPath), previous.planHash);
    const failure = readJson(previous.failurePath); assert.equal(failure.phase, 17); assert.equal(failure.attemptId, previous.attemptId); assert(["FAIL", "BLOCKED"].includes(failure.status)); assert.equal(failure.planHash, previous.planHash);
    requirePriorCaseBinding(plan, readJson(previous.planPath), { readJson, hashFile });
  }
  assert.equal(plan.discoverySnapshot.path, `docs/evidence/attempts/Phase017/${plan.attemptId}/frozen-discovery.json`);
  if (!allowUnwrittenDiscovery) assert.equal(hashFile(plan.discoverySnapshot.path), plan.discoverySnapshot.sha256, "DISCOVERY_HASH");
  return plan;
}
export function requireMappings(plan, rows) {
  return plan.cases.map(item => {
    if (item.testCaseId === caseIds.at(-1)) return { testCaseId: item.testCaseId, observedIn: "five-mutations-and-restored-six-groups" };
    const assertions = sortedBindings(rows.filter(row => row.file.startsWith("tests/phase017/") && row.fullName.includes(caseTags[item.testCaseId])));
    assert.deepEqual(assertions, plan.assertionBindings[item.testCaseId], `CASE_MAPPING:${item.testCaseId}`);
    return { testCaseId: item.testCaseId, tag: caseTags[item.testCaseId], assertions };
  });
}
export function mutate(id, original) {
  const replacements = {
    "fence-cleaning": [/return fence \? fence\[2\]\.trim\(\) : clean;/g, "return clean;"],
    "schema-validation": [/const parsed = schema\.safeParse\(value\);/g, "const parsed = { success: true, data: value as T, issues: [] };"],
    "retry-bound": [/index < 2/g, "index < 3"],
    "fact-preservation": [/if \(!preservesJsonFacts\(rawText, output\.repairedText\)\)\s*throw new Error\("VALIDATION_ERROR"\);/g, "void rawText;"],
    "system-retention": [/new Set\(required\.map\(\(\{ index \}\) => index\)\)/g, "new Set<number>()"],
  };
  assert(replacements[id], "UNKNOWN_MUTATION"); const [pattern, replacement] = replacements[id];
  assert.equal([...original.matchAll(pattern)].length, 1, `MUTATION_ANCHOR:${id}`);
  return original.replace(pattern, replacement);
}
export function requireCaseExecution(item, execution, npmCli) {
  assert.equal(execution.logicalCommand, item.command); assert.equal(execution.result.exitCode, 0); assert.equal(execution.result.timedOut, false);
  assert.match(execution.reportHash, /^[a-f0-9]{64}$/);
  if (item.testCaseId === caseIds.at(-1)) assert.deepEqual(execution.result.arguments, ["docs/phase-plans/verify-phase017.mjs", "--negative-controls"], "NEGATIVE_COMMAND");
  else {
    const prefix = [npmCli, "run", "test", ...item.command.split(" ").slice(3)];
    assert.deepEqual(execution.result.arguments.slice(0, prefix.length), prefix, "UNEXECUTED_CASE_COMMAND");
    assert.equal(execution.result.arguments.length, prefix.length + 2); assert.equal(execution.result.arguments.at(-2), "--reporter=json");
    assert(execution.result.arguments.at(-1).startsWith("--outputFile="));
  }
}
export function requireArtifactParent({ artifactCommit, phaseStartCommit }, git) {
  assert.equal(phaseStartCommit, startCommit); assert.equal(git(["show", "-s", "--format=%s", artifactCommit]).trim(), "phase(017): artifact");
  assert.equal(git(["rev-parse", `${artifactCommit}^`]).trim(), startCommit, "ARTIFACT_DIRECT_PARENT");
}
export function requireSupportingResults(plan, quality, npmCli) {
  assert.deepEqual(quality.supportingChecks, plan.supportingChecks); assert.deepEqual(quality.supportingResults.map(row => row.checkId), plan.supportingChecks);
  const commands = Object.fromEntries(["typecheck", "lint", "format:check", "build"].map(name => [name, [npmCli,"run",name]]));
  commands.layout = ["scripts/check-project-layout.mjs"];
  commands["schema-provenance"] = ["scripts/generate-ai-schemas.mjs","--check"];
  commands["evidence-guards"] = ["tests/phase017/evidence-guards.mjs","--output"];
  for (const row of quality.supportingResults) {
    assert.equal(row.status,"PASS"); assert(row.details && Object.keys(row.details).length > 0,"EMPTY_SUPPORTING_EVIDENCE");
    if (commands[row.checkId]) {
      const result = row.details.result; assert(result,"MISSING_SUPPORTING_COMMAND");
      assert.equal(result.exitCode,0); assert.equal(result.timedOut,false);
      const expected = commands[row.checkId];
      assert.deepEqual(result.arguments.slice(0,expected.length),expected,"WRONG_SUPPORTING_COMMAND");
      assert.equal(result.arguments.length,expected.length+(row.checkId==="evidence-guards"?1:0));
      assert(quality.observations.some(record=>JSON.stringify(record)===JSON.stringify(result)),"SUPPORTING_NOT_EXECUTED");
    }
  }
}
export function auditEvidence(plan, { root, planPath, receiptPath, directory, readJson, hashFile, readBytes, git, npmCli }, withReview = true) {
  const dependencies = { readJson, hashFile, git };
  requirePlan(plan, dependencies); const receipt = requireInputs(readJson(receiptPath), dependencies), planHash = hashFile(planPath);
  assert.equal(hashFile(`${directory}/frozen-plan.json`), planHash, "FROZEN_PLAN");
  const qualityPath = `${directory}/quality.json`, quality = readJson(qualityPath);
  for (const [field, expected] of Object.entries({ phase: 17, attemptId: plan.attemptId, planHash, status: "PASS", simulation: true, productionTraffic: false, testMode: "full", crossAttemptReuse: "disabled" })) assert.equal(quality[field], expected, `QUALITY_${field}`);
  requireHashCoverage(quality.sourceHashes, plan.sourcePaths, hashFile, "QUALITY_SOURCE");
  requireHashCoverage(quality.executionDependencyHashes, executionPaths(readJson("package.json")), hashFile, "EXECUTION_DEPENDENCIES");
  for (const item of quality.artifacts) assert.equal(hashFile(item.path), item.sha256, `RAW_ARTIFACT:${item.path}`);
  const reports = plan.cases.map(item => { const report = readJson(item.outputPath); requireReportBinding(report, item, planHash, plan.sourcePaths, hashFile); assert.equal(report.simulation, true); assert.equal(report.productionTraffic, false); return report; });
  function testExecution(execution, logicalCommand) {
    assert.equal(hashFile(execution.reportPath), execution.reportHash, "RAW_REPORT_HASH");
    assert.equal(execution.logicalCommand, logicalCommand); assert.equal(execution.result.exitCode, 0); assert.equal(execution.result.cwd, root);
    assert(quality.observations.some(row => JSON.stringify(row) === JSON.stringify(execution.result)), "COMMAND_NOT_RECORDED");
    const args = [npmCli, "run", "test", ...(logicalCommand === "npm run test" ? ["--"] : logicalCommand.split(" ").slice(3))];
    assert.deepEqual(execution.result.arguments.slice(0, args.length), args, "TEST_COMMAND_MISMATCH");
    const rows = requireVitest(readJson(execution.reportPath), { base: root });
    assert.deepEqual(execution.mappings, requireMappings(plan, rows)); return rows;
  }
  const fullRows = testExecution(quality.full, "npm run test"), dedicatedRows = testExecution(quality.dedicated, dedicatedCommand);
  assert.equal(quality.testCount, fullRows.length); assert.equal(quality.dedicatedCount, dedicatedRows.length);
  assert.equal(hashFile(quality.discovery.reportPath), quality.discovery.reportHash);
  const discovery = requireDiscovery(readJson(quality.discovery.reportPath), fullRows, root);
  requireDiscovery(readJson(plan.discoverySnapshot.path), fullRows, root);
  for (const [key,value] of Object.entries(discovery)) assert.equal(quality.discovery[key], value);
  const expectedDedicated = readJson(plan.discoverySnapshot.path).filter(row => /json-parser|schemas|context-manager|json-repair/.test(path.relative(root,row.file)));
  requireDiscovery(expectedDedicated, dedicatedRows, root);
  assert.deepEqual(quality.caseExecutions.map(row => row.testCaseId), caseIds);
  for (const [index, execution] of quality.caseExecutions.entries()) {
    requireCaseExecution(plan.cases[index], execution, npmCli); assert.equal(hashFile(execution.reportPath), execution.reportHash);
    assert.deepEqual(reports[index].details.actualExecution, execution); assert.deepEqual(reports[index].details.assertionMapping, quality.dedicated.mappings[index]);
  }
  const negatives = quality.negativeControls;
  assert.deepEqual(negatives.rows.map(row => row.id), negativeDefinitions.map(row => row.id)); assert.equal(negatives.sourceUnchanged, true);
  for (const [index,row] of negatives.rows.entries()) {
    const definition = negativeDefinitions[index], mutation = readJson(row.receiptPath);
    assert.equal(hashFile(row.receiptPath), row.receiptHash); assert.equal(hashFile(row.reportPath), row.reportHash);
    assert.equal(row.testSourceHash, hashFile(definition.testFile)); assert.deepEqual(row.failureEvidence, requireNegative(readJson(row.reportPath), definition, row.cwd));
    assert.deepEqual(row.changes, [{ sourcePath: definition.file, originalHash: hashFile(definition.file), mutatedHash: digest(Buffer.from(mutate(row.id, readBytes(definition.file).toString()))) }]);
    assert.deepEqual(row.changes, mutation.changes); assert.equal(mutation.testSourceHash, row.testSourceHash); assert.equal(mutation.cwd, row.cwd);
    assert.deepEqual(Object.keys(mutation.fixtureHashes).sort(), [...plan.fixtureSourcePaths].sort(), "INCOMPLETE_MUTATION_SOURCES");
    for (const [file, expected] of Object.entries(mutation.fixtureHashes)) assert.equal(expected, file === definition.file ? row.changes[0].mutatedHash : hashFile(file));
    assert.equal(row.result.exitCode, 1); assert.equal(row.result.cwd, row.cwd); assert.equal(row.originalCase, definition.caseId);
    assert.deepEqual(row.result.arguments.slice(0, 6), [npmCli, "run", "test", "--", definition.testFile, "-t"]);
  }
  const restored = testExecution(negatives.restored, dedicatedCommand); requireDiscovery(expectedDedicated, restored, root);
  requireSupportingResults(plan, quality, npmCli);
  for (const row of quality.supportingResults) {
    assert.equal(row.status, "PASS"); assert(row.details);
    const result = row.details.result;
    if (result) { assert.equal(result.exitCode, 0); assert(quality.observations.some(record => JSON.stringify(record) === JSON.stringify(result)), "SUPPORTING_NOT_EXECUTED"); }
    if (row.details.reportPath) assert.equal(hashFile(row.details.reportPath), row.details.reportHash);
  }
  for (const [index, result] of quality.observations.entries()) {
    assert.deepEqual(readJson(`${directory}/commands/${String(index + 1).padStart(3,"0")}.json`), result);
    assert.equal(result.timedOut, false); assert(Number.isFinite(result.durationMs) && result.durationMs >= 0);
    assert(result.exitCode === 0 || negatives.rows.some(row => row.result.exitCode === 1 && JSON.stringify(row.result) === JSON.stringify(result)), "UNEXPLAINED_COMMAND_FAILURE");
  }
  const guards = readJson(`${directory}/evidence-guards.json`);
  assert.equal(guards.status, "PASS"); assert.equal(guards.caseCount, guards.results.length); assert(guards.caseCount >= 20 && guards.results.every(row => row.status === "PASS"));
  requireHashCoverage(guards.testedSourceHashes, guardPaths, hashFile, "GUARD_SOURCE");
  assert.equal(quality.database.appliedMigrations, 10); assert.equal(quality.database.runtimeOwner, false); assert.equal(quality.database.runtimeSuperuser, false);
  assert.equal(quality.schemaHash, hashFile("prisma/schema.prisma")); assert.equal(quality.fixtureHash, hashFile("tests/phase017/fixtures.json")); assert.equal(quality.promptVersionHash, hashFile("src/lib/ai/prompt-contract.json"));
  assert.equal(quality.database.rawOutputNonNull, 0); assert.equal(quality.database.formalPlanTables, 0);
  assert.equal(quality.scan.hits, 0); assert.equal(quality.database.auditRowsMalformed, 0);
  let review = null;
  if (withReview) {
    review = readJson(`${directory}/review.json`); assert.equal(review.phase, 17); assert.equal(review.attemptId, plan.attemptId); assert.equal(review.planPath, planPath); assert.equal(review.planHash, planHash); assert.equal(review.decision, "PASS");
    requireReviewIdentity(review, plan.implementationContextId);
    requireHashCoverage(review.sourceHashes, plan.sourcePaths, hashFile, "REVIEW_SOURCE"); requireHashCoverage(review.reportHashes, plan.cases.map(row => row.outputPath), hashFile, "REVIEW_REPORT"); requireHashCoverage(review.supplementalReportHashes, [qualityPath], hashFile, "REVIEW_QUALITY");
    assert(Array.isArray(review.issues) && Array.isArray(review.dispositions));
    assert(review.issues.every(issue => review.dispositions.some(row => row.issueId === issue.id && row.status === "RESOLVED")), "UNRESOLVED_REVIEW_ISSUE");
  }
  return { receipt, reports, quality, review };
}
