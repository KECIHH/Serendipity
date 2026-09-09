import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importPath = 'docs/checkpoint-migrations/history-20260909.json';
const planPath = 'docs/phase-plans/Phase003-checkpoint-recovery.json';
const read = (root, file) => fs.readFileSync(path.join(root, file));
const json = (root, file) => JSON.parse(read(root, file));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const plan = json(sourceRoot, planPath);
const receipt = json(sourceRoot, importPath);
const temporaryParent = fs.realpathSync(os.tmpdir());
const temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, 'serendipity-checkpoint-import-'));
const root = path.join(temporaryRoot, 'repository');
const outputArgument = process.argv.indexOf('--output');
const output = outputArgument === -1 ? path.join(sourceRoot, '.scaffold/checkpoint-import-tests.json') : path.resolve(process.argv[outputArgument + 1]);
const observations = [];
const cases = [];
const startedAt = new Date().toISOString();
const start = performance.now();
function command(cwd, executable, args, expectedExit) {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  delete env.PSModulePath;
  const result = spawnSync(executable, args, { cwd, env, windowsHide: true, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (expectedExit !== undefined) assert.equal(result.status, expectedExit, `${executable} ${args.join(' ')}: ${result.stderr?.toString('utf8')}`);
  return result;
}
const git = (args, expectedExit = 0) => command(root, 'git', ['-c', 'core.quotepath=false', ...args], expectedExit).stdout.toString('utf8').trim();
function write(file, bytes) {
  const target = path.resolve(root, file);
  assert(target.startsWith(`${path.resolve(root)}${path.sep}`));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}
function commit() {
  git(['add', '--all']); git(['diff', '--cached', '--check']); git(['commit', '-m', 'phase(003): recovery']);
  return git(['rev-parse', 'HEAD']);
}
function validate(label, diagnostic = '') {
  for (const executable of ['powershell.exe', 'pwsh.exe']) {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/validate-phase.ps1', '-CompletedThrough', '2', '-Strict', '-Json'];
    const result = command(root, executable, args);
    const output = `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`.trim();
    const parsed = JSON.parse(output);
    observations.push({ case: label, executable, arguments: args, exitCode: result.status, expectedDiagnostic: diagnostic || null, output: parsed });
    if (diagnostic) {
      assert.equal(result.status, 1, `${label}: expected rejection`);
      assert.equal(parsed.status, 'FAIL'); assert(parsed.error.includes(diagnostic), `${label}: ${parsed.error}`);
    } else {
      assert.equal(result.status, 0, `${label}: ${output}`);
      assert.equal(parsed.status, 'PASS'); assert.equal(parsed.completedThrough, 2);
      assert.equal(parsed.checkpointImport.admissionOnly, true);
      assert.equal(parsed.checkpointImport.sha256, hash(read(sourceRoot, importPath)));
      assert.equal(parsed.metadataCommit, receipt.currentMetadataCommit);
    }
  }
}
function mutation(name, file, change, diagnostic) {
  const original = read(root, file);
  try { write(file, change(original)); validate(name, diagnostic); cases.push({ name, status: 'PASS' }); }
  finally { write(file, original); }
}
function mutateJson(bytes, change) { const value = JSON.parse(bytes); change(value); return `${JSON.stringify(value, null, 2)}\n`; }
let failure = null;
try {
  command(temporaryRoot, 'git', ['clone', '--no-local', '--no-checkout', sourceRoot, root], 0);
  git(['checkout', 'main']);
  for (const [key, value] of [['user.name', 'Serendipity Import Fixture'], ['user.email', 'fixture@serendipity.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false'], ['core.safecrlf', 'false'], ['core.hooksPath', '.git/hooks']]) git(['config', '--local', key, value]);
  git(['remote', 'set-url', 'origin', receipt.preflight.remote]);
  const missingOriginal = command(root, 'git', ['cat-file', '-e', receipt.originalMetadataCommit]);
  assert.notEqual(missingOriginal.status, 0, 'The clean clone must not receive removed original history');
  const candidates = ['docs/agent-execution-contract.md', importPath, planPath, 'scripts/checkpoint-history.mjs', 'scripts/prepare-checkpoint-import.mjs', 'scripts/test-checkpoint-import.mjs', 'scripts/check-project-layout.mjs', 'scripts/validate-phase.mjs', 'scripts/test-validate-phase.mjs'];
  for (const file of candidates) write(file, read(sourceRoot, file));
  const pinnedPaths = new Set([1, 2].flatMap((phase) => json(sourceRoot, `docs/phase-plans/Phase00${phase}-inputs.json`).pinnedInputs.map((input) => input.path)));
  for (const file of pinnedPaths) write(file, read(sourceRoot, file));
  write(receipt.localHistory.bundlePath, read(sourceRoot, receipt.localHistory.bundlePath));
  const cleanHead = commit();
  validate('both-shell-positive-admission-from-clean-clone');
  cases.push(...plan.requiredCases.slice(0, 7).map((name) => ({ name, status: 'PASS' })));
  mutation('reject-incorrect-commit-map', importPath, (bytes) => mutateJson(bytes, (r) => { r.pairs[6].current = cleanHead; }), 'IMPORT_CURRENT_PARENT');
  mutation('reject-changed-tree', importPath, (bytes) => mutateJson(bytes, (r) => { r.pairs[6].currentTree = '0'.repeat(40); }), 'IMPORT_CURRENT_TREE');
  mutation('reject-incorrect-parent', importPath, (bytes) => mutateJson(bytes, (r) => { r.pairs[6].currentParents = [r.pairs[0].current]; }), 'IMPORT_CURRENT_PARENT');
  mutation('reject-evidence-hash-drift', 'docs/evidence/Phase002-gate.json', (bytes) => Buffer.concat([bytes, Buffer.from('\n')]), 'IMPORT_EVIDENCE_HASH');
  const inputPath = `${json(root, 'docs/project-layout.json').roadmapRoot}/docs/roadmap-canonical-contract.md`;
  mutation('reject-pinned-input-drift', inputPath, (bytes) => Buffer.concat([bytes, Buffer.from('\nfixture drift\n')]), 'PINNED_HASH');
  write('src/app/page.tsx', 'export default function Page() { return null; }\n'); commit();
  validate('reject-unapproved-admission-tail', 'IMPORT_ADMISSION_SCOPE');
  cases.push({ name: 'reject-unapproved-admission-tail', status: 'PASS' });
  assert(fs.realpathSync(root).startsWith(`${temporaryParent}${path.sep}serendipity-checkpoint-import-`));
  git(['reset', '--hard', cleanHead]);
  mutation('reject-history-bundle-drift', receipt.localHistory.bundlePath, (bytes) => Buffer.concat([bytes, Buffer.from('fixture drift')]), 'IMPORT_BUNDLE_HASH');
  validate('restored-positive-admission');
  assert.equal(git(['status', '--porcelain=v1', '-uall']), '');
} catch (error) { failure = error.stack; process.exitCode = 1; }
const report = { status: failure ? 'FAIL' : 'PASS', scope: 'CHECKPOINT_HISTORY_IMPORT_REGRESSION', planPath, planHash: hash(read(sourceRoot, planPath)), migrationPath: importPath, migrationHash: hash(read(sourceRoot, importPath)), startedAt, durationMs: Math.round(performance.now() - start), temporaryRoot, cases, observations, failure, pendingSeparateCase: 'existing-both-shell-checkpoint-regressions', productionTraffic: false };
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ status: report.status, cases: cases.length, observations: observations.length, output, failure }, null, 2));
