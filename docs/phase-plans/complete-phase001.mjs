import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireEvidenceSources, requireHashCoverage, requireReviewIdentity, requireReportBinding } from '../../scripts/phase-evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const local = (relative) => path.join(root, relative);
const bytes = (relative) => fs.readFileSync(local(relative));
const parse = (value) => JSON.parse(value.toString('utf8').replace(/^\uFEFF/, ''));
const json = (relative) => parse(bytes(relative));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
function git(args) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString('utf8'));
  return result.stdout;
}
const gitText = (args) => git(args).toString('utf8').trim();
function write(relative, value) {
  fs.mkdirSync(path.dirname(local(relative)), { recursive: true });
  fs.writeFileSync(local(relative), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}
const planPath = 'docs/phase-plans/Phase001.json';
const plan = json(planPath);
const planHash = sha256(bytes(planPath));
const receiptPath = 'docs/phase-plans/Phase001-inputs.json';
const receipt = json(receiptPath);
const reviewPath = `docs/evidence/attempts/Phase001/${plan.attemptId}/review.json`;
const gatePath = 'docs/evidence/Phase001-gate.json';

function audit({ requireReview = true } = {}) {
  assert.equal(plan.phase, 1);
  assert.equal(plan.requestedThrough, 1);
  assert.deepEqual(plan.cases.map((item) => item.testCaseId), plan.requiredCaseIds);
  assert.equal(new Set(plan.requiredCaseIds).size, plan.requiredCaseIds.length);
  assert.equal(plan.threshold.originalThreshold, plan.threshold.automatedThreshold);
  assert.equal(plan.threshold.waived, false);
  const sources = requireEvidenceSources(plan);
  const hashFile = (relative) => sha256(bytes(relative));
  assert(!fs.existsSync(local(`docs/evidence/attempts/Phase001/${plan.attemptId}/attempt.json`)), 'Current attempt has a failure; create a new attempt and rerun');
  for (const pin of receipt.pinnedInputs) assert.equal(sha256(bytes(pin.path)), pin.sha256, `Frozen input changed: ${pin.id}`);
  for (const previous of plan.previousAttempts) {
    assert.equal(sha256(bytes(previous.planPath)), previous.planHash, 'Previous plan changed');
    const old = json(previous.planPath);
    assert.equal(old.attemptId, previous.attemptId);
    for (const oldCase of old.cases) {
      const current = plan.cases.find((item) => item.testCaseId === oldCase.testCaseId);
      assert(current);
      for (const key of ['command', 'denominator', 'inputPath', 'expected']) assert.equal(current[key], oldCase[key], `Frozen case changed: ${key}`);
    }
  }
  const reports = plan.cases.map((item) => {
    const report = json(item.outputPath);
    assert.equal(report.status, 'PASS');
    assert.equal(report.exitCode, 0);
    assert.equal(report.testCaseId, item.testCaseId);
    assert.equal(report.command, item.command);
    assert.equal(report.planHash, planHash, `Report plan hash changed: ${item.testCaseId}`);
    assert.equal(report.denominator, item.denominator);
    assert.equal(report.numerator, item.denominator);
    assert.equal(report.inputHash, sha256(bytes(item.inputPath)));
    requireReportBinding(report, item, planHash, sources, hashFile);
    return report;
  });
  const review = requireReview ? json(reviewPath) : null;
  if (review) {
    assert.equal(review.decision, 'PASS');
    assert.equal(review.planHash, planHash);
    assert.equal(review.phase, 1);
    assert.equal(review.attemptId, plan.attemptId);
    assert.equal(review.runnerIdentity.implementationAuthored, false);
    requireReviewIdentity(review, plan.implementationContextId);
    assert(review.contextId && review.reviewerRunId);
    assert(review.issues.every((issue) => issue.status === 'RESOLVED' || review.dispositions.some((entry) => entry.issueId === issue.id && entry.status === 'RESOLVED')));
    requireHashCoverage(review.sourceHashes, sources, hashFile, 'REVIEW_FILE_HASH');
    requireHashCoverage(review.reportHashes, plan.cases.map((item) => item.outputPath), hashFile, 'REVIEW_FILE_HASH');
  }
  return { reports, review };
}

function metadata() {
  const { reports, review } = audit();
  assert(!fs.existsSync(local(gatePath)), 'Final Gate already exists');
  assert.equal(gitText(['branch', '--show-current']), 'main');
  assert.equal(gitText(['status', '--porcelain=v1', '--untracked-files=all']), '', 'Artifact must be committed with a clean worktree');
  assert.equal(gitText(['show', '-s', '--format=%s', 'HEAD']), 'phase(001): artifact');
  const artifactCommit = gitText(['rev-parse', 'HEAD']);
  const testedTree = gitText(['rev-parse', 'HEAD^{tree}']);
  const changed = git(['diff', '--name-only', '-z', receipt.baselineCommit, artifactCommit]).toString('utf8').split('\0').filter(Boolean);
  const forbidden = ['docs/roadmap-run.json', 'docs/phase-completion-log.md', gatePath];
  assert(!changed.some((relative) => forbidden.includes(relative)), 'Artifact changed metadata');
  const inputPaths = [...new Set([...changed, ...plan.cases.map((item) => item.inputPath), planPath, receiptPath, reviewPath])].sort();
  const inputs = inputPaths.map((relative) => {
    assert(!relative.startsWith(`${receipt.roadmapRoot}/`), 'Local roadmap must not enter Gate artifact inputs');
    const committed = git(['cat-file', 'blob', `${artifactCommit}:${relative}`]);
    assert.equal(sha256(bytes(relative)), sha256(committed), `Artifact bytes differ from tested worktree: ${relative}`);
    return { path: relative, sha256: sha256(committed) };
  });
  const history = gitText(['rev-list', '--reverse', `${receipt.baselineCommit}..${artifactCommit}`]).split('\n');
  const recoveryCommits = history.slice(0, -1);
  const results = plan.cases.map((item, index) => ({
    testCaseId: item.testCaseId, command: item.command, exitCode: reports[index].exitCode,
    numerator: reports[index].numerator, denominator: reports[index].denominator,
    inputHash: `sha256:${sha256(bytes(item.inputPath))}`, outputHash: `sha256:${sha256(bytes(item.outputPath))}`,
    status: 'PASS', details: { inputPath: item.inputPath, outputPath: item.outputPath, expected: item.expected },
  }));
  const gate = {
    schemaVersion: 'agent-gate-v1', phase: 1, attemptId: plan.attemptId, status: 'PASS', simulation: true,
    operatorMode: 'AGENT_ONLY_AUTOMATED_NEW_BUILD',
    environment: { isolated: true, syntheticUsers: true, providerMode: 'contract-replay', productionTraffic: false },
    artifactCommit, requiredCaseIds: plan.requiredCaseIds, results,
    commands: results.map(({ command, exitCode }) => ({ command, exitCode })), inputs, failures: [], generatedAt: new Date().toISOString(),
    details: {
      planPath, planHash, testedTree, reviewerRunId: review.reviewerRunId, reviewReportPath: reviewPath, reviewReportHash: sha256(bytes(reviewPath)), recoveryCommits,
      manifestHash: receipt.manifestHash, phaseCardHash: receipt.pinnedInputs.find((input) => input.id === 'phase-card').sha256,
      originalThreshold: plan.threshold.originalThreshold, automatedThreshold: plan.threshold.automatedThreshold, waived: false,
      verificationScope: 'PHASE001_DOCUMENTS_ROOT_LAYOUT_AND_ISOLATED_CHECKPOINT', requestedThrough: 1,
      m0ContractCoverage: { numerator: 20, denominator: 20 }, prohibitedModelDefinitions: 0,
      notEvaluated: plan.notApplicable,
      pendingAfterMetadata: ['PowerShell 5.1 and 7 root validator seal', 'Entire repository clean', 'git push origin main', 'git ls-remote --heads origin main'],
      costAccounting: {
        unit: 'milliseconds', basis: 'Actual monotonic verification process timing; other categories unmeasured',
        productImplementation: null, testInfrastructure: null, execution: reports.reduce((sum, report) => sum + report.durationMs, 0),
        independentReview: null, evidencePreparation: null, cpuPeak: null, memoryPeak: null,
        artifactBytes: inputPaths.reduce((sum, relative) => sum + bytes(relative).length, 0), retryCount: plan.previousAttempts.length,
        externalProviderCalls: 0, productionTraffic: false,
      },
    },
  };
  write(gatePath, gate);
  const evidenceHash = sha256(bytes(gatePath));
  const checkpoint = { phase: 1, artifactCommit, evidencePath: gatePath, evidenceHash };
  const state = json('docs/roadmap-run.json');
  assert.equal(state.completedThrough, 0);
  const manifest = json(receipt.pinnedInputs.find((input) => input.id === 'manifest').path);
  const contractHashes = Object.fromEntries(manifest.runStatePinnedInputs.map((input) => [input.id, receipt.pinnedInputs.find((pin) => pin.id === input.id).sha256]));
  Object.assign(state, {
    completedThrough: 1, currentPhase: 2, progressSource: 'CURRENT_LAYOUT_CHECKPOINT', nextPhaseExecutionAuthorized: false,
    currentLayoutPhaseSeal: checkpoint, baselineCommit: receipt.baselineCommit, executionBaselineCommit: receipt.executionBaselineCommit,
    manifestHash: receipt.manifestHash, contractHashes, lastArtifactCommit: artifactCommit, checkpoints: [checkpoint],
  });
  state.nextRun.baselineCommit = receipt.baselineCommit;
  write('docs/roadmap-run.json', state);
  const priorLog = bytes('docs/phase-completion-log.md').toString('utf8').trimEnd();
  const row = `| Phase001 | Git/代码/UI/数据库四份可执行规范；根布局校验和历史导入；66个持久模型唯一登记 | docs/git-workflow.md、docs/code-style.md、docs/ui-design-system.md、docs/database.md；完整文件与报告见Gate inputs | node docs/phase-plans/verify-phase001.mjs --all：${reports.length}/${plan.cases.length} PASS，M0 20/20，十组件状态及对比度，12组原文档反向及新增契约/证据反向；旧Phase000双shell映射重放与错误映射拒绝；根checkpoint双shell回归；artifactCommit=${artifactCommit}；attemptId=${plan.attemptId} | 本阶段不创建npm脚本、业务代码、Prisma或浏览器页面；产品lint/typecheck/test/build未到生产阶段 | 可封口候选；metadata后另执行双shell seal、clean及GitHub同步；用户授权止于001，未执行002 |`;
  write('docs/phase-completion-log.md', `${priorLog}\n${row}\n\nPhase001计划：\`${planPath}\`；唯一Gate：\`${gatePath}\`，hash由run state checkpoint绑定。失败attempt与基础设施诊断均保留；历史Phase000原始文件、hash和提交不改。历史绝对路径只在隔离反序列化入口精确映射，旧validator源文件与Git对象保持原字节，错误映射仍被两个shell拒绝。\n`);
  console.log(JSON.stringify({ status: 'METADATA_CANDIDATE_CREATED', artifactCommit, testedTree, evidenceHash, requiredCases: results.length, pending: gate.details.pendingAfterMetadata }, null, 2));
}

try {
  if (process.argv.includes('--metadata')) metadata();
  else {
    const result = audit({ requireReview: !process.argv.includes('--without-review') });
    console.log(JSON.stringify({ status: 'PASS', scope: 'PHASE001_REPORT_AND_SOURCE_HASH_AUDIT', attemptId: plan.attemptId, requiredCases: result.reports.length, independentReviewVerified: result.review !== null }));
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', error: error.message }));
  process.exitCode = 1;
}
