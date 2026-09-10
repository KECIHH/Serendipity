import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  requireHashCoverage,
  requireReportBinding,
  requireReviewIdentity,
} from "../../scripts/phase-evidence.mjs";
import {
  root,
  plan,
  planPath,
  receiptPath,
  directory,
  read,
  json,
  hash,
  sha,
  write,
  git,
  inventory,
} from "./phase005-runtime.mjs";

const reviewPath = `${directory}/review.json`;
const gatePath = "docs/evidence/Phase005-gate.json";

function audit(requireReview = true) {
  assert(!fs.existsSync(path.join(root, directory, "attempt.json")), "Failed attempt cannot seal");
  assert.equal(plan.phase, 5);
  assert.equal(new Set(plan.requiredCaseIds).size, plan.requiredCaseIds.length);
  assert.deepEqual(
    plan.requiredCaseIds,
    plan.cases.map((item) => item.testCaseId),
  );
  assert.equal(plan.threshold.originalThreshold, plan.threshold.automatedThreshold);
  assert.equal(plan.threshold.waived, false);
  assert.equal(plan.milestone.originalThreshold, 6);
  assert.equal(plan.milestone.automatedThreshold, 6);
  assert.equal(plan.milestone.productionMatrixDenominator, 3);
  const receipt = json(receiptPath);
  for (const input of receipt.pinnedInputs)
    assert.equal(hash(input.path), input.sha256, `Pinned input changed: ${input.id}`);
  for (const previous of plan.previousAttempts) {
    assert.equal(hash(previous.planPath), previous.planHash);
    const old = json(previous.planPath);
    assert.equal(old.attemptId, previous.attemptId);
    for (const item of old.cases) {
      const current = plan.cases.find((entry) => entry.testCaseId === item.testCaseId);
      assert(current);
      for (const key of ["command", "denominator", "inputPath", "expected"])
        assert.equal(current[key], item[key]);
    }
    assert(plan.threshold.originalThreshold >= old.threshold.originalThreshold);
  }
  const reports = plan.cases.map((item) => {
    const report = json(item.outputPath);
    requireReportBinding(report, item, hash(planPath), plan.sourcePaths, hash);
    assert.equal(report.productionTraffic, false);
    assert.equal(report.simulation, true);
    for (const artifact of report.details.artifacts ?? [])
      assert.equal(hash(artifact.path), artifact.sha256);
    return report;
  });
  const milestoneReports = plan.milestone.requiredCaseIds.map((id) =>
    reports.find((entry) => entry.testCaseId === `Phase005:${id}`),
  );
  assert.equal(milestoneReports.length, 6);
  assert(milestoneReports.every((entry) => entry?.status === "PASS"));
  const production = reports.find((entry) => entry.testCaseId === "Phase005:production-middleware");
  assert.equal(production.details.rows.length, 3);
  assert.deepEqual(
    production.details.rows.map(({ pathname, status }) => [pathname, status]),
    [
      ["/admin", 404],
      ["/admin/settings", 404],
      ["/", 200],
    ],
  );
  assert(
    production.details.rows.filter((row) => row.status === 404).every((row) => row.bodyBytes === 0),
  );
  const review = requireReview ? json(reviewPath) : null;
  if (review) {
    assert.equal(review.phase, 5);
    assert.equal(review.attemptId, plan.attemptId);
    assert.equal(review.planPath, planPath);
    assert.equal(review.planHash, hash(planPath));
    assert.equal(review.decision, "PASS");
    requireReviewIdentity(review, plan.implementationContextId);
    requireHashCoverage(review.sourceHashes, plan.sourcePaths, hash, "REVIEW_SOURCE_HASH");
    requireHashCoverage(
      review.reportHashes,
      plan.cases.map((item) => item.outputPath),
      hash,
      "REVIEW_REPORT_HASH",
    );
    assert(Array.isArray(review.issues) && Array.isArray(review.dispositions));
    for (const issue of review.issues)
      assert(
        issue.status === "RESOLVED" ||
          review.dispositions.some(
            (entry) => entry.issueId === issue.id && entry.status === "RESOLVED",
          ),
      );
  }
  return { reports, review, receipt };
}

function retry() {
  const failure = `${directory}/attempt.json`;
  assert(fs.existsSync(path.join(root, failure)), "Retry requires a recorded failure");
  const frozen = `${directory}/frozen-plan.json`;
  if (!fs.existsSync(path.join(root, frozen))) write(frozen, read(planPath).toString());
  assert.equal(hash(frozen), hash(planPath), "The failed plan has already changed");
  const nextAttempt = `attempt-${Number(plan.attemptId.replace("attempt-", "")) + 1}`;
  const next = structuredClone(plan);
  next.attemptId = nextAttempt;
  next.previousAttempts.push({
    attemptId: plan.attemptId,
    planPath: frozen,
    planHash: hash(frozen),
  });
  for (const item of next.cases)
    item.outputPath = item.outputPath.replace(`/${plan.attemptId}/`, `/${nextAttempt}/`);
  write(planPath, next, false);
  console.warn(
    JSON.stringify({
      status: "RETRY_FROZEN",
      attemptId: nextAttempt,
      previousPlanHash: hash(frozen),
      requiredCases: next.requiredCaseIds.length,
    }),
  );
}

function metadata() {
  const { reports, review, receipt } = audit();
  assert.equal(
    git(["status", "--porcelain=v1"]).trim(),
    "",
    "Artifact must be committed with a clean tree",
  );
  assert.equal(git(["show", "-s", "--format=%s", "HEAD"]).trim(), "phase(005): artifact");
  assert(!fs.existsSync(path.join(root, gatePath)), "A sealed Gate must never be overwritten");
  const artifactCommit = git(["rev-parse", "HEAD"]).trim();
  const testedTree = git(["rev-parse", "HEAD^{tree}"]).trim();
  const state = json("docs/roadmap-run.json");
  assert.equal(state.completedThrough, 4);
  assert.equal(state.currentPhase, 5);
  assert.equal(state.checkpoints.at(-1).phase, 4);
  const allPaths = [
    ...new Set([
      ...plan.sourcePaths,
      ...plan.cases.flatMap((item) => [item.inputPath, item.outputPath]),
      ...inventory("docs/evidence/attempts/Phase005"),
      reviewPath,
    ]),
  ].sort();
  const inputs = allPaths.map((file) => {
    const sha256 = hash(file);
    assert.equal(
      sha(git(["show", `${artifactCommit}:${file}`], null)),
      sha256,
      `Uncommitted evidence bytes: ${file}`,
    );
    return { path: file, sha256 };
  });
  const results = plan.cases.map((item, index) => ({
    testCaseId: item.testCaseId,
    command: item.command,
    exitCode: reports[index].exitCode,
    numerator: reports[index].numerator,
    denominator: item.denominator,
    inputHash: `sha256:${hash(item.inputPath)}`,
    outputHash: `sha256:${hash(item.outputPath)}`,
    status: reports[index].status,
    details: { inputPath: item.inputPath, outputPath: item.outputPath, expected: item.expected },
  }));
  const intermediate = git([
    "rev-list",
    "--reverse",
    `${receipt.phaseStartCommit}..${artifactCommit}`,
  ])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  assert.equal(intermediate.at(-1), artifactCommit);
  const gate = {
    schemaVersion: "agent-gate-v1",
    phase: 5,
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
      originalThreshold: plan.threshold.originalThreshold,
      automatedThreshold: plan.threshold.automatedThreshold,
      waived: false,
      milestone: {
        id: "M1",
        phases: [2, 3, 4, 5],
        numerator: 6,
        denominator: 6,
        originalThreshold: 6,
        automatedThreshold: 6,
        productionMatrix: { numerator: 3, denominator: 3 },
        waived: false,
      },
      requestedThrough: 5,
      nextPhaseExecutionAuthorized: false,
      notEvaluated: plan.notApplicable,
      runtimeBaselinePath: "docs/runtime-baseline.json",
      runtimeBaselineHash: hash("docs/runtime-baseline.json"),
    },
  };
  write(gatePath, gate);
  const checkpoint = {
    phase: 5,
    artifactCommit,
    evidencePath: gatePath,
    evidenceHash: hash(gatePath),
  };
  state.completedThrough = 5;
  state.currentPhase = 6;
  state.nextPhaseExecutionAuthorized = false;
  state.lastArtifactCommit = artifactCommit;
  state.currentLayoutPhaseSeal = checkpoint;
  state.checkpoints.push(checkpoint);
  write("docs/roadmap-run.json", state, false);
  const tests = reports.find((report) => report.testCaseId === "Phase005:test").details.testCount;
  const row = `| Phase005 | 目录骨架、精确格式化/JSON/API公共工具、四状态组件、前后台布局、单一Toast与后台空404闸门 | src、tests/phase005、README、依赖登记与执行工具；完整路径/hash见Gate inputs | ${results.length}/${results.length}验收；Vitest ${tests}/${tests}；lint/typecheck/format:check/build/verify:phase003退出0；M1 6/6、生产路径3/3、开发2/2、5视口浏览器及11项隔离反向验证、独立Agent复核；artifactCommit=${artifactCommit}；attemptId=${plan.attemptId} | 无真实数据库、鉴权、AI、生产流量或真人读屏，均不属于本卡 | 可封口候选；metadata后另执行双shell seal、clean与GitHub同步；用户授权止于005 |`;
  const log = read("docs/phase-completion-log.md").toString().trimEnd();
  assert(!log.includes("| Phase005 |"));
  write(
    "docs/phase-completion-log.md",
    `${log}\n${row}\n\nPhase005计划：docs/phase-plans/Phase005.json；唯一Gate：${gatePath}。原始输出、失败attempt与独立复核均保存在docs/evidence/attempts/Phase005/；旧阶段记录保持原字节。\n`,
    false,
  );
  console.warn(
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
    console.warn(
      JSON.stringify({
        status: "PASS",
        reports: result.reports.length,
        independentReview: Boolean(result.review),
      }),
    );
  }
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
}
