import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const receiptPath = 'docs/checkpoint-migrations/history-20260909.json';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function git(args, cwd = root) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, windowsHide: true, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr?.toString('utf8'));
  return result.stdout;
}
const text = (args, cwd) => git(args, cwd).toString('utf8').trim();
const read = (file) => fs.readFileSync(path.join(root, file));
const state = JSON.parse(read('docs/roadmap-run.json'));
const planPath = 'docs/phase-plans/Phase003-checkpoint-recovery.json';
const plan = JSON.parse(read(planPath));
assert(!fs.existsSync(path.join(root, receiptPath)), 'The immutable import receipt already exists');
assert.equal(text(['rev-parse', 'HEAD']), plan.baselineCommit);
assert.equal(text(['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0], plan.baselineCommit);
const originalMetadata = '7c70866f0b7c391ba1971e11cd3aa360b60f1423';
const bundlePath = '.scaffold/checkpoint-import/original-history.bundle';
const objectRepo = '.scaffold/checkpoint-import/original-history.git';
fs.mkdirSync(path.join(root, '.scaffold/checkpoint-import'), { recursive: true });
git(['check-ignore', '--no-index', '--', bundlePath, `${objectRepo}/HEAD`]);
assert(!fs.existsSync(path.join(root, bundlePath)) && !fs.existsSync(path.join(root, objectRepo)), 'Do not overwrite a history backup');
const temporary = path.join(root, '.scaffold', `checkpoint-export-${randomUUID()}`);
git(['clone', '--shared', '--no-checkout', root, temporary]);
git(['update-ref', 'refs/heads/checkpoint-original', originalMetadata], temporary);
git(['bundle', 'create', path.join(root, bundlePath), 'refs/heads/checkpoint-original'], temporary);
git(['clone', '--bare', '--branch', 'checkpoint-original', path.join(root, bundlePath), path.join(root, objectRepo)]);
git(['bundle', 'verify', path.join(root, bundlePath)]);
const roles = [
  ['foundation', '6d50441b468c012625dede2ccf6cd1454fc00a41', '6d50441b468c012625dede2ccf6cd1454fc00a41'],
  ['Phase000-artifact', 'ab7f2b957b0cd4ba142c46d64643945ceabc8684', '967739bbfe21d980763b4c8dcb72d1e01bca8759'],
  ['Phase000-metadata', '919b82cfbd9f70622a11b60d119f070f50248c93', '151c0d7709060f23ba17859871a05ad0b5b86f9b'],
  ['new-layout-baseline', '10d5f9554ade36fc94cdbf6c2c9fdff5582e28da', '05a99eec43f8f1f19227b80f34ab6e6c520b7510'],
  ['Phase001-artifact', 'f0d416e296c9ca258d2907750f4fb933e15567a6', '4ba7669e98522b98a1fead3b1f0c30c04dc52c20'],
  ['Phase001-metadata', '9909bcbf4350471df754868e1032ba9dce7c5964', 'e0df6c60b6cf0f9091540b792b1e37b082492fa6'],
  ['Phase002-artifact', '5b5378f092455226b9bf20cc00f07aa95a69fd01', '3bf36b6712ea374066b84079c06642ba2de15435'],
  ['Phase002-metadata', originalMetadata, '13a1381a52645edbe2db5b186c14d1aabc4b6c15'],
];
const pairs = roles.map(([role, original, current]) => ({ role, original, current,
  originalParents: text(['rev-list', '--parents', '-n', '1', original]).split(' ').slice(1),
  currentParents: text(['rev-list', '--parents', '-n', '1', current]).split(' ').slice(1),
  originalTree: text(['rev-parse', `${original}^{tree}`]), currentTree: text(['rev-parse', `${current}^{tree}`]),
}));
const prefix = `${state.roadmapRoot}/`;
const removed = git(['diff', '--name-only', '--diff-filter=D', '-z', pairs[1].original, pairs[1].current]).toString('utf8').split('\0').filter(Boolean).map((file) => {
  assert(file.startsWith(prefix) && !file.startsWith(`${prefix}project/`));
  return { path: file, sha256: sha256(git(['cat-file', 'blob', `${pairs[1].original}:${file}`])) };
});
assert.equal(removed.length, 153);
const receipt = {
  schemaVersion: 'checkpoint-history-import-v1',
  authorization: plan.authorization, planPath, planHash: sha256(read(planPath)),
  generatedAt: new Date().toISOString(), importedThrough: 2, startPhase: 3,
  originalBaselineCommit: state.executionBaselineCommit,
  currentHistoryBaselineCommit: pairs[3].current,
  originalMetadataCommit: originalMetadata,
  currentMetadataCommit: pairs.at(-1).current,
  continuationBaselineCommit: plan.baselineCommit,
  preflight: { head: plan.baselineCommit, originMain: plan.baselineCommit, branch: 'main', remote: 'https://github.com/KECIHH/Serendipity.git' },
  droppedOriginalCommit: { commit: state.historicalCheckpoint.baselineCommit, parent: pairs[0].original },
  pairs, removedLocalDocuments: removed,
  localHistory: { bundlePath, bundleSha256: sha256(read(bundlePath)), objectRepository: objectRepo, sourceRef: 'refs/heads/checkpoint-original', sourceCommit: originalMetadata },
  originalStateHash: sha256(git(['cat-file', 'blob', `${originalMetadata}:docs/roadmap-run.json`])),
  originalCheckpoints: state.checkpoints,
  originalHistoricalCheckpoint: state.historicalCheckpoint,
  manifestHash: state.manifestHash, contractHashes: state.contractHashes,
  admissionTail: { subject: 'phase(003): recovery', allowedExactPaths: ['docs/agent-execution-contract.md', 'docs/checkpoint-migrations/history-20260909.json', planPath], allowedPathPrefixes: ['scripts/', 'docs/evidence/attempts/Phase003/'] },
  policy: 'Original Git objects and original Gate references are audited as originals; mapped current commits are audited separately. No Git replacement, history rewrite, restored tracked roadmap documents or historical PASS updates.',
};
fs.mkdirSync(path.dirname(path.join(root, receiptPath)), { recursive: true });
fs.writeFileSync(path.join(root, receiptPath), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ receiptPath, sha256: sha256(read(receiptPath)), pairs: pairs.length, localOnlyDocuments: removed.length, bundlePath, bundleSha256: receipt.localHistory.bundleSha256 }, null, 2));
