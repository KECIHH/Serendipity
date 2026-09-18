import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { auditEvidence, requireArtifactParent } from "./phase018-evidence.mjs";
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
  npmCli,
  scan,
} from "./phase018-runtime.mjs";

const reviewPath = `${directory}/review.json`;
const qualityPath = `${directory}/quality.json`;
const gatePath = "docs/evidence/Phase018-gate.json";

function audit(withReview = true) {
  assert(!fs.existsSync(path.join(root, directory, "attempt.json")), "FAILED_ATTEMPT_CANNOT_SEAL");
  return auditEvidence(
    plan,
    { root, planPath, receiptPath, directory, readJson: json, readBytes: read, hashFile: hash, git, npmCli },
    withReview,
  );
}

function metadata() {
  const { receipt, reports, quality, review } = audit();
  const artifactCommit = git(["rev-parse", "HEAD"]).trim();
  assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all"]).trim(), "", "ARTIFACT_MUST_BE_CLEAN");
  requireArtifactParent(
    {
      artifactCommit,
      phaseStartCommit: receipt.phaseStartCommit,
      recoveryParents: plan.previousAttempts
        .flatMap((attempt) => [attempt.artifactCommit, attempt.metadataCommit])
        .filter(Boolean),
    },
    git,
  );
  const testedTree = git(["rev-parse", `${artifactCommit}^{tree}`]).trim();
  const inputPaths = [
    ...new Set([
      planPath,
      ...plan.sourcePaths,
      ...plan.cases.map((item) => item.outputPath),
      reviewPath,
      qualityPath,
      ...quality.artifacts.map((row) => row.path),
    ]),
  ];
  const inputs = inputPaths.map((file) => {
    assert.equal(sha(git(["show", `${artifactCommit}:${file}`], null)), hash(file), `ARTIFACT_BLOB:${file}`);
    return { path: file, sha256: hash(file) };
  });
  const results = plan.cases.map((item, index) => ({
    testCaseId: item.testCaseId,
    command: item.command,
    exitCode: reports[index].exitCode,
    numerator: reports[index].numerator,
    denominator: reports[index].denominator,
    inputHash: `sha256:${reports[index].inputHash}`,
    outputHash: `sha256:${hash(item.outputPath)}`,
    status: "PASS",
    details: { inputPath: item.inputPath, outputPath: item.outputPath },
  }));
  const gate = {
    schemaVersion: "agent-gate-v1",
    phase: 18,
    attemptId: plan.attemptId,
    status: "PASS",
    simulation: true,
    operatorMode: "AGENT_ONLY_AUTOMATED_NEW_BUILD",
    environment: {
      isolated: true,
      syntheticUsers: true,
      providerMode: "mock",
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
      recoveryCommits: [],
      originalThreshold: 8,
      automatedThreshold: 8,
      waived: false,
      requestedThrough: 18,
      nextPhaseExecutionAuthorized: false,
      qualityReportPath: qualityPath,
      qualityReportHash: hash(qualityPath),
      manifestHash: receipt.manifestHash,
      schemaPath: "prisma/schema.prisma",
      schemaHash: quality.schemaHash,
      promptVersionHash: quality.promptVersionHash,
      fixtureHash: quality.fixtureHash,
      testMode: "full",
      crossAttemptReuse: "disabled",
      validationPolicy: receipt.validationPolicy,
      checkpointMaintenance: receipt.checkpointMaintenance,
      executionPolicy: receipt.executionPolicy,
      executionMaintenance: receipt.executionMaintenance,
      database: quality.database,
      fixtureMatrix: quality.fixtures,
      actualCommandExitCodes: quality.observations.map(({ command, exitCode, timedOut }) => ({
        command,
        exitCode,
        timedOut,
      })),
      secretScan: quality.scan,
      costAccounting: quality.costAccounting,
      notEvaluated: plan.notApplicable,
      milestoneReportPath: "docs/milestone-gate-m4.md",
      milestoneReportHash: hash("docs/milestone-gate-m4.md"),
      aiDebugDocPath: "docs/ai-debug.md",
      aiDebugDocHash: hash("docs/ai-debug.md"),
    },
  };
  scan(JSON.stringify(gate));
  const existingGatePath = path.join(root, gatePath);
  if (fs.existsSync(existingGatePath)) {
    const existingGate = json(gatePath);
    assert.equal(existingGate.phase, 18);
    assert(
      plan.previousAttempts.some(
        (attempt) =>
          attempt.artifactCommit === existingGate.artifactCommit && attempt.metadataCommit,
      ),
      "REPLACED_GATE_MUST_BE_FAILED_ATTEMPT",
    );
  }
  write(gatePath, gate, false);
  const checkpoint = { phase: 18, artifactCommit, evidencePath: gatePath, evidenceHash: hash(gatePath) };
  const state = json("docs/roadmap-run.json");
  assert.equal(state.completedThrough, 17);
  assert.equal(state.currentPhase, 18);
  state.completedThrough = 18;
  state.currentPhase = 19;
  state.nextPhaseExecutionAuthorized = false;
  state.lastArtifactCommit = artifactCommit;
  state.currentLayoutPhaseSeal = checkpoint;
  state.checkpoints.push(checkpoint);
  write("docs/roadmap-run.json", state, false);
  const log = read("docs/phase-completion-log.md").toString().trimEnd();
  assert(!log.includes("| Phase018 |"));
  write(
    "docs/phase-completion-log.md",
    `${log}\n| Phase018 | Mock Provider、AI 调试与 M4 Gate | 唯一 MockAiProvider 固定故障矩阵、AiDebugRun 迁移、AI_DEBUG 任务、管理员调试页与三个 Route Handler、安全调试 DTO、八组故障注入与五项反向控制；完整路径/hash 见 Gate | 固定 8/8；Vitest ${quality.testCount}/${quality.testCount}；专用 ${quality.dedicatedCount} 断言；5 项反向控制及恢复后八组重跑；真实 PostgreSQL 17/11 份迁移；debug 正式计划写入 0、Mock 网络调用 0；lint/typecheck/format/build/layout/证据自检/路由扫描；独立 Agent 复核；artifactCommit=${artifactCommit}；attemptId=${plan.attemptId} | 未执行正式方案版本、真实 Provider 适配器、生产流量或真实凭据；rawOutput 维持数据库强制 null，调试捕获只在受限内存与安全 DTO 中 | metadata 后双 shell seal、clean 和 GitHub 同步；授权止于 018 |\n\nPhase018 计划：${planPath}；唯一 Gate：${gatePath}；原始报告与独立复核：docs/evidence/attempts/Phase018/。\n`,
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
    const value = audit(!process.argv.includes("--without-review"));
    console.log(JSON.stringify({ status: "PASS", reports: value.reports.length, independentReview: !!value.review }));
  } else if (process.argv.includes("--metadata")) metadata();
  else throw new Error("Use --check or --metadata");
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
}
