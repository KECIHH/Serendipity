import assert from "node:assert/strict";
import path from "node:path";
import { requireHashCoverage, requireReportBinding, requireReviewIdentity } from "../../scripts/phase-evidence.mjs";
import { requireDiscovery, requireVitest } from "./phase018-evidence.mjs";

export { requireDiscovery, requireVitest };
export const startCommit = "583106823c6a1978da86f1b1ca0733b3492f4e15";
export const planPath = "docs/phase-plans/Phase022.json";
export const receiptPath = "docs/phase-plans/Phase022-inputs.json";
export const dedicatedArgs = ["planner"];
export const dedicatedFiles = ["src/server/services/planner-service.test.ts"];
export const dedicatedCommand = "npm run test -- planner";
export const ids = ["unit", "integration", "reverse-destinations", "reverse-conflict", "reverse-schema", "negative-controls"].map((id) => `Phase022:${id}`);
export const businessDenominators = [1, 1, 2, 1, 1];
export const negatives = [
  {
    id: "empty-destination-removal",
    file: "src/server/services/planner-service.ts",
    test: "src/server/services/planner-service.test.ts",
    pattern: "反向：空目的地拒绝且不生成默认值",
    witness: "EMPTY_DESTINATIONS_REJECTED",
    from: 'if (snapshot.destinations.length === 0) fail("VALIDATION_ERROR", "EMPTY_DESTINATIONS");',
    to: 'if (snapshot.destinations.length < 0) fail("VALIDATION_ERROR", "EMPTY_DESTINATIONS");',
  },
  {
    id: "folded-destination-removal",
    file: "src/server/services/planner-service.ts",
    test: "src/server/services/planner-service.test.ts",
    pattern: "反向：多目的地折叠成字符串时拒绝",
    witness: "FOLDED_DESTINATION_REJECTED",
    from: 'if (typeof rawDestinations === "string") fail("VALIDATION_ERROR", "FOLDED_DESTINATION");',
    to: 'if (typeof rawDestinations === "number") fail("VALIDATION_ERROR", "FOLDED_DESTINATION");',
  },
  {
    id: "conflicting-preference-removal",
    file: "src/server/services/planner-service.ts",
    test: "src/server/services/planner-service.test.ts",
    pattern: "反向：与需求冲突的偏好不得进入概要",
    witness: "CONFLICTING_PREFERENCE_REJECTED",
    from: `if (conflicts(summaryText, snapshot, durationDays, pace))
    fail("VALIDATION_ERROR", "CONFLICTING_PREFERENCE");`,
    to: `if (false && conflicts(summaryText, snapshot, durationDays, pace))
    fail("VALIDATION_ERROR", "CONFLICTING_PREFERENCE");`,
  },
  {
    id: "summary-schema-removal",
    file: "src/server/services/planner-service.ts",
    test: "src/server/services/planner-service.test.ts",
    pattern: "反向：删除草稿必需字段时校验失败",
    witness: "SUMMARY_SCHEMA_REQUIRED",
    from: "return TravelPlanSummaryDraftSchema.parse(summary);",
    to: "return summary;",
  },
];
export function mutate(definition, original) {
  const at = original.indexOf(definition.from);
  assert(at >= 0, "MISSING_MUTATION_ANCHOR");
  assert.equal(original.indexOf(definition.from, at + definition.from.length), -1, "AMBIGUOUS_MUTATION");
  return original.slice(0, at) + definition.to + original.slice(at + definition.from.length);
}
export function checkNegative(raw, definition, base) {
  const rows = requireVitest(raw, { expectedFailure: true, allowFiltered: true, base });
  const failures = rows.filter((row) => row.status === "failed");
  assert.equal(failures.length, 1, "NEGATIVE_FAILURE_COUNT");
  const row = failures[0];
  assert.equal(row.file, definition.test);
  assert.equal(row.title, definition.pattern);
  assert(row.failureMessages.join("\n").includes(definition.witness), "NEGATIVE_WRONG_FAILURE");
  return { file: row.file, fullName: row.fullName, witness: definition.witness };
}
export function requireInputs(receipt, { hash, git, json }) {
  assert.equal(receipt.phase, 22);
  assert.equal(receipt.phaseStartCommit, startCommit);
  assert.equal(receipt.requestedThrough, 22);
  const previous = JSON.parse(git(["show", `${startCommit}:docs/phase-plans/Phase021-inputs.json`]));
  const state = JSON.parse(git(["show", `${startCommit}:docs/roadmap-run.json`]));
  assert.equal(state.completedThrough, 21);
  assert.equal(state.currentPhase, 22);
  for (const key of ["baselineCommit", "executionBaselineCommit", "manifestHash", "pinnedInputs", "checkpointMigration", "checkpointMaintenance", "validationPolicy", "executionMaintenance", "executionPolicy"])
    assert.deepEqual(receipt[key], previous[key], `INPUT_CHAIN:${key}`);
  for (const item of [receipt.checkpointMigration, receipt.checkpointMaintenance, receipt.validationPolicy, receipt.executionMaintenance, receipt.executionPolicy])
    assert.equal(hash(item.path), item.sha256, `INPUT_HASH:${item.path}`);
  const checkpoint = state.checkpoints.at(-1);
  assert.deepEqual(receipt.prerequisites, { ...checkpoint, metadataCommit: startCommit });
  assert.equal(git(["rev-parse", `${startCommit}^`]).trim(), checkpoint.artifactCommit, "PREVIOUS_PARENT");
  assert.equal(hash(checkpoint.evidencePath), checkpoint.evidenceHash);
  assert.equal(json(checkpoint.evidencePath).status, "PASS");
}
export function requirePlan(plan, { hash, json }) {
  assert.equal(plan.phase, 22);
  assert.deepEqual(plan.requiredCaseIds, ids);
  assert.deepEqual(plan.cases.map((row) => row.testCaseId), ids);
  assert.deepEqual(plan.cases.map((row) => row.denominator), [...businessDenominators, negatives.length]);
  assert.equal(plan.testMode, "full");
  assert.equal(plan.crossAttemptReuse, "disabled");
  assert.equal(plan.phaseStartCommit, startCommit);
  assert.equal(new Set(plan.sourcePaths).size, plan.sourcePaths.length);
  assert.equal(hash(plan.discoverySnapshot.path), plan.discoverySnapshot.sha256);
  assert.equal(json(plan.discoverySnapshot.path).length, plan.discoverySnapshot.discovered);
  for (const id of ids.slice(0, businessDenominators.length))
    assert(plan.assertionBindings[id]?.length >= plan.cases.find((row) => row.testCaseId === id).denominator, "MISSING_CASE_BINDING");
}
export function requireExecution(execution, context, options = {}) {
  const { hash, json, npmCli, root } = context;
  assert.equal(hash(execution.reportPath), execution.reportHash, "RAW_REPORT_HASH");
  assert.equal(execution.result.exitCode, 0);
  assert.equal(execution.result.timedOut, false);
  assert.equal(execution.result.cwd, root);
  assert.equal(path.resolve(execution.result.executable), path.resolve(process.execPath));
  const selectors = execution.logicalCommand === "npm run test" ? [] : dedicatedArgs;
  assert.equal(execution.logicalCommand, selectors.length ? dedicatedCommand : "npm run test");
  assert.deepEqual(execution.result.arguments, [npmCli, "run", "test", "--", ...selectors, "--reporter=json", `--outputFile=${execution.scratchPath}`], "EXECUTION_COMMAND");
  const rows = requireVitest(json(execution.reportPath), { base: root });
  if (options.discovery) requireDiscovery(options.discovery, rows, root);
  return rows;
}
export function audit(plan, context, withReview = true) {
  const { directory, hash, json } = context;
  requirePlan(plan, context);
  const receipt = json(receiptPath);
  requireInputs(receipt, context);
  const planHash = hash(planPath);
  assert.equal(hash(`${directory}/frozen-plan.json`), planHash);
  requireHashCoverage(json(`${directory}/source-basis.json`).sourceHashes, plan.sourcePaths, hash, "SOURCE_BASIS");
  const quality = json(`${directory}/quality.json`);
  assert.equal(quality.planHash, planHash);
  assert.equal(quality.status, "PASS");
  requireHashCoverage(quality.sourceHashes, plan.sourcePaths, hash, "QUALITY_SOURCE");
  for (const file of quality.artifacts) assert.equal(hash(file.path), file.sha256, "ARTIFACT_HASH");
  const discovery = json(plan.discoverySnapshot.path);
  const full = requireExecution(quality.full, context, { discovery });
  const selected = discovery.filter((row) => dedicatedFiles.includes(path.relative(context.root, row.file).replaceAll("\\", "/")));
  const restored = requireExecution(quality.restored, context, { discovery: selected });
  requireExecution(quality.dedicated, context, { discovery: selected });
  assert.equal(quality.testCount, full.length);
  assert.equal(quality.dedicatedCount, restored.length);
  assert.deepEqual(quality.negative.rows.map((row) => row.id), negatives.map((row) => row.id));
  for (const [index, row] of quality.negative.rows.entries()) {
    const definition = negatives[index];
    assert.equal(row.result.exitCode, 1);
    assert.equal(row.result.timedOut, false);
    assert.equal(hash(row.reportPath), row.reportHash);
    assert.deepEqual(checkNegative(json(row.reportPath), definition, row.result.cwd), row.failure);
    assert.equal(row.originalHash, hash(definition.file));
    assert.equal(row.mutatedHash, context.sha(Buffer.from(mutate(definition, context.read(definition.file).toString()))));
    assert.equal(row.testHash, hash(definition.test));
  }
  const reports = plan.cases.map((item, index) => {
    const report = json(item.outputPath);
    requireReportBinding(report, item, planHash, plan.sourcePaths, hash);
    if (index < businessDenominators.length) {
      const mapped = restored.filter((row) => plan.assertionBindings[item.testCaseId].some((binding) => binding.file === row.file && binding.fullName === row.fullName));
      assert.equal(mapped.length, plan.assertionBindings[item.testCaseId].length, "MISSING_ASSERTION");
      assert.deepEqual(report.details.assertions, mapped.map(({ file, fullName }) => ({ file, fullName })));
      assert.equal(report.details.rawReportPath, quality.restored.reportPath);
    } else assert.deepEqual(report.details.controls, quality.negative.rows);
    return report;
  });
  let review = null;
  if (withReview) {
    review = json(`${directory}/review.json`);
    assert.equal(review.phase, 22);
    assert.equal(review.attemptId, plan.attemptId);
    assert.equal(review.planPath, planPath);
    assert.equal(review.planHash, planHash);
    assert.equal(review.decision, "PASS");
    requireReviewIdentity(review, plan.implementationContextId);
    requireHashCoverage(review.sourceHashes, plan.sourcePaths, hash, "REVIEW_SOURCE");
    requireHashCoverage(review.reportHashes, plan.cases.map((row) => row.outputPath), hash, "REVIEW_REPORT");
    assert(review.issues.every((issue) => review.dispositions.some((item) => item.issueId === issue.id && item.status === "RESOLVED")), "OPEN_REVIEW_ISSUE");
  }
  return { receipt, quality, reports, review };
}
