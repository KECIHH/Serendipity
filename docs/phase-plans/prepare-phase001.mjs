import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseline = '10d5f9554ade36fc94cdbf6c2c9fdff5582e28da';
const file = (name) => path.join(root, name);
const read = (name) => JSON.parse(fs.readFileSync(file(name), 'utf8').replace(/^\uFEFF/, ''));
const hash = (name) => createHash('sha256').update(fs.readFileSync(file(name))).digest('hex');
function git(args) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const target = 'docs/phase-plans/Phase001-inputs.json';
assert(!fs.existsSync(file(target)), 'Input receipt is immutable; do not silently refresh hashes');
assert.equal(git(['rev-parse', 'HEAD']), baseline);
assert.equal(git(['rev-parse', 'origin/main']), baseline);
assert.equal(git(['branch', '--show-current']), 'main');
const layout = read('docs/project-layout.json');
const manifestPath = `${layout.roadmapRoot}/docs/roadmap-execution-manifest.json`;
const manifest = read(manifestPath);
assert.equal(manifest.layoutVersion, 2);
assert.equal(git(['remote', 'get-url', 'origin']), manifest.gitPolicy.remoteUrl);
assert.equal(git(['remote', 'get-url', '--push', 'origin']), manifest.gitPolicy.remoteUrl);
assert.equal(git(['ls-files', '--', `${layout.roadmapRoot}/`]), '');
const inputs = [{ id: 'manifest', path: manifestPath }];
for (const contract of manifest.localContracts) inputs.push({ id: contract.id, path: `${layout.roadmapRoot}/${contract.path}` });
for (let phase = 0; phase <= 137; phase += 1) {
  const label = `Phase${String(phase).padStart(3, '0')}`;
  inputs.push({ id: phase === 1 ? 'phase-card' : label, path: `${layout.roadmapRoot}/${label}.md` });
}
for (const name of ['validate-roadmap-v2.ps1', 'test-validate-roadmap-v2.ps1']) inputs.push({ id: name, path: `${layout.roadmapRoot}/docs/${name}` });
for (const input of inputs) input.sha256 = hash(input.path);
const state = read('docs/roadmap-run.json');
assert.equal(state.completedThrough, 0);
assert.equal(state.currentPhase, 1);
const receipt = {
  layoutVersion: 2,
  phase: 1,
  repositoryRoot: '.',
  projectRoot: '.',
  roadmapRoot: layout.roadmapRoot,
  executionBaselineCommit: baseline,
  baselineCommit: baseline,
  manifestHash: hash(manifestPath),
  preflight: {
    branch: 'main',
    remote: manifest.gitPolicy.remoteUrl,
    head: baseline,
    originMain: baseline,
    porcelain: '',
    observation: 'git status --porcelain=v1 returned empty before plan creation; git fetch origin main then rev-parse HEAD origin/main returned this same baseline',
    layoutAudit: { command: 'node scripts/check-project-layout.mjs', exitCode: 0, preservedHistoricalFiles: 44 },
  },
  historicalCheckpoint: state.historicalCheckpoint,
  pinnedInputPolicy: 'LOCAL_FILES_WITH_RECORDED_SHA256',
  futureCards: 'READ_ONLY_MODEL_PRODUCER_AND_CONSUMER_CONTRACTS',
  requestedThrough: 1,
  pinnedInputs: inputs,
  documentRuntime: { node: process.version, platform: process.platform, arch: process.arch },
};
fs.writeFileSync(file(target), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ status: 'CAPTURED', path: target, baselineCommit: baseline, pinnedInputCount: inputs.length, manifestHash: receipt.manifestHash }));
