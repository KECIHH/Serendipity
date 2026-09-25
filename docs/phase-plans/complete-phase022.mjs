import assert from "node:assert/strict";
import * as runtime from "./phase018-runtime.mjs";
import { audit, businessDenominators, planPath, startCommit } from "./phase022-evidence.mjs";

const { git, hash, json, read, root, scan, write } = runtime;
const plan = json(planPath);
const directory = `docs/evidence/attempts/Phase022/${plan.attemptId}`;
const threshold = businessDenominators.reduce((total, value) => total + value, 0);
const { receipt, quality, reports, review } = audit(plan, { ...runtime, directory }, !process.argv.includes("--without-review"));
if (process.argv.includes("--check")) console.log(JSON.stringify({ status: "PASS", reports: reports.length, review: Boolean(review) }));
else if (process.argv.includes("--metadata")) {
  assert(review);
  assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":!CLAUDE.md"]).trim(), "", "ARTIFACT_DIRTY");
  const artifactCommit = git(["rev-parse", "HEAD"]).trim();
  assert.equal(git(["log", "-1", "--format=%s"]).trim(), "phase(022): artifact", "ARTIFACT_SUBJECT");
  const recovery = git(["rev-list", "--reverse", `${startCommit}..${artifactCommit}^`]).trim();
  const recoveryCommits = recovery ? recovery.split(/\r?\n/) : [];
  const evidenceFiles = git(["ls-files", "--", directory]).trim().split(/\r?\n/).filter(Boolean);
  const inputs = [...new Set([planPath, ...plan.sourcePaths, ...evidenceFiles])].sort().map((file) => ({ path: file, sha256: hash(file) }));
  const results = plan.cases.map((item, index) => ({
    testCaseId: item.testCaseId,
    command: item.command,
    exitCode: 0,
    numerator: item.denominator,
    denominator: item.denominator,
    inputHash: `sha256:${reports[index].inputHash}`,
    outputHash: `sha256:${hash(item.outputPath)}`,
    status: "PASS",
    details: { inputPath: item.inputPath, outputPath: item.outputPath },
  }));
  const gatePath = "docs/evidence/Phase022-gate.json";
  const gate = {
    schemaVersion: "agent-gate-v1",
    phase: 22,
    attemptId: plan.attemptId,
    status: "PASS",
    simulation: true,
    operatorMode: "AGENT_ONLY_AUTOMATED_NEW_BUILD",
    environment: { isolated: true, syntheticUsers: true, providerMode: "mock", productionTraffic: false },
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
      testedTree: git(["rev-parse", `${artifactCommit}^{tree}`]).trim(),
      reviewerRunId: review.reviewerRunId,
      reviewReportPath: `${directory}/review.json`,
      reviewReportHash: hash(`${directory}/review.json`),
      recoveryCommits,
      originalThreshold: threshold,
      automatedThreshold: threshold,
      waived: false,
      requestedThrough: 22,
      nextPhaseExecutionAuthorized: false,
      qualityReportPath: `${directory}/quality.json`,
      qualityReportHash: hash(`${directory}/quality.json`),
      testMode: "full",
      crossAttemptReuse: "disabled",
      validationPolicy: receipt.validationPolicy,
      checkpointMaintenance: receipt.checkpointMaintenance,
      executionPolicy: receipt.executionPolicy,
      executionMaintenance: receipt.executionMaintenance,
      notEvaluated: plan.notApplicable,
    },
  };
  scan(JSON.stringify(gate));
  write(gatePath, gate);
  const state = json("docs/roadmap-run.json");
  assert.equal(state.completedThrough, 21);
  assert.equal(state.currentPhase, 22);
  const checkpoint = { phase: 22, artifactCommit, evidencePath: gatePath, evidenceHash: hash(gatePath) };
  state.completedThrough = 22;
  state.currentPhase = 23;
  state.nextPhaseExecutionAuthorized = false;
  state.lastArtifactCommit = artifactCommit;
  state.currentLayoutPhaseSeal = checkpoint;
  state.checkpoints.push(checkpoint);
  write("docs/roadmap-run.json", state, false);
  const log = read("docs/phase-completion-log.md").toString();
  assert(!log.includes("| Phase022 |"));
  write(
    "docs/phase-completion-log.md",
    `${log.trimEnd()}\n| Phase022 | 旅行概要与 Planner 交接 | TravelPlanSummaryDraft、显式假设和 handoff；时长与目的地由服务端绑定；完整路径/hash见Gate | 固定${threshold}/${threshold}；Vitest ${quality.testCount}/${quality.testCount}；专用${quality.dedicatedCount}断言；${plan.negativeControls.length}项隔离变异及恢复后全卡；PostgreSQL17；schema/typecheck/lint/format/build/layout通过；独立Agent复核；artifactCommit=${artifactCommit}；attemptId=${plan.attemptId} | 无每日行程、TravelPlanVersion、结果页、地图或生产Provider；未执行Phase023 | metadata后双shell seal、clean与GitHub同步；授权止于022 |\n\nPhase022计划：${planPath}；唯一Gate：${gatePath}；原始报告与独立复核：${directory}/。\n`,
    false,
  );
  console.log(JSON.stringify({ status: "METADATA_CANDIDATE_CREATED", artifactCommit, evidenceHash: checkpoint.evidenceHash }));
  void root;
} else throw new Error("Use --check or --metadata");
