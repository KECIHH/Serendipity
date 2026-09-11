import { requirePhase011Preflight, requirePhase011Generation, requirePhase011FailureChain, createPhase011RetryPlan, requirePhase011ImplementationBinding, getPhase011ImplementationSnapshot } from "./phase011-evidence.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { requireHashCoverage, requireReportBinding, requireReviewIdentity, requirePriorCaseBinding } from "../../scripts/phase-evidence.mjs";
import { root, plan, planPath, receiptPath, directory, generationPath, migrationPath, imageDigest, read, json, hash, sha, write, git, inventory } from "./phase011-runtime.mjs";

const reviewPath = `${directory}/review.json`;
const qualityPath = `${directory}/quality.json`;
const gatePath = "docs/evidence/Phase011-gate.json";
const requiredCaseIds = ["valid-login", "uniform-failure", "dual-throttle", "persistence-proxy", "session-revocation", "guards", "routing-logout", "mutation"].map((key) => `Phase011:${key}`);

function audit(requireReview = true) {
  assert(!fs.existsSync(path.join(root, directory, "attempt.json")), "Failed attempt cannot seal");
  assert.equal(plan.phase, 11);
  assert.deepEqual(plan.requiredCaseIds, requiredCaseIds);
  assert.deepEqual(plan.cases.map((item) => item.testCaseId), requiredCaseIds);
  assert.equal(plan.threshold.originalThreshold, 8);
  assert.equal(plan.threshold.automatedThreshold, 8);
  assert.equal(plan.threshold.requiredPassRate, 1);
  assert.equal(plan.threshold.waived, false);
  assert.equal(hash(`${directory}/frozen-plan.json`), hash(planPath), "Current attempt plan changed after freezing");
  const receipt = json(receiptPath);
  requirePhase011Preflight(receipt.preflight);
  assert.equal(hash(receipt.preflight.reportPath), receipt.preflight.reportHash, "PREFLIGHT_HASH: original admission report changed");
  for (const [field, value] of Object.entries(json(receipt.preflight.reportPath))) assert.deepEqual(receipt.preflight[field], value, `PREFLIGHT_BINDING: ${field}`);
  requirePhase011FailureChain(plan, { readJson: json, hashFile: hash });
  assert.equal(receipt.phase, 11);
  assert.equal(receipt.requestedThrough, 11);
  for (const input of receipt.pinnedInputs) assert.equal(hash(input.path), input.sha256);
  assert.equal(hash(receipt.prerequisites.migrationPath), receipt.prerequisites.migrationHash);
  assert.equal(sha(git(["show", `${receipt.phaseStartCommit}:${receipt.prerequisites.schemaPath}`], null)), receipt.prerequisites.schemaHash);
  for (const previous of plan.previousAttempts) {
    assert.equal(hash(previous.planPath), previous.planHash);
    const old = json(previous.planPath);
    assert.equal(old.phase, 11);
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
  requirePhase011Generation(generation, { receipt, hashFile: hash, readText: (file) => read(file).toString(), migrationPath });
  for (const report of reports) assert(report.details.artifacts.some((artifact) => artifact.path === migrationPath && artifact.sha256 === generation.migrationHash));
  const quality = json(qualityPath);
  assert.equal(quality.status, "PASS");
  requirePhase011ImplementationBinding(quality.implementationSnapshot, getPhase011ImplementationSnapshot({ root, plan, receipt, git, hashFile: hash, inventory, migrationPath }));
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
  const target = reports.find((report) => report.testCaseId === "Phase011:valid-login").details.target;
  assert.equal(target.host, "127.0.0.1");
  assert.match(target.database, /^phase011_disposable_[a-f0-9]{12}(?:_[a-z0-9_]+)?$/);
  assert.equal(target.image, imageDigest);
  assert.equal(target.networkMasquerading, false);
  assert.equal(target.credentials, "SYNTHETIC_REDACTED");
  assert(!Object.hasOwn(target, "password") && !Object.hasOwn(target, "url"));
  const review = requireReview ? json(reviewPath) : null;
  if (review) {
    assert.equal(review.phase, 11);
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
  const next = createPhase011RetryPlan(plan, { readJson: json, hashFile: hash });
  const failure = json(`${directory}/attempt.json`);
  for (const file of failure.scopeAdditions ?? []) {
    assert.equal(failure.kind, "PLAN_SCOPE");
    assert(typeof file === "string" && !file.includes("..") && !path.isAbsolute(file));
    assert(plan.sourcePaths.includes(file), "Supporting scope addition must already be a frozen source");
    if (!next.modificationScope.includes(file)) next.modificationScope.push(file);
  }
  write(`docs/evidence/attempts/Phase011/${next.attemptId}/frozen-plan.json`, next);
  write(planPath, next, false);
  console.warn(JSON.stringify({ status: "RETRY_FROZEN", attemptId: next.attemptId, cases: next.cases.length }));
}

function scopeCheck() {
  const required = ["vitest.setup.ts", "vitest.config.ts", "tsconfig.json", "scripts/eslint-env.mjs"];
  const missing = required.filter((file) => !plan.modificationScope.includes(file));
  if (missing.length === 0) return;
  const failurePath = `${directory}/attempt.json`;
  assert(!fs.existsSync(path.join(root, failurePath)), "A previous failure must stay immutable");
  write(failurePath, {
    phase: 11, attemptId: plan.attemptId, status: "FAIL", kind: "PLAN_SCOPE", artifactCommit: null,
    command: "node docs/phase-plans/complete-phase011.mjs --scope-check", exitCode: 1,
    planHash: hash(planPath), reason: "Shared test/runtime configuration is required to execute real Auth.js dependencies and registered auth environment values, but its supporting paths were omitted from modificationScope.",
    scopeAdditions: missing,
    supportingFailureReports: ["docs/evidence/attempts/Phase011/attempt-1/ui-unit-1789140478188.json"]
      .filter((file) => fs.existsSync(path.join(root, file)))
      .map((file) => ({ path: file, sha256: hash(file), originatingAttempt: "attempt-1", description: "The actual earlier UI command exited 1 because Auth.js external ESM next/server resolution failed during collection; no failed report is reassigned to this attempt." })),
    recordedAt: new Date().toISOString(),
  });
  assert.fail(`PLAN_SCOPE: missing required supporting paths: ${missing.join(", ")}`);
}

function metadata() {
  const { reports, quality, review, receipt, target } = audit();
  assert.equal(git(["status", "--porcelain=v1"]).trim(), "", "Artifact must be committed with a clean tree");
  assert.equal(git(["show", "-s", "--format=%s", "HEAD"]).trim(), "phase(011): artifact");
  assert(!fs.existsSync(path.join(root, gatePath)), "Never overwrite a sealed Gate");
  const artifactCommit = git(["rev-parse", "HEAD"]).trim();
  const testedTree = git(["rev-parse", "HEAD^{tree}"]).trim();
  const state = json("docs/roadmap-run.json");
  assert.equal(state.completedThrough, 10);
  assert.equal(state.currentPhase, 11);
  assert.equal(state.checkpoints.at(-1).phase, 10);
  assert.equal(state.manifestHash, receipt.manifestHash);
  const allPaths = [...new Set([...plan.sourcePaths, ...plan.cases.flatMap((item) => [item.inputPath, item.outputPath]), ...inventory("docs/evidence/attempts/Phase011"), migrationPath, reviewPath, qualityPath])].sort();
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
    schemaVersion: "agent-gate-v1", phase: 11, attemptId: plan.attemptId, status: "PASS", simulation: true,
    operatorMode: "AGENT_ONLY_AUTOMATED_NEW_BUILD",
    environment: { isolated: true, syntheticUsers: true, providerMode: "local-adapter", productionTraffic: false },
    artifactCommit, requiredCaseIds: plan.requiredCaseIds, results,
    commands: results.map(({ command, exitCode }) => ({ command, exitCode })), inputs, failures: [], generatedAt: new Date().toISOString(),
    details: {
      planPath, planHash: hash(planPath), testedTree,
      reviewerRunId: review.reviewerRunId, reviewReportPath: reviewPath, reviewReportHash: hash(reviewPath),
      recoveryCommits: intermediate.slice(0, -1), originalThreshold: 8, automatedThreshold: 8, waived: false,
      requestedThrough: 11, nextPhaseExecutionAuthorized: false, notEvaluated: plan.notApplicable,
      qualityReportPath: qualityPath, qualityReportHash: hash(qualityPath),
      runtimeBaselinePath: "docs/runtime-baseline.json", runtimeBaselineHash: hash("docs/runtime-baseline.json"),
      manifestHash: receipt.manifestHash, projectCommit: artifactCommit,
      schemaPath: "prisma/schema.prisma", schemaHash: hash("prisma/schema.prisma"),
      authContractPath: "docs/auth.md", authContractHash: hash("docs/auth.md"),
      apiContractPath: "docs/api.md", apiContractHash: hash("docs/api.md"),
      migrationPath, migrationHash: hash(migrationPath),
      databaseRoles: { migration: "phase011_runner", runtime: "phase011_app", runtimeOwner: false, runtimeSuperuser: false },
      databaseFingerprint: { ...databaseIdentity, sha256: sha(JSON.stringify(databaseIdentity)), credentials: "SYNTHETIC_REDACTED" },
      costAccounting: plan.costAccounting,
    },
  };
  write(gatePath, gate);
  const checkpoint = { phase: 11, artifactCommit, evidencePath: gatePath, evidenceHash: hash(gatePath) };
  state.completedThrough = 11;
  state.currentPhase = 12;
  state.nextPhaseExecutionAuthorized = false;
  state.lastArtifactCommit = artifactCommit;
  state.currentLayoutPhaseSeal = checkpoint;
  state.checkpoints.push(checkpoint);
  write("docs/roadmap-run.json", state, false);
  const log = read("docs/phase-completion-log.md").toString().trimEnd();
  assert(!log.includes("| Phase011 |"));
  const row = `| Phase011 | 管理员 Credentials 登录、PostgreSQL 双维度限流与每请求服务端授权 | 唯一 auth_session_login_attempt 迁移、Auth.js 安全 Cookie、共享凭据/会话、可信 ingress、requireAdmin、登录退出页面、同事务审计、实库/浏览器/变异测试及契约；完整路径和 hash 见 Gate | 固定 8/8；真实 PostgreSQL17 与 Auth.js、恒定 bcrypt 路径、并发持久限流、撤销、页面/API/Action 守卫、路由退出闭环；隔离变异红→恢复绿；Vitest ${quality.testCount}/${quality.testCount}；Phase006–010 回归及 lint/typecheck/format/build/layout/validator 退出0；独立 Agent 复核；artifactCommit=${artifactCommit}；attemptId=${plan.attemptId} | 未连接生产、使用真实身份或执行注册/管理变更；真人读屏体验 NOT_EVALUATED；未执行 Phase012 | 可封口候选；metadata 后另执行双 shell seal、clean 和 GitHub 同步；用户授权止于011 |`;
  write("docs/phase-completion-log.md", `${log}\n${row}\n\nPhase011 计划：${planPath}；唯一 Gate：${gatePath}；恢复、原始命令、数据库、测试与独立复核：docs/evidence/attempts/Phase011/。旧检查点保持原字节。\n`, false);
  console.warn(JSON.stringify({ status: "METADATA_CANDIDATE_CREATED", artifactCommit, evidenceHash: checkpoint.evidenceHash, nextPhaseExecutionAuthorized: false }));
}

try {
  if (process.argv.includes("--scope-check")) scopeCheck();
  else if (process.argv.includes("--retry")) retry();
  else if (process.argv.includes("--metadata")) metadata();
  else { const result = audit(!process.argv.includes("--without-review")); console.warn(JSON.stringify({ status: "PASS", reports: result.reports.length, independentReview: Boolean(result.review) })); }
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
}
