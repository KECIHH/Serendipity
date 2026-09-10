import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { requireHashCoverage, requireReportBinding, requireReviewIdentity } from "../../scripts/phase-evidence.mjs";
import { root, plan, planPath, receiptPath, directory, read, json, hash, sha, write, git, inventory } from "./phase006-runtime.mjs";

const reviewPath = `${directory}/review.json`;
const qualityPath = `${directory}/quality.json`;
const gatePath = "docs/evidence/Phase006-gate.json";

function audit(requireReview = true) {
  assert(!fs.existsSync(path.join(root, directory, "attempt.json")), "Failed attempt cannot seal");
  assert.equal(plan.phase, 6);
  assert.equal(plan.requiredCaseIds.length, 13);
  assert.equal(new Set(plan.requiredCaseIds).size, 13);
  assert.deepEqual(plan.requiredCaseIds, plan.cases.map((item) => item.testCaseId));
  assert.equal(plan.threshold.originalThreshold, 13);
  assert.equal(plan.threshold.automatedThreshold, 13);
  assert.equal(plan.threshold.waived, false);
  const receipt = json(receiptPath);
  for (const input of receipt.pinnedInputs) assert.equal(hash(input.path), input.sha256);
  for (const previous of plan.previousAttempts) {
    assert.equal(hash(previous.planPath), previous.planHash);
    const old = json(previous.planPath);
    assert.equal(old.attemptId, previous.attemptId);
    for (const item of old.cases) {
      const current = plan.cases.find((entry) => entry.testCaseId === item.testCaseId);
      assert(current);
      for (const key of ["command", "denominator", "inputPath", "expected"]) assert.equal(current[key], item[key]);
    }
  }
  const reports = plan.cases.map((item) => {
    const report = json(item.outputPath);
    requireReportBinding(report, item, hash(planPath), plan.sourcePaths, hash);
    assert.equal(report.simulation, true);
    assert.equal(report.productionTraffic, false);
    for (const artifact of report.details.artifacts) assert.equal(hash(artifact.path), artifact.sha256);
    return report;
  });
  const quality = json(qualityPath);
  assert.equal(quality.status, "PASS");
  assert.equal(quality.planHash, hash(planPath));
  assert.deepEqual(quality.supportingChecks, plan.supportingChecks);
  requireHashCoverage(quality.sourceHashes, plan.sourcePaths, hash, "QUALITY_SOURCE_HASH");
  assert(quality.observations.length >= 10);
  assert(quality.observations.every((entry) => entry.exitCode === 0));
  for (const artifact of quality.artifacts) assert.equal(hash(artifact.path), artifact.sha256);
  const review = requireReview ? json(reviewPath) : null;
  if (review) {
    assert.equal(review.phase, 6);
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
  return { reports, quality, review, receipt };
}

function retry() {
  assert(fs.existsSync(path.join(root, directory, "attempt.json")), "Retry requires a recorded failure");
  const frozen = `${directory}/frozen-plan.json`;
  if (!fs.existsSync(path.join(root, frozen))) write(frozen, read(planPath));
  assert.equal(hash(frozen), hash(planPath));
  const next = structuredClone(plan);
  next.attemptId = `attempt-${Number(plan.attemptId.split("-")[1]) + 1}`;
  next.previousAttempts.push({ attemptId: plan.attemptId, planPath: frozen, planHash: hash(frozen) });
  for (const item of next.cases) item.outputPath = item.outputPath.replace(`/${plan.attemptId}/`, `/${next.attemptId}/`);
  write(planPath, next, false);
  console.warn(JSON.stringify({ status: "RETRY_FROZEN", attemptId: next.attemptId, cases: next.cases.length }));
}

function metadata() {
  const { reports, quality, review, receipt } = audit();
  assert.equal(git(["status", "--porcelain=v1"]).trim(), "", "Artifact must be committed with a clean tree");
  assert.equal(git(["show", "-s", "--format=%s", "HEAD"]).trim(), "phase(006): artifact");
  assert(!fs.existsSync(path.join(root, gatePath)), "Never overwrite a sealed Gate");
  const artifactCommit = git(["rev-parse", "HEAD"]).trim();
  const testedTree = git(["rev-parse", "HEAD^{tree}"]).trim();
  const state = json("docs/roadmap-run.json");
  assert.equal(state.completedThrough, 5);
  assert.equal(state.currentPhase, 6);
  assert.equal(state.checkpoints.at(-1).phase, 5);
  const allPaths = [...new Set([...plan.sourcePaths, ...plan.cases.flatMap((item) => [item.inputPath, item.outputPath]), ...inventory("docs/evidence/attempts/Phase006"), reviewPath, qualityPath])].sort();
  const inputs = allPaths.map((file) => {
    const sha256 = hash(file);
    assert.equal(sha(git(["show", `${artifactCommit}:${file}`], null)), sha256, `Uncommitted evidence bytes: ${file}`);
    return { path: file, sha256 };
  });
  const results = plan.cases.map((item, index) => ({ testCaseId: item.testCaseId, command: item.command, exitCode: reports[index].exitCode, numerator: reports[index].numerator, denominator: item.denominator, inputHash: `sha256:${hash(item.inputPath)}`, outputHash: `sha256:${hash(item.outputPath)}`, status: reports[index].status, details: { inputPath: item.inputPath, outputPath: item.outputPath, expected: item.expected } }));
  const intermediate = git(["rev-list", "--reverse", `${receipt.phaseStartCommit}..${artifactCommit}`]).trim().split(/\r?\n/).filter(Boolean);
  assert.equal(intermediate.at(-1), artifactCommit);
  const gate = {
    schemaVersion: "agent-gate-v1", phase: 6, attemptId: plan.attemptId, status: "PASS", simulation: true, operatorMode: "AGENT_ONLY_AUTOMATED_NEW_BUILD",
    environment: { isolated: true, syntheticUsers: true, providerMode: "local-adapter", productionTraffic: false },
    artifactCommit, requiredCaseIds: plan.requiredCaseIds, results,
    commands: results.map(({ command, exitCode }) => ({ command, exitCode })), inputs, failures: [], generatedAt: new Date().toISOString(),
    details: { planPath, planHash: hash(planPath), testedTree, reviewerRunId: review.reviewerRunId, reviewReportPath: reviewPath, reviewReportHash: hash(reviewPath), recoveryCommits: intermediate.slice(0, -1), originalThreshold: 13, automatedThreshold: 13, waived: false, requestedThrough: 6, nextPhaseExecutionAuthorized: false, notEvaluated: plan.notApplicable, qualityReportPath: qualityPath, qualityReportHash: hash(qualityPath), runtimeBaselinePath: "docs/runtime-baseline.json", runtimeBaselineHash: hash("docs/runtime-baseline.json"), costAccounting: plan.costAccounting },
  };
  write(gatePath, gate);
  const checkpoint = { phase: 6, artifactCommit, evidencePath: gatePath, evidenceHash: hash(gatePath) };
  state.completedThrough = 6; state.currentPhase = 7; state.nextPhaseExecutionAuthorized = false;
  state.lastArtifactCommit = artifactCommit; state.currentLayoutPhaseSeal = checkpoint; state.checkpoints.push(checkpoint);
  write("docs/roadmap-run.json", state, false);
  const log = read("docs/phase-completion-log.md").toString().trimEnd();
  assert(!log.includes("| Phase006 |"));
  const row = `| Phase006 | Prisma User聚合根、唯一邮箱规范化、开发缓存与脱敏数据库连接边界；初始迁移含canonical/非负版本CHECK | prisma、src/server/auth.ts、src/server/db.ts、tests/lib、tests/phase006、精确依赖及阶段工具；完整路径/hash见Gate inputs | 13/13固定验收；真实PostgreSQL 17迁移/并发唯一/故障/约束与恢复；三类变异；Prisma Studio真实浏览器13字段；Vitest ${quality.testCount}/${quality.testCount}；lint/typecheck/format:check/build/layout/上游回归退出0；独立Agent复核；artifactCommit=${artifactCommit}；attemptId=${plan.attemptId} | 登录/注册/seed/AuthSession/HTTP 503映射属于后续卡；无生产流量或真实用户资料 | 可封口候选；metadata后另执行双shell seal、clean与GitHub同步；用户授权止于006 |`;
  write("docs/phase-completion-log.md", `${log}\n${row}\n\nPhase006计划：${planPath}；唯一Gate：${gatePath}；恢复、原始命令、测试、浏览器与独立复核：docs/evidence/attempts/Phase006/。旧检查点保持原字节。\n`, false);
  console.warn(JSON.stringify({ status: "METADATA_CANDIDATE_CREATED", artifactCommit, evidenceHash: checkpoint.evidenceHash, nextPhaseExecutionAuthorized: false }));
}

try {
  if (process.argv.includes("--retry")) retry();
  else if (process.argv.includes("--metadata")) metadata();
  else { const result = audit(!process.argv.includes("--without-review")); console.warn(JSON.stringify({ status: "PASS", reports: result.reports.length, independentReview: Boolean(result.review) })); }
} catch (error) { console.error(error.stack); process.exitCode = 1; }
