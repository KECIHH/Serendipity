import { requirePhase009Preflight, requirePhase009Generation, requirePhase009FailureChain, createPhase009RetryPlan, requirePhase009ImplementationBinding, getPhase009ImplementationSnapshot } from "./phase009-evidence.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { requireHashCoverage, requireReportBinding, requireReviewIdentity, requirePriorCaseBinding } from "../../scripts/phase-evidence.mjs";
import { root, plan, planPath, receiptPath, directory, migrationPath, imageDigest, read, json, hash, sha, write, git, inventory } from "./phase009-runtime.mjs";

const reviewPath = `${directory}/review.json`;
const qualityPath = `${directory}/quality.json`;
const gatePath = "docs/evidence/Phase009-gate.json";
const requiredCaseIds = ["schema", "append-only", "recursive-redaction", "transaction", "system-actor", "lookup", "bounded-metadata", "mutation"].map((key) => `Phase009:${key}`);

function audit(requireReview = true) {
  assert(!fs.existsSync(path.join(root, directory, "attempt.json")), "Failed attempt cannot seal");
  assert.equal(plan.phase, 9);
  assert.deepEqual(plan.requiredCaseIds, requiredCaseIds);
  assert.deepEqual(plan.cases.map((item) => item.testCaseId), requiredCaseIds);
  assert.equal(plan.threshold.originalThreshold, 8);
  assert.equal(plan.threshold.automatedThreshold, 8);
  assert.equal(plan.threshold.requiredPassRate, 1);
  assert.equal(plan.threshold.waived, false);
  assert.equal(hash(`${directory}/frozen-plan.json`), hash(planPath), "Current attempt plan changed after freezing");
  const receipt = json(receiptPath);
  requirePhase009Preflight(receipt.preflight);
  requirePhase009FailureChain(plan, { readJson: json, hashFile: hash });
  assert.equal(receipt.phase, 9);
  assert.equal(receipt.requestedThrough, 9);
  for (const input of receipt.pinnedInputs) assert.equal(hash(input.path), input.sha256);
  assert.equal(hash(receipt.prerequisites.migrationPath), receipt.prerequisites.migrationHash);
  assert.equal(sha(git(["show", `${receipt.phaseStartCommit}:${receipt.prerequisites.schemaPath}`], null)), receipt.prerequisites.schemaHash);
  for (const previous of plan.previousAttempts) {
    assert.equal(hash(previous.planPath), previous.planHash);
    const old = json(previous.planPath);
    assert.equal(old.phase, 9);
    assert.equal(old.attemptId, previous.attemptId);
    requirePriorCaseBinding(plan, old, { readJson: json, hashFile: hash });
  }
  const reports = plan.cases.map((item) => {
    const report = json(item.outputPath);
    requireReportBinding(report, item, hash(planPath), plan.sourcePaths, hash);
    assert.equal(report.simulation, true);
    assert.equal(report.productionTraffic, false);
    assert(Array.isArray(report.details.artifacts));
    for (const artifact of report.details.artifacts) assert.equal(hash(artifact.path), artifact.sha256);
    return report;
  });
  const generation = json("docs/evidence/attempts/Phase009/setup/migration-generation.json");
  requirePhase009Generation(generation, { receipt, hashFile: hash, readText: (file) => read(file).toString(), migrationPath });
  for (const report of reports) assert(report.details.artifacts.some((artifact) => artifact.path === migrationPath && artifact.sha256 === generation.migrationHash));
  const quality = json(qualityPath);
  assert.equal(quality.status, "PASS");
  requirePhase009ImplementationBinding(quality.implementationSnapshot, getPhase009ImplementationSnapshot({ root, plan, receipt, git, hashFile: hash, inventory, migrationPath }));
  assert.equal(quality.planHash, hash(planPath));
  assert.equal(quality.simulation, true);
  assert.equal(quality.productionTraffic, false);
  assert.deepEqual(quality.supportingChecks, plan.supportingChecks);
  requireHashCoverage(quality.sourceHashes, plan.sourcePaths, hash, "QUALITY_SOURCE_HASH");
  assert(Number.isInteger(quality.testCount) && quality.testCount > 0);
  assert(quality.observations.length >= 10);
  assert(quality.observations.every((entry) => entry.exitCode === 0 && entry.timedOut !== true));
  for (const artifact of quality.artifacts) assert.equal(hash(artifact.path), artifact.sha256);
  const target = reports.find((report) => report.testCaseId === "Phase009:schema").details.target;
  assert.equal(target.host, "127.0.0.1");
  assert.match(target.database, /^phase009_disposable_[a-f0-9]{12}(?:_[a-z0-9_]+)?$/);
  assert.equal(target.image, imageDigest);
  assert.equal(target.networkMasquerading, false);
  assert.equal(target.credentials, "SYNTHETIC_REDACTED");
  assert(!Object.hasOwn(target, "password") && !Object.hasOwn(target, "url"));
  const review = requireReview ? json(reviewPath) : null;
  if (review) {
    assert.equal(review.phase, 9);
    assert.equal(review.attemptId, plan.attemptId);
    assert.equal(review.planPath, planPath);
    assert.equal(review.planHash, hash(planPath));
    assert.equal(review.decision, "PASS");
    requireReviewIdentity(review, plan.implementationContextId);
    requireHashCoverage(review.sourceHashes, plan.sourcePaths, hash, "REVIEW_SOURCE_HASH");
    requireHashCoverage(review.reportHashes, plan.cases.map((item) => item.outputPath), hash, "REVIEW_REPORT_HASH");
    requireHashCoverage(review.supplementalReportHashes, [qualityPath], hash, "REVIEW_SUPPLEMENTAL_HASH");
    assert(Array.isArray(review.issues) && Array.isArray(review.dispositions));
    for (const issue of review.issues) assert(issue.status === "RESOLVED" || review.dispositions.some((entry) => entry.issueId === issue.id && entry.status === "RESOLVED"));
  }
  return { reports, quality, review, receipt, target };
}

function retry() {
  assert(fs.existsSync(path.join(root, directory, "attempt.json")), "Retry requires a recorded failure");
  const frozen = `${directory}/frozen-plan.json`;
  if (!fs.existsSync(path.join(root, frozen))) write(frozen, read(planPath));
  assert.equal(hash(frozen), hash(planPath));
  assert.match(plan.attemptId, /^attempt-\d+$/);
  const next = createPhase009RetryPlan(plan, { readJson: json, hashFile: hash });
  write(`docs/evidence/attempts/Phase009/${next.attemptId}/frozen-plan.json`, next);
  write(planPath, next, false);
  console.warn(JSON.stringify({ status: "RETRY_FROZEN", attemptId: next.attemptId, cases: next.cases.length }));
}

function metadata() {
  const { reports, quality, review, receipt, target } = audit();
  assert.equal(git(["status", "--porcelain=v1"]).trim(), "", "Artifact must be committed with a clean tree");
  assert.equal(git(["show", "-s", "--format=%s", "HEAD"]).trim(), "phase(009): artifact");
  assert(!fs.existsSync(path.join(root, gatePath)), "Never overwrite a sealed Gate");
  const artifactCommit = git(["rev-parse", "HEAD"]).trim();
  const testedTree = git(["rev-parse", "HEAD^{tree}"]).trim();
  const state = json("docs/roadmap-run.json");
  assert.equal(state.completedThrough, 8);
  assert.equal(state.currentPhase, 9);
  assert.equal(state.checkpoints.at(-1).phase, 8);
  assert.equal(state.manifestHash, receipt.manifestHash);
  const allPaths = [...new Set([...plan.sourcePaths, ...plan.cases.flatMap((item) => [item.inputPath, item.outputPath]), ...inventory("docs/evidence/attempts/Phase009"), migrationPath, reviewPath, qualityPath])].sort();
  const inputs = allPaths.map((file) => {
    const sha256 = hash(file);
    assert.equal(sha(git(["show", `${artifactCommit}:${file}`], null)), sha256, `Uncommitted evidence bytes: ${file}`);
    return { path: file, sha256 };
  });
  const results = plan.cases.map((item, index) => ({
    testCaseId: item.testCaseId, command: item.command, exitCode: reports[index].exitCode,
    numerator: reports[index].numerator, denominator: item.denominator,
    inputHash: `sha256:${hash(item.inputPath)}`, outputHash: `sha256:${hash(item.outputPath)}`,
    status: reports[index].status,
    details: { inputPath: item.inputPath, outputPath: item.outputPath, expected: item.expected },
  }));
  const intermediate = git(["rev-list", "--reverse", `${receipt.phaseStartCommit}..${artifactCommit}`]).trim().split(/\r?\n/).filter(Boolean);
  assert.equal(intermediate.at(-1), artifactCommit);
  const databaseIdentity = { host: target.host, port: target.port, database: target.database, containerId: target.containerId, image: target.image };
  const gate = {
    schemaVersion: "agent-gate-v1", phase: 9, attemptId: plan.attemptId, status: "PASS", simulation: true,
    operatorMode: "AGENT_ONLY_AUTOMATED_NEW_BUILD",
    environment: { isolated: true, syntheticUsers: true, providerMode: "local-adapter", productionTraffic: false },
    artifactCommit, requiredCaseIds: plan.requiredCaseIds, results,
    commands: results.map(({ command, exitCode }) => ({ command, exitCode })), inputs, failures: [], generatedAt: new Date().toISOString(),
    details: {
      planPath, planHash: hash(planPath), testedTree,
      reviewerRunId: review.reviewerRunId, reviewReportPath: reviewPath, reviewReportHash: hash(reviewPath),
      recoveryCommits: intermediate.slice(0, -1), originalThreshold: 8, automatedThreshold: 8, waived: false,
      requestedThrough: 9, nextPhaseExecutionAuthorized: false, notEvaluated: plan.notApplicable,
      qualityReportPath: qualityPath, qualityReportHash: hash(qualityPath),
      runtimeBaselinePath: "docs/runtime-baseline.json", runtimeBaselineHash: hash("docs/runtime-baseline.json"),
      manifestHash: receipt.manifestHash, projectCommit: artifactCommit,
      schemaPath: "prisma/schema.prisma", schemaHash: hash("prisma/schema.prisma"),
      migrationPath, migrationHash: hash(migrationPath),
      databaseRoles: { migration: "phase009_runner", runtime: "phase009_app", runtimeOwner: false, runtimeSuperuser: false },
      databaseFingerprint: { ...databaseIdentity, sha256: sha(JSON.stringify(databaseIdentity)), credentials: "SYNTHETIC_REDACTED" },
      costAccounting: plan.costAccounting,
    },
  };
  write(gatePath, gate);
  const checkpoint = { phase: 9, artifactCommit, evidencePath: gatePath, evidenceHash: hash(gatePath) };
  state.completedThrough = 9;
  state.currentPhase = 10;
  state.nextPhaseExecutionAuthorized = false;
  state.lastArtifactCommit = artifactCommit;
  state.currentLayoutPhaseSeal = checkpoint;
  state.checkpoints.push(checkpoint);
  write("docs/roadmap-run.json", state, false);
  const log = read("docs/phase-completion-log.md").toString().trimEnd();
  assert(!log.includes("| Phase009 |"));
  const row = `| Phase009 | AuditLog 只追加、同事务服务、递归脱敏与有界元数据 | Prisma AuditLog及单一audit_log迁移、server审计/上下文工具、实库/纯函数/类型/变异测试、database/privacy文档与阶段证据工具；完整路径及hash见Gate | 固定8/8；PostgreSQL17实库、非owner应用角色、SQL trigger及FK SetNull、EXPLAIN五索引、事务配对与双向回滚、两类变异红→恢复绿；Vitest ${quality.testCount}/${quality.testCount}；User回归${quality.userRegressionTestCount}项、配置回归${quality.configRegressionTestCount}项、旅行/消息回归${quality.dataRegressionTestCount}项；lint/typecheck/format/build/layout/validator退出0；独立Agent复核；artifactCommit=${artifactCommit}；attemptId=${plan.attemptId} | 维护/ERASE与审计UI/API由后续阶段生产；未接触生产数据库、真实用户或Provider流量 | 可封口候选；metadata后另执行双shell seal、clean与GitHub同步；用户授权止于009 |`;
  write("docs/phase-completion-log.md", `${log}\n${row}\n\nPhase009 计划：${planPath}；唯一 Gate：${gatePath}；恢复、原始命令、数据库、测试与独立复核：docs/evidence/attempts/Phase009/。旧检查点保持原字节。\n`, false);
  console.warn(JSON.stringify({ status: "METADATA_CANDIDATE_CREATED", artifactCommit, evidenceHash: checkpoint.evidenceHash, nextPhaseExecutionAuthorized: false }));
}

try {
  if (process.argv.includes("--retry")) retry();
  else if (process.argv.includes("--metadata")) metadata();
  else { const result = audit(!process.argv.includes("--without-review")); console.warn(JSON.stringify({ status: "PASS", reports: result.reports.length, independentReview: Boolean(result.review) })); }
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
}
