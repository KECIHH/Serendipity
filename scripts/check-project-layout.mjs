import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const local = (relative) => path.resolve(repositoryRoot, relative);

function git(args, input) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: repositoryRoot,
    input,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `git ${args[0]}: ${result.stderr?.toString('utf8')}`);
  return result.stdout;
}

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Unexpected symlink in archive: ${file}`);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

function check() {
  const layout = json(local('docs/project-layout.json'));
  const state = json(local('docs/roadmap-run.json'));
  const actualGitRoot = git(['rev-parse', '--show-toplevel']).toString('utf8').trim();
  assert.equal(fs.realpathSync(repositoryRoot), fs.realpathSync(actualGitRoot), 'Wrong repository root');
  assert.equal(layout.layoutVersion, 2);
  assert.equal(layout.pathsRelativeTo, 'repositoryRoot');
  assert.equal(layout.repositoryRoot, '.');
  assert.equal(layout.projectRoot, '.', 'Application must live directly at the repository root');
  assert.equal(layout.roadmapVersionControl, 'LOCAL_ONLY_IGNORED');
  for (const key of ['layoutVersion', 'repositoryRoot', 'projectRoot', 'roadmapRoot', 'pathsRelativeTo']) {
    assert.equal(state[key], layout[key], `Run state and layout differ: ${key}`);
  }
  assert.equal(state.stateVersion, 2);
  assert(Number.isInteger(state.completedThrough) && state.completedThrough >= 0 && state.completedThrough <= 137);
  assert.equal(state.currentPhase, state.completedThrough + 1);
  if (state.completedThrough === 0) {
    assert.equal(state.progressSource, 'HISTORICAL_CHECKPOINT');
    assert.equal(state.currentLayoutPhaseSeal, null, 'Migration does not produce a new Phase seal');
    assert.equal(state.nextPhaseExecutionAuthorized, false, 'Directory migration does not authorize Phase001');
    assert.equal(state.nextRun.baselineCommit, null, 'The next run has not started');
  } else {
    assert.equal(state.progressSource, 'CURRENT_LAYOUT_CHECKPOINT');
    assert.equal(state.baselineCommit, state.executionBaselineCommit);
    assert.match(state.executionBaselineCommit, /^[0-9a-f]{40,64}$/);
    assert.equal(state.currentLayoutPhaseSeal.phase, state.completedThrough);
    assert.equal(state.currentLayoutPhaseSeal.artifactCommit, state.lastArtifactCommit);
    assert.equal(state.checkpoints.length, state.completedThrough);
    assert.deepEqual(state.currentLayoutPhaseSeal, state.checkpoints.at(-1));
    assert.equal(state.nextRun.baselineCommit, state.executionBaselineCommit);
  }
  assert.equal(state.nextRun.startPhase, 1);
  assert.equal(state.nextRun.requiresRootAwareRunner, true);
  assert.equal(state.nextRun.legacyValidator, 'HISTORICAL_LAYOUT_ONLY');

  const roadmapRoot = local(layout.roadmapRoot);
  assert.equal(path.dirname(roadmapRoot), repositoryRoot, 'Roadmap must be an immediate child directory');
  assert(!fs.existsSync(local('project')), 'An extra project/ wrapper is forbidden');
  const trackedRoadmapFiles = git(['ls-files', '-z', '--', `${layout.roadmapRoot}/`]);
  assert.equal(trackedRoadmapFiles.length, 0, 'Development roadmap is still tracked in the Git index');
  const ignoreProbe = `${layout.roadmapRoot}/Phase000.md`;
  assert.equal(
    git(['check-ignore', '--no-index', '--stdin'], `${ignoreProbe}\n`).toString('utf8').trim(),
    ignoreProbe,
    'Development roadmap must be ignored',
  );

  const localRoadmapPresent = fs.existsSync(roadmapRoot);
  if (localRoadmapPresent) {
    for (const entry of ['project', '.git', 'node_modules', '.next', '.scaffold', ...layout.sourceDirectories, ...layout.packageFiles]) {
      assert(!fs.existsSync(path.join(roadmapRoot, entry)), `Project entry inside development roadmap: ${entry}`);
    }
    const manifestFile = path.join(roadmapRoot, 'docs/roadmap-execution-manifest.json');
    const manifest = json(manifestFile);
    assert.equal(manifest.layoutVersion, layout.layoutVersion, 'Local manifest uses a stale layout');
    for (const [key, expected] of Object.entries({ repositoryRoot, projectRoot: repositoryRoot, roadmapRoot })) {
      assert.equal(path.resolve(path.dirname(manifestFile), manifest[key].replaceAll('\\', '/')), expected, `Local manifest root mismatch: ${key}`);
    }
  }

  const history = layout.history;
  const checkpoint = state.historicalCheckpoint;
  assert.equal(checkpoint.metadataCommit, history.sourceCommit);
  assert.equal(checkpoint.projectGitPrefix, `${history.sourceProjectRoot}/`);
  assert.equal(checkpoint.archiveRoot, history.archiveProjectRoot);
  assert.equal(checkpoint.appliesToLayoutVersion, 1, 'Old seal applies only to the historical layout');
  assert.equal(
    git(['rev-parse', `${checkpoint.metadataCommit}^`]).toString('utf8').trim(),
    checkpoint.artifactCommit,
    'Historical metadata must directly follow its artifact',
  );
  git(['merge-base', '--is-ancestor', checkpoint.baselineCommit, checkpoint.artifactCommit]);

  const sourcePrefix = `${history.sourceProjectRoot}/`;
  const sourceFiles = git(['ls-tree', '-rz', '--name-only', history.sourceCommit, '--', sourcePrefix])
    .toString('utf8').split('\0').filter(Boolean);
  assert.equal(sourceFiles.length, history.trackedFileCount, 'Historical file count changed');
  const archiveRoot = local(history.archiveProjectRoot);
  const expectedFiles = sourceFiles.map((file) => path.resolve(archiveRoot, file.slice(sourcePrefix.length)));
  assert.deepEqual(filesUnder(path.join(archiveRoot, 'docs')).sort(), [...expectedFiles].sort(), 'Archive file set differs from the original project');

  // Compare raw Git blobs so Windows newline conversion cannot conceal changes.
  for (const sourceFile of sourceFiles) {
    const archivedFile = path.join(archiveRoot, sourceFile.slice(sourcePrefix.length));
    assert.equal(
      sha256(fs.readFileSync(archivedFile)),
      sha256(git(['cat-file', 'blob', `${history.sourceCommit}:${sourceFile}`])),
      `Archive bytes differ: ${sourceFile}`,
    );
    if (archivedFile.endsWith('.json')) json(archivedFile);
  }
  const historicalState = json(local(checkpoint.runStatePath));
  assert.equal(historicalState.lastArtifactCommit, checkpoint.artifactCommit);
  assert.equal(historicalState.baselineCommit, checkpoint.baselineCommit);
  assert.equal(historicalState.checkpoints[0].evidenceHash, checkpoint.evidenceHash);
  assert.equal(sha256(fs.readFileSync(local(checkpoint.evidencePath))), checkpoint.evidenceHash);

  for (const file of ['project-constitution.md', 'agent-execution-contract.md', 'phase-completion-log.md', 'tech-stack.md', 'directory-structure.md']) {
    assert(fs.statSync(local(`docs/${file}`)).isFile(), `Missing active project document: ${file}`);
  }
  return {
    status: 'PASS',
    scope: 'PROJECT_LAYOUT_AND_HISTORICAL_ARCHIVE',
    repositoryRoot,
    projectRoot: repositoryRoot,
    roadmapTrackedFiles: 0,
    roadmapIgnored: true,
    localRoadmapPresent,
    preservedHistoricalFiles: sourceFiles.length,
    phaseSealEvaluated: false,
  };
}

try {
  console.log(JSON.stringify(check(), null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', error: error.message }, null, 2));
  process.exitCode = 1;
}
