import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  requireHashCoverage,
  requireReportBinding,
  requireReviewIdentity,
} from "../../scripts/phase-evidence.mjs";
import { validatePhase016Recovery, phase016RecoveredCommits } from "../../scripts/phase016-recovery.mjs";
import {
  requireInputs,
  requirePlan,
  requireNegative,
  negativeDefinitions,
  requireVitest,
  requireMappings,
  requireDiscovery,
  mutate,
  executionPaths,
  requireCaseExecution,
  requireSealRecovery,
} from "./phase016-evidence.mjs";
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
  npmCli,
  write,
  git,
  scanSensitiveText,
} from "./phase016-runtime.mjs";

const reviewPath = `${directory}/review.json`;
const qualityPath = `${directory}/quality.json`;
const gatePath = "docs/evidence/Phase016-gate.json";
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
    phase: 16,
    attemptId: plan.attemptId,
    planHash,
    status: "PASS",
    simulation: true,
    productionTraffic: false,
    testMode: "full",
    crossAttemptReuse: "disabled",
  }))
    assert.equal(quality[field], value);
  assert.deepEqual(Object.keys(quality.sourceHashes).sort(), [...plan.sourcePaths].sort());
  for (const [file, expected] of Object.entries(quality.sourceHashes))
    assert.equal(hash(file), expected, `QUALITY_SOURCE:${file}`);
  for (const artifact of quality.artifacts) assert.equal(hash(artifact.path), artifact.sha256);
  requireHashCoverage(
    quality.executionDependencyHashes,
    executionPaths(json("package.json")),
    hash,
    "EXECUTION_DEPENDENCIES",
  );
  const fullRows = requireVitest(json(quality.full.reportPath), { base: root });
  const dedicatedRows = requireVitest(json(quality.dedicated.reportPath), { base: root });
  assert.equal(hash(quality.full.reportPath), quality.full.reportHash);
  assert.equal(hash(quality.dedicated.reportPath), quality.dedicated.reportHash);
  assert.equal(quality.testCount, fullRows.length);
  assert.equal(quality.dedicatedCount, dedicatedRows.length);
  const mappings = requireMappings(plan, fullRows),
    dedicatedMappings = requireMappings(plan, dedicatedRows);
  assert.deepEqual(quality.full.mappings, mappings);
  assert.deepEqual(quality.dedicated.mappings, dedicatedMappings);
  const discovery = requireDiscovery(json(quality.discovery.reportPath), fullRows, root);
  assert.equal(hash(quality.discovery.reportPath), quality.discovery.reportHash);
  for (const [field, value] of Object.entries(discovery))
    assert.equal(quality.discovery[field], value);
  assert.deepEqual(
    quality.caseExecutions.map((x) => x.testCaseId),
    plan.requiredCaseIds,
  );
  for (const [index, execution] of quality.caseExecutions.entries()) {
    const item = plan.cases[index];
    requireCaseExecution(item, execution, npmCli);
    assert.equal(execution.result.cwd, root);
    assert.equal(hash(execution.reportPath), execution.reportHash);
    if(item.testCaseId!=="Phase016:mutation")requireVitest(json(execution.reportPath), { base: root });
    assert.deepEqual(reports[index].details.actualExecution, execution);
    assert.deepEqual(reports[index].details.assertionMapping, mappings[index]);
    assert.deepEqual(reports[index].details.dedicatedAssertionMapping, dedicatedMappings[index]);
  }
  assert.deepEqual(quality.supportingChecks, plan.supportingChecks);
  assert.deepEqual(
    quality.supportingResults.map((row) => row.checkId),
    plan.supportingChecks,
  );
  assert(quality.supportingResults.every((row) => row.status === "PASS" && row.details));
  for(const row of quality.supportingResults){
    const detail=row.details;
    if(detail.result){assert.equal(detail.result.exitCode,0);assert(quality.observations.some(result=>JSON.stringify(result)===JSON.stringify(detail.result)),"UNEXECUTED_SUPPORTING_CHECK");}
    if(detail.reportPath){assert.equal(hash(detail.reportPath),detail.reportHash);}
    assert(!JSON.stringify(detail).includes('"n/a"'),"MISSING_SUPPORTING_EVIDENCE");
  }
  assert.equal(json(`${directory}/legacy-route-http.json`).requests,12);
  assert(json(`${directory}/legacy-route-http.json`).rows.every(row=>row.status===404));
  assert.deepEqual(json(`${directory}/import-boundary.json`).violations,[]);
  assert.deepEqual(
    quality.negativeControls.rows.map((row) => row.id),
    plan.negativeControls,
  );
  assert.equal(quality.negativeControls.sourceUnchanged, true);
  for (const [index, row] of quality.negativeControls.rows.entries()) {
    const definition = negativeDefinitions[index];
    assert.equal(row.receiptPath, `${directory}/negative-run/mutations/${row.id}.json`);
    const receipt = json(row.receiptPath);
    assert.equal(row.originalCase, definition.caseId);
    assert.equal(row.testSourceHash, hash(definition.testFile));
    assert.equal(receipt.testSourceHash, row.testSourceHash);
    assert.deepEqual(row.changes, receipt.changes);
    assert.equal(row.cwd, receipt.cwd);
    assert.equal(hash(row.receiptPath), row.receiptHash);
    assert.equal(hash(row.reportPath), row.reportHash);
    assert.deepEqual(
      row.failureEvidence,
      requireNegative(json(row.reportPath), definition, row.cwd),
    );
    assert.deepEqual(row.changes, [
      {
        sourcePath: definition.file,
        originalHash: hash(definition.file),
        mutatedHash: sha(Buffer.from(mutate(definition.id, read(definition.file).toString()))),
      },
    ]);
    for (const [file, expected] of Object.entries(receipt.fixtureHashes))
      assert.equal(
        expected,
        file === definition.file ? row.changes[0].mutatedHash : hash(file),
        `NEGATIVE_FIXTURE_HASH:${file}`,
      );
    assert.equal(row.result.exitCode, 1);
    assert.equal(row.result.cwd, row.cwd);
  }
  const restored = quality.negativeControls.restored;
  assert.equal(hash(restored.reportPath), restored.reportHash);
  assert.deepEqual(
    restored.mappings,
    requireMappings(plan, requireVitest(json(restored.reportPath), { base: root })),
  );
  assert.equal(quality.negativeControls.restore.exitCode, 0);
  const successfulCommands = [
    quality.full.result,
    quality.dedicated.result,
    restored.result,
    ...quality.caseExecutions.map((x) => x.result),
  ];
  for (const result of successfulCommands) {
    assert.equal(result.exitCode, 0);
    assert(
      quality.observations.some((x) => JSON.stringify(x) === JSON.stringify(result)),
      "MISSING_EXECUTED_COMMAND",
    );
  }
  for (const [index, observation] of quality.observations.entries()) {
    assert.equal(observation.timedOut, false);
    assert(Number.isFinite(observation.durationMs) && observation.durationMs >= 0);
    assert.deepEqual(
      json(`${directory}/commands/${String(index + 1).padStart(3, "0")}.json`),
      observation,
    );
    assert(
      observation.exitCode === 0 ||
        quality.negativeControls.rows.some(
          (x) =>
            JSON.stringify(x.result) === JSON.stringify(observation) && observation.exitCode === 1,
        ),
      "UNEXPLAINED_COMMAND_FAILURE",
    );
  }
  const guards = json(`${directory}/evidence-guards.json`),
    validator = json(`${directory}/validator-regression.json`);
  assert.equal(guards.status, "PASS");
  assert.equal(guards.caseCount, guards.results.length);
  assert(guards.caseCount >= 19 && guards.results.every((x) => x.status === "PASS"));
  requireHashCoverage(
    guards.testedSourceHashes,
    [
      "docs/phase-plans/phase016-evidence.mjs",
      "docs/phase-plans/phase016-runtime.mjs",
      "docs/phase-plans/verify-phase016.mjs",
      "docs/phase-plans/complete-phase016.mjs",
      "scripts/phase-evidence.mjs",
      "scripts/phase016-recovery.mjs",
      "tests/phase016/evidence-guards.mjs",
    ],
    hash,
    "GUARD_SOURCE_HASH",
  );
  assert.equal(validator.status, "PASS");
  assert.equal(validator.shells.length, 2);
  assert.equal(quality.database.appliedMigrations, 10);
  assert.equal(quality.database.previousMigrationsPreserved, 9);
  assert.equal(quality.database.runtimeOwner, false);
  assert.equal(quality.database.runtimeSuperuser, false);
  assert.equal(quality.schemaHash, hash("prisma/schema.prisma"));
  assert.equal(
    quality.migrationHash,
    hash("prisma/migrations/20260914165140_chat_command_events/migration.sql"),
  );
  let review = null;
  if (withReview) {
    review = json(reviewPath);
    assert.equal(review.phase, 16);
    assert.equal(review.attemptId, plan.attemptId);
    assert.equal(review.planPath, planPath);
    assert.equal(review.planHash, planHash);
    assert.equal(review.decision, "PASS");
    requireReviewIdentity(review, plan.implementationContextId);
    assert.deepEqual(Object.keys(review.sourceHashes).sort(), [...plan.sourcePaths].sort());
    for (const [file, expected] of Object.entries(review.sourceHashes))
      assert.equal(hash(file), expected, `REVIEW_SOURCE:${file}`);
    requireHashCoverage(
      review.reportHashes,
      plan.cases.map((x) => x.outputPath),
      hash,
      "REVIEW_REPORT_HASH",
    );
    requireHashCoverage(
      review.supplementalReportHashes,
      [qualityPath],
      hash,
      "REVIEW_QUALITY_HASH",
    );
    assert(Array.isArray(review.issues));
    assert(Array.isArray(review.dispositions));
    assert(
      review.issues.every((issue) =>
        review.dispositions.some(
          (disposition) =>
            disposition.issueId === issue.id &&
            ["RESOLVED", "NOT_BLOCKING"].includes(disposition.status),
        ),
      ),
    );
  }
  return { receipt, reports, quality, review };
}

function metadata() {
  const { receipt, reports, quality, review } = audit(true);
  const sealRecovery = requireSealRecovery(plan, dependencies);
  if (sealRecovery)
    for (const file of sealRecovery.metadataFiles)
      assert.equal(hash(file.path), file.sha256, `UNSEALED_METADATA_CHANGED:${file.path}`);
  assert(review, "INDEPENDENT_REVIEW_REQUIRED");
  const artifactCommit = git(["rev-parse", "HEAD"]).trim();
  assert.equal(
    git(["status", "--porcelain=v1", "--untracked-files=all"]).trim(),
    "",
    "ARTIFACT_MUST_BE_CLEAN",
  );
  assert.equal(git(["show","-s","--format=%s",artifactCommit]).trim(),"phase(016): artifact");
  const testedTree = git(["rev-parse", `${artifactCommit}^{tree}`]).trim();
  const recovery = git(["rev-list", "--reverse", `${receipt.phaseStartCommit}..${artifactCommit}`])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  recovery.pop();
  validatePhase016Recovery({plan,inputReceipt:receipt,recoveryBytes:read(plan.recoveryReceipt.path),
    recoveryCommits:recovery,git:args=>git(args,null)});
  assert.equal(git(["rev-parse",`${artifactCommit}^`]).trim(),recovery.at(-1)??receipt.phaseStartCommit,"ARTIFACT_PARENT");
  assert.deepEqual(recovery.slice(0,3),phase016RecoveredCommits);
  const inputPaths = [
    planPath,
    ...plan.sourcePaths,
    ...plan.cases.map((item) => item.outputPath),
    reviewPath,
    qualityPath,
    ...quality.artifacts.map((x) => x.path),
  ];
  const inputs = [...new Set(inputPaths)].map((file) => {
    assert.equal(
      sha(git(["show", `${artifactCommit}:${file}`], null)),
      hash(file),
      `ARTIFACT_BLOB:${file}`,
    );
    return { path: file, sha256: hash(file) };
  });
  const results = plan.cases.map((item) => {
    const report = reports.find((row) => row.testCaseId === item.testCaseId);
    return {
      testCaseId: item.testCaseId,
      command: item.command,
      exitCode: report.exitCode,
      numerator: report.numerator,
      denominator: report.denominator,
      inputHash: `sha256:${report.inputHash}`,
      outputHash: `sha256:${hash(item.outputPath)}`,
      status: "PASS",
      details: { inputPath: item.inputPath, outputPath: item.outputPath },
    };
  });
  const gate = {
    schemaVersion: "agent-gate-v1",
    phase: 16,
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
      recoveryCommits: recovery,
      ...(sealRecovery ? { sealRecovery } : {}),
      originalThreshold: 7,
      automatedThreshold: 7,
      waived: false,
      requestedThrough: 16,
      nextPhaseExecutionAuthorized: false,
      milestone: "M4_SESSION_FOUNDATION",
      qualityReportPath: qualityPath,
      qualityReportHash: hash(qualityPath),
      manifestHash: receipt.manifestHash,
      schemaPath: "prisma/schema.prisma",
      schemaHash: hash("prisma/schema.prisma"),
      migrationPath: "prisma/migrations/20260914165140_chat_command_events/migration.sql",
      migrationHash: hash("prisma/migrations/20260914165140_chat_command_events/migration.sql"),
      testMode: "full",
      crossAttemptReuse: "disabled",
      validationPolicy: receipt.validationPolicy,
      checkpointMaintenance: receipt.checkpointMaintenance,
      executionPolicy: receipt.executionPolicy,
      executionMaintenance: receipt.executionMaintenance,
      database: quality.database,
      actualCommandExitCodes: quality.observations.map(({ command, exitCode, timedOut }) => ({
        command,
        exitCode,
        timedOut,
      })),
      secretScan: quality.scan,
      costAccounting: quality.costAccounting,
      notEvaluated: plan.notApplicable,
    },
  };
  scanSensitiveText(JSON.stringify(gate), "final Gate before archival");
  write(gatePath, gate, !sealRecovery);
  const checkpoint = {
    phase: 16,
    artifactCommit,
    evidencePath: gatePath,
    evidenceHash: hash(gatePath),
  };
  const state = sealRecovery
    ? JSON.parse(git(["show", `${receipt.phaseStartCommit}:docs/roadmap-run.json`]))
    : json("docs/roadmap-run.json");
  assert.equal(state.completedThrough, 15);
  assert.equal(state.currentPhase, 16);
  state.completedThrough = 16;
  state.currentPhase = 17;
  state.nextPhaseExecutionAuthorized = false;
  state.lastArtifactCommit = artifactCommit;
  state.currentLayoutPhaseSeal = checkpoint;
  state.checkpoints.push(checkpoint);
  write("docs/roadmap-run.json", state, false);
  const log = (sealRecovery
    ? git(["show", `${receipt.phaseStartCommit}:docs/phase-completion-log.md`])
    : read("docs/phase-completion-log.md").toString()).trimEnd();
  assert(!log.includes("| Phase016 |"));
  write(
    "docs/phase-completion-log.md",
    `${log}\n| Phase016 | 会话命令、持久事件与 SSE 基础 | ChatCommand/ChatCommandEvent/CommandIdempotency 模型、DurableTask/Outbox worker、owner resolver、事务原语、guarded client 集成、SSE 重放、取消竞态与 7 组 fixture；完整路径/hash 见 Gate | 固定 7/7；Vitest ${quality.testCount}/${quality.testCount}；专用${quality.dedicatedCount}断言；${quality.negativeControls.rows.length}项反向控制及恢复后全卡重跑；PostgreSQL 17；lint/typecheck/format/build/layout 通过；独立 Agent 复核；artifactCommit=${artifactCommit}；attemptId=${plan.attemptId} | 无生产流量、真实凭据、真实Provider调用或规划UI；未执行Phase017 | metadata后双shell seal、clean和GitHub同步；授权止于016 |\n\nPhase016 计划：${planPath}；唯一 Gate：${gatePath}；原始报告与独立复核：docs/evidence/attempts/Phase016/。\n`,
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
  if (process.argv.includes("--check")) {
    const result = audit(!process.argv.includes("--without-review"));
    console.log(
      JSON.stringify({
        status: "PASS",
        reports: result.reports.length,
        independentReview: !!result.review,
      }),
    );
  } else if (process.argv.includes("--metadata")) metadata();
  else throw new Error("Use --check or --metadata");
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
}
