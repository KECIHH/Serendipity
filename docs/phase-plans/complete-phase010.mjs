import { requirePhase010Preflight, requirePhase010Generation, requirePhase010FailureChain, createPhase010RetryPlan, requirePhase010ImplementationBinding, getPhase010ImplementationSnapshot } from "./phase010-evidence.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { requireHashCoverage, requireReportBinding, requireReviewIdentity, requirePriorCaseBinding } from "../../scripts/phase-evidence.mjs";
import { root, plan, planPath, receiptPath, directory, generationPath, migrationPath, imageDigest, read, json, hash, sha, write, git, inventory } from "./phase010-runtime.mjs";

const reviewPath = `${directory}/review.json`;
const qualityPath = `${directory}/quality.json`;
const gatePath = "docs/evidence/Phase010-gate.json";
const requiredCaseIds = ["migration", "first-seed", "repeated-seed", "concurrent-seed", "secret-privilege", "governance-absence"].map((key) => `Phase010:${key}`);

function audit(requireReview = true) {
  assert(!fs.existsSync(path.join(root, directory, "attempt.json")), "Failed attempt cannot seal");
  assert.equal(plan.phase, 10);
  assert.deepEqual(plan.requiredCaseIds, requiredCaseIds);
  assert.deepEqual(plan.cases.map((item) => item.testCaseId), requiredCaseIds);
  assert.equal(plan.threshold.originalThreshold, 6);
  assert.equal(plan.threshold.automatedThreshold, 6);
  assert.equal(plan.threshold.requiredPassRate, 1);
  assert.equal(plan.threshold.waived, false);
  assert.equal(hash(`${directory}/frozen-plan.json`), hash(planPath), "Current attempt plan changed after freezing");
  const receipt = json(receiptPath);
  requirePhase010Preflight(receipt.preflight);
  requirePhase010FailureChain(plan, { readJson: json, hashFile: hash });
  assert.equal(receipt.phase, 10);
  assert.equal(receipt.requestedThrough, 10);
  for (const input of receipt.pinnedInputs) assert.equal(hash(input.path), input.sha256);
  assert.equal(hash(receipt.prerequisites.migrationPath), receipt.prerequisites.migrationHash);
  assert.equal(sha(git(["show", `${receipt.phaseStartCommit}:${receipt.prerequisites.schemaPath}`], null)), receipt.prerequisites.schemaHash);
  for (const previous of plan.previousAttempts) {
    assert.equal(hash(previous.planPath), previous.planHash);
    const old = json(previous.planPath);
    assert.equal(old.phase, 10);
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
  const generation = json(generationPath);
  requirePhase010Generation(generation, { receipt, hashFile: hash, readText: (file) => read(file).toString(), migrationPath });
  for (const report of reports) assert(report.details.artifacts.some((artifact) => artifact.path === migrationPath && artifact.sha256 === generation.migrationHash));
  const quality = json(qualityPath);
  assert.equal(quality.status, "PASS");
  requirePhase010ImplementationBinding(quality.implementationSnapshot, getPhase010ImplementationSnapshot({ root, plan, receipt, git, hashFile: hash, inventory, migrationPath }));
  assert.equal(quality.planHash, hash(planPath));
  assert.equal(quality.simulation, true);
  assert.equal(quality.productionTraffic, false);
  assert.deepEqual(quality.supportingChecks, plan.supportingChecks);
  assert.deepEqual(quality.supportingResults.map(entry => entry.checkId), plan.supportingChecks);
  assert(quality.supportingResults.every(entry => entry.status === "PASS"));
  const pkg = json("package.json");
  const executionPaths = [...new Set([
    ...Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).map(name => `node_modules/${name}/package.json`),
    ".scaffold/tools/node_modules/npm/package.json", ".scaffold/tools/node_modules/npm/bin/npm-cli.js",
    "node_modules/prisma/build/index.js", "node_modules/.prisma/client/schema.prisma",
    "node_modules/vitest/vitest.mjs", "node_modules/tsx/dist/cli.mjs",
    "vitest/stubs/server-only.ts", "scripts/test-phase-input-paths.mjs",
    "scripts/verify-phase003.mjs", "scripts/phase003-evidence.mjs", "scripts/checkpoint-history.mjs",
  ])].sort();
  requireHashCoverage(quality.executionDependencyHashes, executionPaths, hash, "EXECUTION_DEPENDENCY_HASH");
  requireHashCoverage(quality.sourceHashes, plan.sourcePaths, hash, "QUALITY_SOURCE_HASH");
  assert(Number.isInteger(quality.testCount) && quality.testCount > 0);
  assert(quality.observations.length >= 10);
  assert(quality.observations.every((entry) => entry.exitCode === 0 && entry.timedOut !== true));
  for (const artifact of quality.artifacts) assert.equal(hash(artifact.path), artifact.sha256);
  const target = reports.find((report) => report.testCaseId === "Phase010:migration").details.target;
  assert.equal(target.host, "127.0.0.1");
  assert.match(target.database, /^phase010_disposable_[a-f0-9]{12}(?:_[a-z0-9_]+)?$/);
  assert.equal(target.image, imageDigest);
  assert.equal(target.networkMasquerading, false);
  assert.equal(target.credentials, "SYNTHETIC_REDACTED");
  assert(!Object.hasOwn(target, "password") && !Object.hasOwn(target, "url"));
  const review = requireReview ? json(reviewPath) : null;
  if (review) {
    assert.equal(review.phase, 10);
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
  const next = createPhase010RetryPlan(plan, { readJson: json, hashFile: hash });
  write(`docs/evidence/attempts/Phase010/${next.attemptId}/frozen-plan.json`, next);
  write(planPath, next, false);
  console.warn(JSON.stringify({ status: "RETRY_FROZEN", attemptId: next.attemptId, cases: next.cases.length }));
}

function metadata() {
  const { reports, quality, review, receipt, target } = audit();
  assert.equal(git(["status", "--porcelain=v1"]).trim(), "", "Artifact must be committed with a clean tree");
  assert.equal(git(["show", "-s", "--format=%s", "HEAD"]).trim(), "phase(010): artifact");
  assert(!fs.existsSync(path.join(root, gatePath)), "Never overwrite a sealed Gate");
  const artifactCommit = git(["rev-parse", "HEAD"]).trim();
  const testedTree = git(["rev-parse", "HEAD^{tree}"]).trim();
  const state = json("docs/roadmap-run.json");
  assert.equal(state.completedThrough, 9);
  assert.equal(state.currentPhase, 10);
  assert.equal(state.checkpoints.at(-1).phase, 9);
  assert.equal(state.manifestHash, receipt.manifestHash);
  const allPaths = [...new Set([...plan.sourcePaths, ...plan.cases.flatMap((item) => [item.inputPath, item.outputPath]), ...inventory("docs/evidence/attempts/Phase010"), migrationPath, reviewPath, qualityPath])].sort();
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
    schemaVersion: "agent-gate-v1", phase: 10, attemptId: plan.attemptId, status: "PASS", simulation: true,
    operatorMode: "AGENT_ONLY_AUTOMATED_NEW_BUILD",
    environment: { isolated: true, syntheticUsers: true, providerMode: "local-adapter", productionTraffic: false },
    artifactCommit, requiredCaseIds: plan.requiredCaseIds, results,
    commands: results.map(({ command, exitCode }) => ({ command, exitCode })), inputs, failures: [], generatedAt: new Date().toISOString(),
    details: {
      planPath, planHash: hash(planPath), testedTree,
      reviewerRunId: review.reviewerRunId, reviewReportPath: reviewPath, reviewReportHash: hash(reviewPath),
      recoveryCommits: intermediate.slice(0, -1), originalThreshold: 6, automatedThreshold: 6, waived: false,
      requestedThrough: 10, nextPhaseExecutionAuthorized: false, notEvaluated: plan.notApplicable,
      qualityReportPath: qualityPath, qualityReportHash: hash(qualityPath),
      runtimeBaselinePath: "docs/runtime-baseline.json", runtimeBaselineHash: hash("docs/runtime-baseline.json"),
      manifestHash: receipt.manifestHash, projectCommit: artifactCommit,
      schemaPath: "prisma/schema.prisma", schemaHash: hash("prisma/schema.prisma"),
      migrationPath, migrationHash: hash(migrationPath),
      databaseRoles: { migration: "phase010_runner", runtime: "phase010_app", runtimeOwner: false, runtimeSuperuser: false },
      databaseFingerprint: { ...databaseIdentity, sha256: sha(JSON.stringify(databaseIdentity)), credentials: "SYNTHETIC_REDACTED" },
      costAccounting: plan.costAccounting,
    },
  };
  write(gatePath, gate);
  const checkpoint = { phase: 10, artifactCommit, evidencePath: gatePath, evidenceHash: hash(gatePath) };
  state.completedThrough = 10;
  state.currentPhase = 11;
  state.nextPhaseExecutionAuthorized = false;
  state.lastArtifactCommit = artifactCommit;
  state.currentLayoutPhaseSeal = checkpoint;
  state.checkpoints.push(checkpoint);
  write("docs/roadmap-run.json", state, false);
  const log = read("docs/phase-completion-log.md").toString().trimEnd();
  assert(!log.includes("| Phase010 |"));
  const row = `| Phase010 | ApiKeyConfig 加密存储边界与 create-only 基础 seed，M2 数据层收口 | 单一 api_key_config 迁移、envelope/JCS/AAD、Serializable seed 与同事务审计、命令 env registry、实库/类型/变异测试、配套契约文档及阶段证据；完整路径和 hash 见 Gate | 固定 6/6；PostgreSQL17 迁移重放、首次/重复/并发 seed、来源/权限/秘密拒绝、治理表缺席；两类变异红→恢复绿；Vitest ${quality.testCount}/${quality.testCount}；User ${quality.userRegressionTestCount}、配置 ${quality.configRegressionTestCount}、旅行/消息 ${quality.dataRegressionTestCount}、审计 ${quality.auditRegressionTestCount} 项回归；lint/typecheck/format/build/layout/validator 退出0；独立 Agent 复核；artifactCommit=${artifactCommit}；attemptId=${plan.attemptId} | 未连接生产数据库、使用真实身份或调用 Provider；加解密管理及轮换归 Phase013，治理模型归 Phase015，均未执行 | 可封口候选；metadata 后另执行双 shell seal、clean 和 GitHub 同步；用户授权止于010 |`;
  write("docs/phase-completion-log.md", `${log}\n${row}\n\nPhase010 计划：${planPath}；唯一 Gate：${gatePath}；恢复、原始命令、数据库、测试与独立复核：docs/evidence/attempts/Phase010/。旧检查点保持原字节。\n`, false);
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
