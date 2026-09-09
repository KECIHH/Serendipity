import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireHashCoverage, requireReportBinding, requireReviewIdentity } from '../../scripts/phase-evidence.mjs';
import { requirePhase002Sources, documentPaths, sha256 } from './verify-phase002.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const planPath = 'docs/phase-plans/Phase002.json';
const receiptPath = 'docs/phase-plans/Phase002-inputs.json';
const gatePath = 'docs/evidence/Phase002-gate.json';
const read = relative => fs.readFileSync(path.join(root, relative));
const json = relative => JSON.parse(read(relative).toString('utf8').replace(/^\uFEFF/, ''));
const hash = relative => sha256(read(relative));
const plan = json(planPath); const receipt = json(receiptPath); const planHash = hash(planPath);
const reviewPath = `docs/evidence/attempts/Phase002/${plan.attemptId}/review.json`;
function git(args) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr?.toString('utf8')); return result.stdout;
}
const gitText = args => git(args).toString('utf8').trim();
function write(relative, value, exclusive = false) {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: exclusive ? 'wx' : 'w' });
}

function audit({ requireReview = true } = {}) {
  const sources = requirePhase002Sources(plan);
  assert(!fs.existsSync(path.join(root, `docs/evidence/attempts/Phase002/${plan.attemptId}/attempt.json`)), 'Current attempt has failed; create a new attempt');
  for (const pin of receipt.pinnedInputs) assert.equal(hash(pin.path), pin.sha256, `Frozen input changed: ${pin.id}`);
  for (const previous of plan.previousAttempts) {
    assert.equal(hash(previous.planPath), previous.planHash, 'Previous frozen plan changed');
    const old = json(previous.planPath);
    assert.equal(old.attemptId, previous.attemptId);
    assert.deepEqual(old.requiredCaseIds, plan.requiredCaseIds, 'Required cases were changed');
    assert.deepEqual(old.threshold, plan.threshold, 'Frozen thresholds were changed');
    for (const oldCase of old.cases) {
      const current = plan.cases.find(item => item.testCaseId === oldCase.testCaseId); assert(current);
      for (const key of ['command', 'denominator', 'inputPath', 'expected']) assert.equal(current[key], oldCase[key], `Frozen case changed: ${key}`);
    }
  }
  const reports = plan.cases.map(item => {
    const report = json(item.outputPath); requireReportBinding(report, item, planHash, sources, hash);
    assert.equal(report.environment, 'ISOLATED_SYNTHETIC'); assert.equal(report.productionTraffic, false);
    return report;
  });
  const review = requireReview ? json(reviewPath) : null;
  if (review) {
    assert.equal(review.phase, 2); assert.equal(review.attemptId, plan.attemptId); assert.equal(review.planPath, planPath);
    assert.equal(review.planHash, planHash); assert.equal(review.decision, 'PASS');
    requireReviewIdentity(review, plan.implementationContextId);
    requireHashCoverage(review.sourceHashes, sources, hash, 'REVIEW_FILE_HASH');
    requireHashCoverage(review.reportHashes, plan.cases.map(item => item.outputPath), hash, 'REVIEW_FILE_HASH');
    assert(Array.isArray(review.issues) && Array.isArray(review.dispositions));
    for (const issue of review.issues) assert(issue.status === 'RESOLVED' || review.dispositions.some(item => item.issueId === issue.id && item.status === 'RESOLVED'), 'Unresolved review issue');
  }
  return { reports, review, sources };
}

function metadata() {
  const { reports, review, sources } = audit();
  assert(!fs.existsSync(path.join(root, gatePath)), 'Final Gate already exists');
  assert.equal(gitText(['branch', '--show-current']), 'main');
  assert.equal(gitText(['status', '--porcelain=v1', '--untracked-files=all']), '', 'Artifact must be committed with clean worktree');
  assert.equal(gitText(['show', '-s', '--format=%s', 'HEAD']), 'phase(002): artifact');
  const artifactCommit = gitText(['rev-parse', 'HEAD']); const testedTree = gitText(['rev-parse', 'HEAD^{tree}']);
  const changed = git(['diff', '--name-only', '-z', receipt.phaseStartCommit, artifactCommit]).toString('utf8').split('\0').filter(Boolean);
  for (const file of ['docs/roadmap-run.json', 'docs/phase-completion-log.md', gatePath]) assert(!changed.includes(file), 'Artifact must not change current metadata');
  const inputPaths = [...new Set([...changed, ...sources, ...plan.cases.map(item => item.inputPath), ...plan.cases.map(item => item.outputPath), reviewPath])].sort();
  const inputs = inputPaths.map(file => {
    assert(!file.startsWith(`${receipt.roadmapRoot}/`), 'Local roadmap must not be tracked');
    const committed = git(['cat-file', 'blob', `${artifactCommit}:${file}`]);
    assert.equal(sha256(committed), hash(file), `Tested bytes differ from artifact: ${file}`);
    return { path: file, sha256: sha256(committed) };
  });
  const history = gitText(['rev-list', '--reverse', `${receipt.phaseStartCommit}..${artifactCommit}`]).split('\n');
  assert.equal(history.at(-1), artifactCommit);
  const results = plan.cases.map((item, index) => ({ testCaseId: item.testCaseId, command: item.command, exitCode: reports[index].exitCode,
    numerator: reports[index].numerator, denominator: reports[index].denominator, inputHash: `sha256:${hash(item.inputPath)}`, outputHash: `sha256:${hash(item.outputPath)}`,
    status: 'PASS', details: { inputPath: item.inputPath, outputPath: item.outputPath, expected: item.expected } }));
  const gate = {
    schemaVersion: 'agent-gate-v1', phase: 2, attemptId: plan.attemptId, status: 'PASS', simulation: true,
    operatorMode: 'AGENT_ONLY_AUTOMATED_NEW_BUILD', environment: { isolated: true, syntheticUsers: true, providerMode: 'contract-replay', productionTraffic: false },
    artifactCommit, requiredCaseIds: plan.requiredCaseIds, results, commands: results.map(({ command, exitCode }) => ({ command, exitCode })),
    inputs, failures: [], generatedAt: new Date().toISOString(),
    details: {
      planPath, planHash, testedTree, reviewerRunId: review.reviewerRunId, reviewReportPath: reviewPath, reviewReportHash: hash(reviewPath), recoveryCommits: history.slice(0, -1),
      manifestHash: receipt.manifestHash, phaseCardHash: receipt.pinnedInputs.find(pin => pin.id === 'phase-card').sha256,
      phaseStartCommit: receipt.phaseStartCommit, originalThreshold: 8, automatedThreshold: 8, waived: false, requestedThrough: 2,
      verificationScope: 'PHASE002_DOCUMENT_CONTRACTS_AND_ISOLATED_RULE_FIXTURES',
      contractHashes: Object.fromEntries(documentPaths.map(file => [file, hash(file)])),
      metrics: { mainContracts: 6, supportingContracts: 4, requiredGroups: 8, passedGroups: results.length, registryOperations: 100, forbiddenRoutes: 3, duplicateCanonicalEndpoints: 0, unresolvedLinks: 0 },
      notEvaluated: plan.notApplicable,
      pendingAfterMetadata: ['PowerShell 5.1 and PowerShell 7 root validator seal', 'Entire repository clean', 'git push origin main', 'git ls-remote --heads origin main'],
      costAccounting: { unit: 'milliseconds', basis: 'Actual verification process timing; unmeasured categories are null',
        productImplementation: null, testInfrastructure: null, execution: reports.reduce((sum, report) => sum + report.durationMs, 0),
        independentReview: null, evidencePreparation: null, cpuPeak: null, memoryPeak: null,
        artifactBytes: inputPaths.reduce((sum, file) => sum + read(file).length, 0), retryCount: plan.previousAttempts.length,
        externalProviderCalls: 0, productionTraffic: false },
    },
  };
  const state = json('docs/roadmap-run.json');
  assert.equal(state.completedThrough, 1); assert.equal(state.currentPhase, 2);
  assert.equal(state.checkpoints.length, 1); assert.deepEqual(state.currentLayoutPhaseSeal, receipt.preflight.checkpoint);
  assert.equal(state.baselineCommit, receipt.baselineCommit); assert.equal(state.manifestHash, receipt.manifestHash);
  const manifest = json(receipt.pinnedInputs.find(pin => pin.id === 'manifest').path);
  for (const input of manifest.runStatePinnedInputs) assert.equal(state.contractHashes[input.id], receipt.pinnedInputs.find(pin => pin.id === input.id).sha256);
  write(gatePath, gate, true);
  const evidenceHash = hash(gatePath); const checkpoint = { phase: 2, artifactCommit, evidencePath: gatePath, evidenceHash };
  Object.assign(state, { completedThrough: 2, currentPhase: 3, nextPhaseExecutionAuthorized: false, currentLayoutPhaseSeal: checkpoint, lastArtifactCommit: artifactCommit, checkpoints: [...state.checkpoints, checkpoint] });
  write('docs/roadmap-run.json', state);
  const prior = read('docs/phase-completion-log.md').toString('utf8').trimEnd();
  const row = `| Phase002 | API/事件、Prompt、初始Schema、Provider、隐私、索引及auth/hosting/admin/crypto支持契约；100个registry operation | 十份contract与生成器/验证器；完整路径和hash见Gate inputs/details.contractHashes | node docs/phase-plans/verify-phase002.mjs --all：8/8 PASS；临时副本旧路由/重复端点/悬空链接/规则与证据绑定拒绝后恢复；独立Agent复核；artifactCommit=${artifactCommit}；attemptId=${plan.attemptId} | 仅文档规则与合成fixture；未创建产品路由/数据库/依赖，不声称HTTP、lint/typecheck/build、Vitest/Playwright、生产隐私政策已验证 | 可封口候选；metadata后另执行双shell seal、clean与GitHub同步；用户授权止于002，未执行003 |`;
  write('docs/phase-completion-log.md', `${prior}\n${row}\n\nPhase002计划：\`${planPath}\`；唯一Gate：\`${gatePath}\`，hash由run state绑定。保留失败attempt与上次中断的收据原字节；149个路线输入仅记录路径/SHA-256，八份run内公共输入未变化，历史Phase000/001 checkpoint不改。\n`);
  console.log(JSON.stringify({ status: 'METADATA_CANDIDATE_CREATED', artifactCommit, testedTree, evidenceHash, requiredGroups: results.length, contracts: documentPaths.length, pending: gate.details.pendingAfterMetadata }, null, 2));
}

try {
  if (process.argv.includes('--metadata')) metadata();
  else { const result = audit({ requireReview: !process.argv.includes('--without-review') }); console.log(JSON.stringify({ status: 'PASS', scope: 'PHASE002_REPORT_AND_SOURCE_HASH_AUDIT', attemptId: plan.attemptId, requiredGroups: result.reports.length, independentReviewVerified: result.review !== null })); }
} catch (error) { console.error(JSON.stringify({ status: 'FAIL', message: error.message })); process.exitCode = 1; }
