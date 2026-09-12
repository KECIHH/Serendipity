import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  requireHashCoverage,
  requireReportBinding,
  requireReviewIdentity,
} from "../../scripts/phase-evidence.mjs";
import {
  executionPaths,
  requireInputs,
  requirePlan,
  requireVitest,
  requireMappings,
  requireDiscovery,
  requireNegative,
  negativeDefinitions,
  mutate,
  requireBrowser,
  requireBusiness,
} from "./phase014-evidence.mjs";
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
  inventory,
  scanSensitiveText,
} from "./phase014-runtime.mjs";

const reviewPath = `${directory}/review.json`,
  qualityPath = `${directory}/quality.json`,
  gatePath = "docs/evidence/Phase014-gate.json";
const dependencies = { readJson: json, readBytes: read, hashFile: hash, git };
function audit(withReview = true) {
  assert(!fs.existsSync(path.join(root, directory, "attempt.json")), "FAILED_ATTEMPT_CANNOT_SEAL");
  requirePlan(plan, dependencies);
  const receipt = json(receiptPath);
  requireInputs(receipt, dependencies);
  const planHash = hash(planPath);
  assert.equal(hash(`${directory}/frozen-plan.json`), planHash);
  const reports = plan.cases.map((item) => {
    const report = json(item.outputPath);
    requireReportBinding(report, item, planHash, plan.sourcePaths, hash);
    assert.equal(report.simulation, true);
    assert.equal(report.productionTraffic, false);
    for (const artifact of report.details.artifacts)
      assert.equal(hash(artifact.path), artifact.sha256);
    return report;
  });
  const quality = json(qualityPath);
  for (const [field, value] of Object.entries({
    phase: 14,
    attemptId: plan.attemptId,
    planHash,
    status: "PASS",
    simulation: true,
    productionTraffic: false,
    testMode: "full",
    crossAttemptReuse: "disabled",
  }))
    assert.equal(quality[field], value);
  requireHashCoverage(quality.sourceHashes, plan.sourcePaths, hash, "QUALITY_SOURCE_HASH");
  for (const artifact of quality.artifacts) assert.equal(hash(artifact.path), artifact.sha256);
  requireHashCoverage(
    quality.executionDependencyHashes,
    executionPaths(json("package.json")),
    hash,
    "EXECUTION_DEPENDENCY_HASH",
  );
  assert.deepEqual(quality.supportingChecks, plan.supportingChecks);
  assert.deepEqual(
    quality.supportingResults.map((row) => row.checkId),
    plan.supportingChecks,
  );
  assert(quality.supportingResults.every((row) => row.status === "PASS" && row.details));
  const fullRows = requireVitest(json(quality.full.reportPath), { base: root });
  const dedicatedRows = requireVitest(json(quality.dedicated.reportPath), { base: root });
  assert.equal(quality.testCount, fullRows.length);
  assert.equal(quality.dedicatedCount, dedicatedRows.length);
  const mappings = requireMappings(plan, fullRows),
    dedicatedMappings = requireMappings(plan, dedicatedRows);
  assert.deepEqual(quality.full.mappings, mappings);
  assert.deepEqual(quality.dedicated.mappings, dedicatedMappings);
  const discovery = requireDiscovery(json(quality.discovery.reportPath), fullRows, root);
  for (const [field, value] of Object.entries(discovery))
    assert.deepEqual(quality.discovery[field], value);
  assert.equal(quality.businessObservationHash, hash(quality.businessObservationPath));
  const measured = read(quality.businessObservationPath)
    .toString()
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.deepEqual(quality.businessObservations, requireBusiness(measured));
  for (const [index, report] of reports.entries()) {
    assert.deepEqual(report.details.assertionMapping, mappings[index]);
    assert.deepEqual(report.details.dedicatedAssertionMapping, dedicatedMappings[index]);
    assert.equal(report.details.fullReportPath, quality.full.reportPath);
    assert.equal(report.details.businessObservationPath, quality.businessObservationPath);
    assert.equal(report.details.browserReportPath, quality.browser.reportPath);
  }
  assert.deepEqual(
    quality.negativeControls.rows.map((row) => row.id),
    plan.negativeControls,
  );
  assert.equal(quality.negativeControls.sourceUnchanged, true);
  for (const [index, row] of quality.negativeControls.rows.entries()) {
    const definition = negativeDefinitions[index],
      receipt = json(`${directory}/mutations/${row.id}.json`);
    const failure = requireNegative(json(row.reportPath), definition, row.cwd, (file) =>
      read(file).toString(),
    );
    assert.deepEqual(row.failureEvidence, failure);
    assert.equal(row.originalCase, definition.caseId);
    assert.equal(row.testSourceHash, hash(definition.testFile));
    assert.equal(receipt.testSourceHash, row.testSourceHash);
    assert.deepEqual(row.changes, receipt.changes);
    assert.deepEqual(row.changes, [
      {
        sourcePath: definition.file,
        originalHash: hash(definition.file),
        mutatedHash: sha(mutate(definition.id, read(definition.file).toString())),
      },
    ]);
    assert.equal(row.result.exitCode, 1);
    assert(
      quality.observations.some(
        (command) =>
          JSON.stringify(command.arguments) === JSON.stringify(row.result.arguments) &&
          command.cwd === row.cwd &&
          command.exitCode === 1,
      ),
    );
  }
  for (const result of quality.observations)
    assert(
      !result.timedOut &&
        (result.exitCode === 0 ||
          quality.negativeControls.rows.some(
            (row) =>
              row.result.command === result.command &&
              row.cwd === result.cwd &&
              result.exitCode === 1,
          )),
      "UNEXPLAINED_COMMAND_FAILURE",
    );
  for (const result of [quality.full.result, quality.dedicated.result, quality.browser.result]) {
    assert.equal(result.exitCode, 0);
    assert(
      quality.observations.some(
        (row) =>
          row.command === result.command &&
          row.durationMs === result.durationMs &&
          row.exitCode === 0,
      ),
    );
  }
  const browser = json(quality.browser.reportPath);
  assert.equal(hash(quality.browser.reportPath), quality.browser.reportHash);
  const summary = requireBrowser(browser);
  for (const [field, value] of Object.entries(summary)) assert.equal(quality.browser[field], value);
  for (const artifact of browser.artifacts) assert.equal(hash(artifact.path), artifact.sha256);
  const guards = json(`${directory}/evidence-guards.json`),
    validator = json(`${directory}/validator-regression.json`);
  assert.equal(guards.status, "PASS");
  assert(guards.caseCount > 0);
  assert(guards.results.every((row) => row.status === "PASS"));
  requireHashCoverage(
    guards.testedSourceHashes,
    [
      "docs/phase-plans/phase014-evidence.mjs",
      "docs/phase-plans/phase014-runtime.mjs",
      "scripts/phase-evidence.mjs",
      "tests/phase014/evidence-guards.mjs",
    ],
    hash,
    "GUARD_SOURCE_HASH",
  );
  assert.equal(validator.status, "PASS");
  assert.equal(validator.shells.length, 2);
  assert.equal(quality.database.appliedMigrations, 8);
  assert.equal(quality.database.previousMigrationsPreserved, 8);
  assert.equal(quality.database.runtimeOwner, false);
  assert.equal(quality.database.runtimeSuperuser, false);
  assert.equal(quality.registryHash, hash("src/server/config/config-registry.ts"));
  assert.equal(quality.schemaHash, hash("prisma/schema.prisma"));
  assert.equal(quality.apiHash, hash("docs/api.md"));
  assert.equal(quality.scan.hits, 0);
  const review = withReview ? json(reviewPath) : null;
  if (review) {
    for (const [field, value] of Object.entries({
      phase: 14,
      attemptId: plan.attemptId,
      planPath,
      planHash,
      decision: "PASS",
    }))
      assert.equal(review[field], value);
    requireReviewIdentity(review, plan.implementationContextId);
    requireHashCoverage(review.sourceHashes, plan.sourcePaths, hash, "REVIEW_SOURCE_HASH");
    requireHashCoverage(
      review.reportHashes,
      plan.cases.map((item) => item.outputPath),
      hash,
      "REVIEW_REPORT_HASH",
    );
    requireHashCoverage(
      review.supplementalReportHashes,
      [qualityPath],
      hash,
      "REVIEW_QUALITY_HASH",
    );
    assert(Array.isArray(review.issues) && Array.isArray(review.dispositions));
    for (const issue of review.issues)
      assert(
        issue.status === "RESOLVED" ||
          review.dispositions.some(
            (item) => item.issueId === issue.id && item.status === "RESOLVED",
          ),
      );
  }
  return { reports, quality, review, receipt };
}
function retry() {
  const failurePath = `${directory}/attempt.json`;
  assert(fs.existsSync(path.join(root, failurePath)));
  assert.equal(hash(`${directory}/frozen-plan.json`), hash(planPath));
  const failure = json(failurePath);
  assert.equal(failure.planHash, hash(planPath));
  const next = structuredClone(plan),
    nextNumber = Number(plan.attemptId.split("-")[1]) + 1;
  assert(Number.isInteger(nextNumber));
  next.attemptId = `attempt-${nextNumber}`;
  next.previousAttempts.push({
    attemptId: plan.attemptId,
    planPath: `${directory}/frozen-plan.json`,
    planHash: hash(planPath),
    failurePath,
    failureHash: hash(failurePath),
  });
  for (const item of next.cases)
    item.outputPath = item.outputPath.replace(`/${plan.attemptId}/`, `/${next.attemptId}/`);
  requirePlan(next, dependencies);
  write(`docs/evidence/attempts/Phase014/${next.attemptId}/frozen-plan.json`, next);
  write(planPath, next, false);
  console.log(
    JSON.stringify({
      status: "RETRY_FROZEN",
      attemptId: next.attemptId,
      crossAttemptReuse: "disabled",
    }),
  );
}
function metadata() {
  const { reports, quality, review, receipt } = audit();
  assert.equal(git(["status", "--porcelain=v1"]).trim(), "", "Commit the artifact first");
  assert.equal(git(["show", "-s", "--format=%s", "HEAD"]).trim(), "phase(014): artifact");
  assert(!fs.existsSync(path.join(root, gatePath)), "SEALED_GATE_IMMUTABLE");
  const artifactCommit = git(["rev-parse", "HEAD"]).trim(),
    testedTree = git(["rev-parse", "HEAD^{tree}"]).trim();
  const state = json("docs/roadmap-run.json");
  assert.equal(state.completedThrough, 13);
  assert.equal(state.currentPhase, 14);
  assert.equal(state.manifestHash, receipt.manifestHash);
  const files = [
    ...new Set([...plan.sourcePaths, ...inventory("docs/evidence/attempts/Phase014")]),
  ].sort();
  const inputs = files.map((file) => {
    const sha256 = hash(file);
    assert.equal(
      sha(git(["show", `${artifactCommit}:${file}`], null)),
      sha256,
      `UNCOMMITTED_EVIDENCE_BYTES:${file}`,
    );
    return { path: file, sha256 };
  });
  const intermediate = git([
    "rev-list",
    "--reverse",
    `${receipt.phaseStartCommit}..${artifactCommit}`,
  ])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  assert.equal(intermediate.at(-1), artifactCommit);
  const results = plan.cases.map((item, index) => ({
    testCaseId: item.testCaseId,
    command: item.command,
    exitCode: reports[index].exitCode,
    numerator: reports[index].numerator,
    denominator: item.denominator,
    inputHash: `sha256:${hash(item.inputPath)}`,
    outputHash: `sha256:${hash(item.outputPath)}`,
    status: "PASS",
    details: { inputPath: item.inputPath, outputPath: item.outputPath, expected: item.expected },
  }));
  const gate = {
    schemaVersion: "agent-gate-v1",
    phase: 14,
    attemptId: plan.attemptId,
    status: "PASS",
    simulation: true,
    operatorMode: "AGENT_ONLY_AUTOMATED_NEW_BUILD",
    environment: {
      isolated: true,
      syntheticUsers: true,
      providerMode: "local-adapter",
      productionTraffic: false,
    },
    artifactCommit,
    requiredCaseIds: plan.requiredCaseIds,
    results,
    commands: results.map(({ command, exitCode }) => ({ command, exitCode })),
    inputs,
    failures: [],
    generatedAt: new Date().toISOString(),
    details: {
      planPath,
      planHash: hash(planPath),
      testedTree,
      reviewerRunId: review.reviewerRunId,
      reviewReportPath: reviewPath,
      reviewReportHash: hash(reviewPath),
      recoveryCommits: intermediate.slice(0, -1),
      originalThreshold: 5,
      automatedThreshold: 5,
      waived: false,
      requestedThrough: 14,
      nextPhaseExecutionAuthorized: false,
      milestone: "M3",
      qualityReportPath: qualityPath,
      qualityReportHash: hash(qualityPath),
      manifestHash: receipt.manifestHash,
      schemaPath: "prisma/schema.prisma",
      schemaHash: hash("prisma/schema.prisma"),
      apiContractPath: "docs/api.md",
      apiContractHash: hash("docs/api.md"),
      configRegistryPath: "src/server/config/config-registry.ts",
      configRegistryHash: quality.registryHash,
      runtimeBaselinePath: "docs/runtime-baseline.json",
      runtimeBaselineHash: hash("docs/runtime-baseline.json"),
      testMode: "full",
      crossAttemptReuse: "disabled",
      validationPolicy: receipt.validationPolicy,
      checkpointMaintenance: receipt.checkpointMaintenance,
      executionPolicy: receipt.executionPolicy,
      executionMaintenance: receipt.executionMaintenance,
      database: quality.database,
      businessObservationPath: quality.businessObservationPath,
      businessObservationHash: quality.businessObservationHash,
      businessObservations: quality.businessObservations,
      pages: ["/admin", "/admin/users", "/admin/api-keys", "/admin/logs", "/admin/settings"],
      routes: [
        "GET /api/admin/settings",
        "PATCH /api/admin/settings/{key}",
        "GET /api/admin/dashboard/stats",
        "GET /api/config/public",
      ],
      widgetFixturePath: "tests/admin/dashboard.test.ts",
      widgetFixtureHash: hash("tests/admin/dashboard.test.ts"),
      actualCommandExitCodes: quality.observations.map(({ command, exitCode, timedOut }) => ({
        command,
        exitCode,
        timedOut,
      })),
      browser: quality.browser,
      secretScan: quality.scan,
      costAccounting: quality.costAccounting,
      notEvaluated: plan.notApplicable,
    },
  };
  scanSensitiveText(JSON.stringify(gate), "final Gate before archival");
  write(gatePath, gate);
  const checkpoint = {
    phase: 14,
    artifactCommit,
    evidencePath: gatePath,
    evidenceHash: hash(gatePath),
  };
  state.completedThrough = 14;
  state.currentPhase = 15;
  state.nextPhaseExecutionAuthorized = false;
  state.lastArtifactCommit = artifactCommit;
  state.currentLayoutPhaseSeal = checkpoint;
  state.checkpoints.push(checkpoint);
  write("docs/roadmap-run.json", state, false);
  const log = read("docs/phase-completion-log.md").toString().trimEnd();
  assert(!log.includes("| Phase014 |"));
  write(
    "docs/phase-completion-log.md",
    `${log}\n| Phase014 | SystemConfig、Dashboard 与 M3 | registry五组、CAS/幂等原子审计、双白名单公开投影、独立widget与五页共用组件；完整路径/hash见Gate | 固定5/5；Vitest ${quality.testCount}/${quality.testCount}；四反向控制；PostgreSQL17；真实浏览器${quality.browser.caseCount}场景；lint/typecheck/format/build/layout/validator通过；独立Agent复核；artifactCommit=${artifactCommit}；attemptId=${plan.attemptId} | 无生产流量、真实身份或AI治理；未执行Phase015 | metadata后双shell seal、clean和GitHub同步；授权止于014 |\n\nPhase014 计划：${planPath}；唯一 Gate：${gatePath}；原始报告与独立复核：docs/evidence/attempts/Phase014/。\n`,
    false,
  );
  console.log(
    JSON.stringify({
      status: "METADATA_CANDIDATE_CREATED",
      artifactCommit,
      evidenceHash: checkpoint.evidenceHash,
      nextPhaseExecutionAuthorized: false,
    }),
  );
}
try {
  if (process.argv.includes("--retry")) retry();
  else if (process.argv.includes("--metadata")) metadata();
  else {
    const result = audit(!process.argv.includes("--without-review"));
    console.log(
      JSON.stringify({
        status: "PASS",
        reports: result.reports.length,
        independentReview: !!result.review,
      }),
    );
  }
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
}
