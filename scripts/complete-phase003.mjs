import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireHashCoverage, requireReportBinding, requireReviewIdentity } from './phase-evidence.mjs';
import { requirePhase003Artifacts, requirePhase003Bootstrap, requirePhase003EvidenceFixture, requirePhase003SupportingCommands, requirePhase003SupplementalHashes } from './phase003-evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planPath = 'docs/phase-plans/Phase003.json';
const receiptPath = 'docs/phase-plans/Phase003-inputs.json';
const gatePath = 'docs/evidence/Phase003-gate.json';
const read = (file) => fs.readFileSync(path.join(root, file));
const json = (file) => JSON.parse(read(file));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hash = (file) => sha(read(file));
const plan = json(planPath);
const receipt = json(receiptPath);
const directory = `docs/evidence/attempts/Phase003/${plan.attemptId}`;
const reviewPath = `${directory}/review.json`;
const failedPath = `${directory}/attempt.json`;
const npmCli = path.join(root, '.scaffold/tools/node_modules/npm/bin/npm-cli.js');

function write(file, value, exclusive = true) {
  const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: exclusive ? 'wx' : 'w' });
}

function git(args) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString()); return result.stdout;
}
const gitText = (args) => git(args).toString().trim();

function audit(requireReview = true) {
  assert(!fs.existsSync(path.join(root, failedPath)), 'This attempt failed; create a new attempt');
  for (const pin of receipt.pinnedInputs) assert.equal(hash(pin.path), pin.sha256, `Pinned input changed: ${pin.id}`);
  assert.equal(plan.requiredCaseIds.length, 17); assert.equal(plan.cases.length, 17);
  assert.deepEqual(plan.requiredCaseIds, plan.cases.map((item) => item.testCaseId));
  for (const previous of plan.previousAttempts) {
    assert.equal(hash(previous.planPath), previous.planHash);
    const old = json(previous.planPath); assert.deepEqual(old.requiredCaseIds, plan.requiredCaseIds); assert.deepEqual(old.threshold, plan.threshold);
    for (const item of old.cases) for (const key of ['command', 'denominator', 'inputPath', 'expected']) assert.equal(plan.cases.find((current) => current.testCaseId === item.testCaseId)[key], item[key]);
  }
  const reports = plan.cases.map((item) => { const report = json(item.outputPath); requireReportBinding(report, item, hash(planPath), plan.sourcePaths, hash); assert.equal(report.productionTraffic, false); return report; });
  requirePhase003Artifacts(reports, hash, directory);
  requirePhase003Bootstrap(json('docs/evidence/attempts/Phase003/setup/bootstrap.json'), { hashFile: hash, readJson: json });
  requirePhase003EvidenceFixture(plan.evidenceRegressionFixture, { hashFile: hash, readJson: json });
  const support = json(`${directory}/supporting-commands.json`);
  assert.equal(support.status, 'PASS'); requireHashCoverage(support.sourceHashes, plan.sourcePaths, hash, 'SUPPORT_SOURCE_HASH');
  requirePhase003SupportingCommands(support, { plan, directory, reports, readJson: json });
  const review = requireReview ? json(reviewPath) : null;
  if (review) {
    assert.equal(review.phase, 3); assert.equal(review.attemptId, plan.attemptId); assert.equal(review.planPath, planPath); assert.equal(review.planHash, hash(planPath)); assert.equal(review.decision, 'PASS');
    requireReviewIdentity(review, plan.implementationContextId);
    requireHashCoverage(review.sourceHashes, plan.sourcePaths, hash, 'REVIEW_SOURCE_HASH');
    requireHashCoverage(review.reportHashes, plan.cases.map((item) => item.outputPath), hash, 'REVIEW_REPORT_HASH');
    requirePhase003SupplementalHashes(review, hash);
    assert(Array.isArray(review.issues) && Array.isArray(review.dispositions));
    for (const issue of review.issues) assert(issue.status === 'RESOLVED' || review.dispositions.some((entry) => entry.issueId === issue.id && entry.status === 'RESOLVED'));
  }
  return { reports, review, support };
}

function runAll() {
  assert(!fs.existsSync(path.join(root, failedPath)), 'Cannot run a failed attempt; retry first');
  const sources = Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(file)]));
  const commands = [];
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', CI: '1', NPM_CONFIG_USERCONFIG: path.join(root, '.scaffold/tools/npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(root, '.scaffold/tools/global-npmrc'), NPM_CONFIG_CACHE: path.join(root, '.scaffold/tools/cache') };
  delete env.NEXT_PRIVATE_TEST_VERSION;
  const run = (command, args) => {
    const started = performance.now();
    const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 1_200_000, maxBuffer: 64 * 1024 * 1024 });
    const record = { command, exitCode: result.status, durationMs: Math.round(performance.now() - started), stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message ?? null };
    commands.push(record);
    write(`${directory}/command-${String(commands.length).padStart(2, '0')}.json`, record);
    console.log(JSON.stringify({ command, exitCode: result.status, durationMs: record.durationMs }));
    assert.equal(result.status, 0, `${command}: ${record.stdout}\n${record.stderr}`);
  };
  try {
    run('npm audit --omit=dev --audit-level=high --json', [npmCli, 'audit', '--omit=dev', '--audit-level=high', '--json']);
    for (const name of ['lint', 'build', 'typecheck', 'verify:phase003']) run(`npm run ${name}`, [npmCli, 'run', name]);
    for (const item of plan.cases) run(item.command, ['scripts/verify-phase003.mjs', '--case', item.testCaseId.slice('Phase003:'.length)]);
    // Dev-server checks replace .next; leave the real workspace with usable
    // production output and recheck the nine consumers against that build.
    run('npm run build', [npmCli, 'run', 'build']);
    run('npm run verify:phase003', [npmCli, 'run', 'verify:phase003']);
    requireHashCoverage(sources, plan.sourcePaths, hash, 'STABLE_RUN_SOURCE');
    write(`${directory}/supporting-commands.json`, { status: 'PASS', sourceHashes: sources, commands, actualCaseCount: 17, productionTraffic: false });
    audit(false);
    console.log(JSON.stringify({ status: 'PASS', cases: 17, attemptId: plan.attemptId, independentReviewPending: true }));
  } catch (error) {
    if (!fs.existsSync(path.join(root, failedPath))) write(failedPath, { phase: 3, attemptId: plan.attemptId, status: 'FAIL', artifactCommit: null, failure: error.message, commands, sourceHashes: sources, planHash: hash(planPath), generatedAt: new Date().toISOString() });
    throw error;
  }
}

function retry() {
  assert(fs.existsSync(path.join(root, failedPath)), 'Retry requires a recorded failure');
  const frozen = `${directory}/frozen-plan.json`; write(frozen, read(planPath).toString());
  const previous = { attemptId: plan.attemptId, planPath: frozen, planHash: hash(planPath) };
  plan.previousAttempts.push(previous); plan.attemptId = `attempt-${Number(plan.attemptId.split('-').at(-1)) + 1}`;
  for (const item of plan.cases) item.outputPath = item.outputPath.replace(`/${previous.attemptId}/`, `/${plan.attemptId}/`);
  write(planPath, plan, false); console.log(JSON.stringify({ attemptId: plan.attemptId, preservedPlanHash: previous.planHash, cases: plan.cases.length }));
}

function metadata() {
  const { reports, review, support } = audit();
  assert(!fs.existsSync(path.join(root, gatePath)), 'Final Gate already exists');
  assert.equal(gitText(['status', '--porcelain=v1', '-uall']), '', 'Artifact must have a clean worktree');
  assert.equal(gitText(['show', '-s', '--format=%s', 'HEAD']), 'phase(003): artifact');
  assert.equal(gitText(['branch', '--show-current']), 'main');
  const artifactCommit = gitText(['rev-parse', 'HEAD']); const testedTree = gitText(['rev-parse', 'HEAD^{tree}']);
  const migration = json(receipt.checkpointMigration.path);
  const changed = git(['diff', '--name-only', '-z', migration.currentMetadataCommit, artifactCommit]).toString().split('\0').filter(Boolean);
  for (const file of ['docs/roadmap-run.json', 'docs/phase-completion-log.md', gatePath]) assert(!changed.includes(file), 'Artifact changed current metadata');
  const inputPaths = [...new Set([...changed, ...plan.sourcePaths, ...plan.cases.map((item) => item.inputPath), ...plan.cases.map((item) => item.outputPath), reviewPath])].sort();
  const inputs = inputPaths.map((file) => { assert(!file.startsWith(`${receipt.roadmapRoot}/`)); const bytes = git(['cat-file', 'blob', `${artifactCommit}:${file}`]); assert.equal(sha(bytes), hash(file), `Artifact bytes differ: ${file}`); return { path: file, sha256: sha(bytes) }; });
  const history = gitText(['rev-list', '--reverse', `${migration.currentMetadataCommit}..${artifactCommit}`]).split('\n');
  assert.equal(history.at(-1), artifactCommit);
  const results = plan.cases.map((item, index) => ({ testCaseId: item.testCaseId, command: item.command, exitCode: reports[index].exitCode, numerator: reports[index].numerator, denominator: item.denominator, inputHash: `sha256:${hash(item.inputPath)}`, outputHash: `sha256:${hash(item.outputPath)}`, status: 'PASS', details: { inputPath: item.inputPath, outputPath: item.outputPath, expected: item.expected } }));
  const gate = { schemaVersion: 'agent-gate-v1', phase: 3, attemptId: plan.attemptId, status: 'PASS', simulation: true, operatorMode: 'AGENT_ONLY_AUTOMATED_NEW_BUILD', environment: { isolated: true, syntheticUsers: true, providerMode: 'local-adapter', productionTraffic: false }, artifactCommit, requiredCaseIds: plan.requiredCaseIds, results, commands: results.map(({ command, exitCode }) => ({ command, exitCode })), inputs, failures: [], generatedAt: new Date().toISOString(), details: { planPath, planHash: hash(planPath), testedTree, reviewerRunId: review.reviewerRunId, reviewReportPath: reviewPath, reviewReportHash: hash(reviewPath), recoveryCommits: history.slice(0, -1), originalThreshold: 17, automatedThreshold: 17, waived: false, requestedThrough: 3, manifestHash: receipt.manifestHash, phaseStartCommit: receipt.phaseStartCommit, runtimeBaselinePath: 'docs/runtime-baseline.json', runtimeBaselineHash: hash('docs/runtime-baseline.json'), checkpointMigration: receipt.checkpointMigration, supportingCommandsPath: `${directory}/supporting-commands.json`, supportingCommandsHash: hash(`${directory}/supporting-commands.json`), notEvaluated: plan.notApplicable, pendingAfterMetadata: ['PowerShell 5.1 and PowerShell 7 CompletedThrough=3 seal', 'Clean worktree', 'Push and verify origin/main'], costAccounting: { unit: 'milliseconds', execution: support.commands.reduce((total, record) => total + record.durationMs, 0), productImplementation: null, testInfrastructure: null, independentReview: null, evidencePreparation: null, cpuPeak: null, memoryPeak: null, measurementStatus: 'EXECUTION_MEASURED_OTHER_CATEGORIES_UNMEASURED', artifactBytes: inputPaths.reduce((total, file) => total + read(file).length, 0), retries: plan.previousAttempts.length, externalProviderCalls: 0, productionTraffic: false } } };
  const state = json('docs/roadmap-run.json'); assert.equal(state.completedThrough, 2); assert.equal(state.currentPhase, 3); assert.deepEqual(state.currentLayoutPhaseSeal, receipt.preflight.checkpoint);
  write(gatePath, gate);
  const checkpoint = { phase: 3, artifactCommit, evidencePath: gatePath, evidenceHash: hash(gatePath) };
  Object.assign(state, { completedThrough: 3, currentPhase: 4, nextPhaseExecutionAuthorized: false, lastArtifactCommit: artifactCommit, currentLayoutPhaseSeal: checkpoint, checkpoints: [...state.checkpoints, checkpoint], checkpointMigration: receipt.checkpointMigration });
  write('docs/roadmap-run.json', state, false);
  const row = `| Phase003 | Next.js脚手架、固定运行版本、shadcn Button、10个样式令牌、中文基础首页与安全依赖修复 | 根配置、src、public、scripts及runtime baseline；完整路径/hash见Gate inputs | lint/build/typecheck/verify退出0；17/17自动断言、反向/浏览器/隔离安装回归及独立Agent复核；artifactCommit=${artifactCommit}；attemptId=${plan.attemptId} | 未执行Phase004、数据库、鉴权、AI、真人读屏或生产流量 | 可封口候选；metadata后另执行双shell seal、clean和GitHub同步；用户授权止于003 |`;
  write('docs/phase-completion-log.md', `${read('docs/phase-completion-log.md').toString().trimEnd()}\n${row}\n\nPhase003计划：\`${planPath}\`；唯一Gate：\`${gatePath}\`。失败attempt与检查点迁移证据保留原字节；未推进Phase004实现。\n`, false);
  console.log(JSON.stringify({ status: 'METADATA_CANDIDATE_CREATED', artifactCommit, testedTree, evidenceHash: checkpoint.evidenceHash, cases: 17 }));
}

try {
  if (process.argv.includes('--retry')) retry();
  else if (process.argv.includes('--run-all')) runAll();
  else if (process.argv.includes('--metadata')) metadata();
  else { audit(!process.argv.includes('--without-review')); console.log(JSON.stringify({ status: 'PASS', scope: 'PHASE003_SOURCE_REPORT_AUDIT', attemptId: plan.attemptId })); }
} catch (error) { console.error(error.stack); process.exitCode = 1; }
