import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const gatePath = 'docs/evidence/Phase000-gate.json';
const statePath = 'docs/roadmap-run.json';
const logPath = 'docs/phase-completion-log.md';
const documentPaths = [
  'docs/project-constitution.md',
  'docs/agent-execution-contract.md',
  'docs/tech-stack.md',
  'docs/directory-structure.md',
  'docs/phase-plans/completion-log-template.md',
];

export const validatorShellWrapperSource = `[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Validator,
  [Parameter(Mandatory = $true)][string]$Manifest,
  [int]$CompletedThrough = 0
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
& $Validator -Manifest $Manifest -CompletedThrough $CompletedThrough -Strict -Json
exit $LASTEXITCODE
`;

function normalized(value) {
  return path.resolve(value).replaceAll('\\', '/');
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fileHash(file) {
  return hash(fs.readFileSync(file));
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeBytes(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

function writeJson(file, value) {
  writeBytes(file, jsonBytes(value));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function shellArgument(value) {
  return /^[A-Za-z0-9_./:=+-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "''")}'`;
}

export function createRunState({
  manifest,
  manifestHash,
  repositoryRoot,
  roadmapRoot,
  projectRoot,
  baselineCommit,
  artifactCommit,
  contractHashes,
  evidenceHash,
}) {
  assert.equal(manifest.executionMode, 'NEW_BUILD');
  assert.equal(manifest.operatorMode, 'AGENT_ONLY_AUTOMATED_NEW_BUILD');
  assert.match(manifestHash, /^[0-9a-f]{64}$/);
  assert.match(evidenceHash, /^[0-9a-f]{64}$/);
  assert.match(baselineCommit, /^[0-9a-f]{40,64}$/);
  assert.match(artifactCommit, /^[0-9a-f]{40,64}$/);
  assert.notEqual(baselineCommit, artifactCommit);
  assert.equal(manifest.runStatePinnedInputs.length, 8);
  const pinnedHashes = {};
  for (const input of manifest.runStatePinnedInputs) {
    assert.match(contractHashes[input.id], /^[0-9a-f]{64}$/);
    pinnedHashes[input.id] = contractHashes[input.id];
  }
  return {
    roadmapId: manifest.roadmapId,
    executionMode: manifest.executionMode,
    operatorMode: manifest.operatorMode,
    manifestHash,
    repositoryRoot: normalized(repositoryRoot),
    roadmapRoot: normalized(roadmapRoot),
    projectRoot: normalized(projectRoot),
    baselineCommit,
    completedThrough: 0,
    currentPhase: 1,
    lastArtifactCommit: artifactCommit,
    contractHashes: pinnedHashes,
    checkpoints: [{ phase: 0, artifactCommit, evidencePath: gatePath, evidenceHash }],
  };
}

export function runProtocolLab({ projectRoot, reportPath }) {
  const sourceProject = path.resolve(projectRoot);
  const sourceRoadmap = path.dirname(sourceProject);
  const sourceReceipt = readJson(path.join(sourceProject, 'docs/phase-plans/bootstrap.json'));
  const sourceRepository = path.resolve(sourceReceipt.repositoryRoot);
  const sourceManifestPath = path.join(sourceRoadmap, 'docs/roadmap-execution-manifest.json');
  const manifest = readJson(sourceManifestPath);
  const baselineCommit = sourceReceipt.baselineCommit;
  const labDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'serendipity-phase000-protocol-'));
  const validatorWrapperPath = path.join(labDirectory, 'invoke-roadmap-validator.ps1');
  const labRepository = path.join(labDirectory, 'repository');
  const roadmapRelative = path.relative(sourceRepository, sourceRoadmap);
  assert.ok(roadmapRelative && !roadmapRelative.startsWith('..') && !path.isAbsolute(roadmapRelative));
  const labRoadmap = path.join(labRepository, roadmapRelative);
  const labProject = path.join(labRoadmap, 'project');
  const projectPrefix = `${path.relative(labRepository, labProject).replaceAll('\\', '/')}/`;
  const labManifestPath = path.join(labRoadmap, 'docs/roadmap-execution-manifest.json');
  const fixturePrefix = 'docs/evidence/attempts/Phase000/protocol-fixture';
  const fixtureInputPath = `${fixturePrefix}/input.json`;
  const fixtureOutputPath = `${fixturePrefix}/git-version.txt`;
  const fixtureReviewPath = `${fixturePrefix}/fixture-review.json`;
  const fixturePlanPath = 'docs/phase-plans/Phase000.json';
  const fixtureCaseId = 'Phase000:protocol-fixture-git-version';
  const fixtureReviewerId = `fixture-only-${randomUUID()}`;
  const shells = ['pwsh', 'powershell'];
  const sourceFiles = new Map();
  for (const relative of documentPaths) sourceFiles.set(relative, path.join(sourceProject, relative));
  sourceFiles.set('roadmap/docs/roadmap-execution-manifest.json', sourceManifestPath);
  sourceFiles.set('roadmap/docs/validate-roadmap-v2.ps1', path.join(sourceRoadmap, 'docs/validate-roadmap-v2.ps1'));
  for (const input of manifest.runStatePinnedInputs) {
    sourceFiles.set(`roadmap/${input.path}`, path.join(sourceRoadmap, input.path));
  }
  const sourceHashes = Object.fromEntries([...sourceFiles].map(([relative, file]) => [relative, fileHash(file)]));
  const report = {
    simulation: true,
    fixtureOnly: true,
    status: 'RUNNING',
    labDirectory: normalized(labDirectory),
    repositoryRoot: normalized(labRepository),
    roadmapRoot: normalized(labRoadmap),
    projectRoot: normalized(labProject),
    validatorInvocation: {
      wrapperPath: normalized(validatorWrapperPath),
      wrapperSha256: hash(Buffer.from(validatorShellWrapperSource)),
      wrapperSource: validatorShellWrapperSource,
      environmentPolicy: { removedVariables: ['PSModulePath'], consoleEncoding: 'UTF-8' },
      frozenValidatorUnmodified: true,
    },
    sourceHashes,
    checkpoint: null,
    runState: null,
    observations: [],
    negativeChecks: [],
    restored: false,
    fixtureReviewNotice: 'The laboratory review is schema fixture data, not an independent Agent review of the actual Phase000 deliverable.',
    startedAt: new Date().toISOString(),
  };

  function run(executable, args, cwd, label, options = {}) {
    const started = Date.now();
    const result = spawnSync(executable, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120000,
      windowsHide: true,
      env: options.env ?? process.env,
    });
    const observation = {
      id: `command-${String(report.observations.length + 1).padStart(3, '0')}`,
      label,
      executable,
      args,
      command: [executable, ...args].map(shellArgument).join(' '),
      cwd: normalized(cwd),
      exitCode: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error?.message ?? null,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      ...(options.environmentPolicy ? { environmentPolicy: options.environmentPolicy } : {}),
    };
    report.observations.push(observation);
    assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);
    assert.notEqual(result.status, null, `${label}: command did not exit normally`);
    return observation;
  }

  function git(args, label, cwd = labRepository) {
    const observation = run('git', ['-c', 'core.quotepath=false', ...args], cwd, label);
    assert.equal(observation.exitCode, 0, `${label}: ${observation.stderr}`);
    return observation.stdout.trim();
  }

  function validate(shell, label, expected = '', completedThrough = 0) {
    // Each PowerShell edition must discover its own compatible built-in modules.
    const childEnvironment = { ...process.env };
    for (const key of Object.keys(childEnvironment)) {
      if (key.toLowerCase() === 'psmodulepath') delete childEnvironment[key];
    }
    const observation = run(shell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', validatorWrapperPath,
      '-Validator', path.join(labRoadmap, 'docs/validate-roadmap-v2.ps1'),
      '-Manifest', labManifestPath, '-CompletedThrough', String(completedThrough),
    ], labRoadmap, label, { env: childEnvironment, environmentPolicy: report.validatorInvocation.environmentPolicy });
    observation.wrapperSha256 = fileHash(validatorWrapperPath);
    assert.equal(observation.wrapperSha256, report.validatorInvocation.wrapperSha256);
    let parsed;
    try {
      parsed = JSON.parse(observation.stdout.replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new Error(`${label}: validator returned invalid JSON (exit ${observation.exitCode}): ${observation.stderr || observation.stdout}`, { cause: error });
    }
    assert.ok(!observation.stdout.includes('\uFFFD'), `${label}: validator output contains invalid UTF-8`);
    if (expected) {
      assert.notEqual(observation.exitCode, 0, `${label}: mutation did not fail`);
      assert.equal(parsed.status, 'FAIL', `${label}: mutation did not produce FAIL`);
      assert.ok(observation.stdout.includes(expected), `${label}: missing diagnostic ${expected}`);
    } else {
      assert.equal(observation.exitCode, 0, `${label}: ${observation.stdout}\n${observation.stderr}`);
      assert.equal(parsed.status, 'PASS', `${label}: validator did not pass`);
      assert.equal(normalized(parsed.projectRoot), normalized(labProject), `${label}: validator output path was not preserved`);
    }
    observation.parsedStatus = parsed.status;
    return observation;
  }

  function mutate(name, file, transform, expected, completedThrough = 0) {
    const original = fs.readFileSync(file);
    const changed = transform(original);
    const beforeHash = hash(original);
    const afterHash = hash(changed);
    assert.notEqual(beforeHash, afterHash, `${name}: mutation changed no bytes`);
    for (const shell of shells) {
      let rejection;
      try {
        fs.writeFileSync(file, changed);
        rejection = validate(shell, `${name}:${shell}:reject`, expected, completedThrough);
      } finally {
        fs.writeFileSync(file, original);
      }
      assert.equal(fileHash(file), beforeHash, `${name}: original bytes were not restored`);
      const restoration = validate(shell, `${name}:${shell}:restored`);
      report.negativeChecks.push({
        name,
        shell,
        fixtureOnly: true,
        scope: 'official-validator-isolated-clone',
        mutationPath: path.relative(labRepository, file).replaceAll('\\', '/'),
        beforeHash,
        afterHash,
        restoredHash: fileHash(file),
        expectedDiagnostic: expected,
        observationId: rejection.id,
        restorationObservationId: restoration.id,
        observedExitCode: rejection.exitCode,
        restoredExitCode: restoration.exitCode,
        status: 'PASS',
      });
    }
  }

  function saveReport() {
    report.generatedAt = new Date().toISOString();
    if (reportPath) writeJson(path.resolve(sourceProject, reportPath), report);
  }

  try {
    writeBytes(validatorWrapperPath, Buffer.from(validatorShellWrapperSource));
    assert.match(baselineCommit, /^[0-9a-f]{40,64}$/);
    assert.equal(normalized(sourceProject), sourceReceipt.projectRoot);
    assert.equal(fileHash(sourceManifestPath), sourceReceipt.manifestHash);
    assert.equal(normalized(git(['rev-parse', '--show-toplevel'], 'verify-actual-repository-root', sourceRepository)), normalized(sourceRepository));
    git(['clone', '--no-hardlinks', '--no-checkout', '--', sourceRepository, labRepository], 'clone-actual-baseline', labDirectory);
    git(['switch', '-C', 'main', baselineCommit], 'checkout-actual-baseline');
    for (const [name, value] of [
      ['user.name', 'Serendipity Protocol Fixture'],
      ['user.email', 'protocol-fixture@serendipity.invalid'],
      ['commit.gpgsign', 'false'],
      ['core.autocrlf', 'false'],
      ['core.safecrlf', 'false'],
      ['core.hooksPath', path.join(labRepository, '.git', 'hooks')],
    ]) git(['config', '--local', name, value], `configure-fixture:${name}`);
    git(['remote', 'set-url', 'origin', manifest.gitPolicy.remoteUrl], 'set-validated-fixture-origin-without-network');
    assert.equal(git(['rev-parse', 'HEAD'], 'verify-baseline-head'), baselineCommit);
    assert.equal(git(['ls-tree', '-r', '--name-only', baselineCommit, '--', projectPrefix], 'baseline-project-must-be-empty'), '');
    assert.equal(fileHash(labManifestPath), sourceReceipt.manifestHash);
    for (const [relative] of sourceFiles) {
      if (relative.startsWith('roadmap/')) {
        assert.equal(fileHash(path.join(labRoadmap, relative.slice('roadmap/'.length))), sourceHashes[relative], `Frozen source differs from actual baseline: ${relative}`);
      }
    }

    // Initial target occupancy is a bootstrap preflight rule, not a -1 validator rule.
    const preflightCode = "const fs=require('node:fs');const p=process.argv[1];if(fs.existsSync(p)&&fs.readdirSync(p).length){console.error('BLOCKED_NONEMPTY_TARGET: unknown files require a valid bootstrap receipt');process.exit(1)}console.log('PASS: target absent or empty');";
    const empty = run(process.execPath, ['-e', preflightCode, labProject], labRepository, 'bootstrap-empty-target');
    assert.equal(empty.exitCode, 0);
    fs.mkdirSync(labProject, { recursive: true });
    const unexpectedFile = path.join(labProject, 'unknown-fixture-file.txt');
    writeBytes(unexpectedFile, Buffer.from('Synthetic unknown bootstrap input.\n'));
    const unexpectedHash = fileHash(unexpectedFile);
    const occupied = run(process.execPath, ['-e', preflightCode, labProject], labRepository, 'bootstrap-nonempty-target-rejected');
    assert.notEqual(occupied.exitCode, 0);
    assert.ok(occupied.stderr.includes('BLOCKED_NONEMPTY_TARGET'));
    fs.unlinkSync(unexpectedFile);
    const emptyRestored = run(process.execPath, ['-e', preflightCode, labProject], labRepository, 'bootstrap-empty-target-restored');
    assert.equal(emptyRestored.exitCode, 0);
    report.negativeChecks.push({
      name: 'unknown-nonempty-target',
      shell: 'node',
      fixtureOnly: true,
      scope: 'bootstrap-preflight',
      mutationPath: `${projectPrefix}unknown-fixture-file.txt`,
      beforeHash: null,
      afterHash: unexpectedHash,
      restoredHash: null,
      expectedDiagnostic: 'BLOCKED_NONEMPTY_TARGET',
      observationId: occupied.id,
      restorationObservationId: emptyRestored.id,
      observedExitCode: occupied.exitCode,
      restoredExitCode: emptyRestored.exitCode,
      status: 'PASS',
    });

    const fixtureReceipt = {
      manifestHash: sourceReceipt.manifestHash,
      repositoryRoot: normalized(labRepository),
      roadmapRoot: normalized(labRoadmap),
      projectRoot: normalized(labProject),
      baselineCommit,
      startupId: `protocol-fixture-${randomUUID()}`,
      allowedInitializationFiles: [
        'docs/phase-plans/bootstrap.json', ...documentPaths, fixturePlanPath,
        fixtureInputPath, fixtureOutputPath, fixtureReviewPath, gatePath, statePath, logPath,
      ],
      fixtureOnly: true,
    };
    writeJson(path.join(labProject, 'docs/phase-plans/bootstrap.json'), fixtureReceipt);
    for (const relative of documentPaths) {
      const bytes = fs.readFileSync(path.join(sourceProject, relative));
      assert.ok(!bytes.includes(Buffer.from('\r\n')), `${relative}: candidate text must use LF`);
      writeBytes(path.join(labProject, relative), bytes);
      assert.equal(fileHash(path.join(labProject, relative)), sourceHashes[relative]);
    }
    const version = run('git', ['--version'], labProject, 'fixture-actual-git-version');
    assert.equal(version.exitCode, 0);
    writeJson(path.join(labProject, fixtureInputPath), {
      fixtureOnly: true,
      description: 'Synthetic Git protocol fixture using the actual baseline and candidate document bytes.',
      sourceHashes,
    });
    writeBytes(path.join(labProject, fixtureOutputPath), Buffer.from(version.stdout.replaceAll('\r\n', '\n')));
    writeJson(path.join(labProject, fixturePlanPath), {
      phase: 0,
      attemptId: 'protocol-fixture',
      fixtureOnly: true,
      requiredCaseIds: [fixtureCaseId],
      cases: [{
        testCaseId: fixtureCaseId, command: 'git --version', denominator: 1,
        inputPath: fixtureInputPath, outputPath: fixtureOutputPath,
        expected: 'The actual local Git command exits zero and returns a version.',
      }],
    });
    const planHash = fileHash(path.join(labProject, fixturePlanPath));
    writeJson(path.join(labProject, fixtureReviewPath), {
      fixtureOnly: true,
      reviewKind: 'SCHEMA_FIXTURE_NOT_INDEPENDENT_REVIEW',
      reviewerRunId: fixtureReviewerId,
      planHash,
      decision: 'PASS',
      contextId: fixtureReviewerId,
      generatedBy: 'protocol-lab.mjs schema fixture generator',
      issues: [],
      dispositions: [],
      notice: report.fixtureReviewNotice,
    });
    const artifactFiles = [
      'docs/phase-plans/bootstrap.json', ...documentPaths,
      fixturePlanPath, fixtureInputPath, fixtureOutputPath, fixtureReviewPath,
    ];
    git(['add', '--', ...artifactFiles.map((relative) => `${projectPrefix}${relative}`)], 'stage-fixture-artifact-explicit-paths');
    git(['diff', '--cached', '--check'], 'fixture-artifact-whitespace-check');
    git(['commit', '-m', 'phase(000): artifact'], 'fixture-artifact-commit');
    const artifactCommit = git(['rev-parse', 'HEAD'], 'read-fixture-artifact-id');
    const testedTree = git(['rev-parse', 'HEAD^{tree}'], 'read-fixture-artifact-tree');
    const inputHash = fileHash(path.join(labProject, fixtureInputPath));
    const gate = {
      schemaVersion: 'agent-gate-v1', phase: 0, attemptId: 'protocol-fixture', status: 'PASS',
      simulation: true, operatorMode: manifest.operatorMode,
      environment: { isolated: true, syntheticUsers: true, providerMode: 'local-adapter', productionTraffic: false },
      artifactCommit, requiredCaseIds: [fixtureCaseId],
      results: [{
        testCaseId: fixtureCaseId, command: 'git --version', exitCode: version.exitCode,
        numerator: 1, denominator: 1, inputHash: `sha256:${inputHash}`,
        outputHash: `sha256:${fileHash(path.join(labProject, fixtureOutputPath))}`, status: 'PASS',
        details: { inputPath: fixtureInputPath, outputPath: fixtureOutputPath, fixtureOnly: true },
      }],
      commands: [{ command: 'git --version', exitCode: version.exitCode }],
      inputs: [{ path: fixtureInputPath, sha256: inputHash }],
      failures: [], generatedAt: new Date().toISOString(),
      details: {
        planPath: fixturePlanPath, planHash, testedTree, reviewerRunId: fixtureReviewerId,
        reviewReportPath: fixtureReviewPath, reviewReportHash: fileHash(path.join(labProject, fixtureReviewPath)),
        recoveryCommits: [], fixtureOnly: true,
      },
    };
    writeJson(path.join(labProject, gatePath), gate);
    const contractHashes = Object.fromEntries(manifest.runStatePinnedInputs.map((input) => [
      input.id, fileHash(path.join(labRoadmap, input.path)),
    ]));
    const state = createRunState({
      manifest, manifestHash: fileHash(labManifestPath), repositoryRoot: labRepository,
      roadmapRoot: labRoadmap, projectRoot: labProject, baselineCommit, artifactCommit,
      contractHashes, evidenceHash: fileHash(path.join(labProject, gatePath)),
    });
    writeJson(path.join(labProject, statePath), state);
    const template = fs.readFileSync(path.join(labProject, 'docs/phase-plans/completion-log-template.md'), 'utf8');
    writeBytes(path.join(labProject, logPath), Buffer.from(`${template}| 000 | Synthetic protocol fixture only | Candidate documents and checkpoint fixture | git --version: exit 0 | Actual independent review and actual delivery are outside this fixture | Fixture PASS candidate |\n`));
    const metadataFiles = [gatePath, statePath, logPath].map((relative) => `${projectPrefix}${relative}`);
    git(['add', '--', ...metadataFiles], 'stage-fixture-metadata-explicit-paths');
    git(['diff', '--cached', '--check'], 'fixture-metadata-whitespace-check');
    git(['commit', '-m', 'phase(000): metadata'], 'fixture-metadata-commit');
    const metadataCommit = git(['rev-parse', 'HEAD'], 'read-fixture-metadata-id');
    const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD'], 'verify-fixture-parent').split(/\s+/);
    assert.deepEqual(parents, [metadataCommit, artifactCommit]);
    const metadataChanges = git(['diff', '--name-only', 'HEAD^', 'HEAD'], 'verify-fixture-metadata-paths').split('\n');
    assert.deepEqual([...metadataChanges].sort(), [...metadataFiles].sort());
    assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all'], 'verify-fixture-clean-worktree'), '');
    report.checkpoint = { baselineCommit, artifactCommit, metadataCommit, testedTree, parent: parents[1], metadataPaths: metadataChanges };
    report.runState = state;
    for (const shell of shells) validate(shell, `positive-checkpoint:${shell}`);

    mutate('metadata-self-reference', path.join(labProject, statePath), (bytes) => {
      const value = JSON.parse(bytes);
      value.lastArtifactCommit = metadataCommit;
      return jsonBytes(value);
    }, 'Metadata HEAD parent must equal run state lastArtifactCommit');
    mutate('evidence-byte-tamper', path.join(labProject, gatePath), (bytes) => Buffer.concat([bytes, Buffer.from('\n')]), 'Checkpoint evidenceHash mismatch');
    mutate('closed-schema-extra-field', path.join(labProject, gatePath), (bytes) => {
      const value = JSON.parse(bytes);
      value.unexpectedFixtureField = true;
      return jsonBytes(value);
    }, 'contains unknown property unexpectedFixtureField');
    mutate('project-root-outside-roadmap', labManifestPath, (bytes) => {
      const value = JSON.parse(bytes);
      value.projectRoot = '..\\..\\project';
      return jsonBytes(value);
    }, 'projectRoot must be a strict child of roadmapRoot', -1);
    mutate('baseline-already-contains-project', path.join(labProject, statePath), (bytes) => {
      const value = JSON.parse(bytes);
      value.baselineCommit = artifactCommit;
      return jsonBytes(value);
    }, 'baselineCommit must precede all projectRoot artifacts');
    mutate('frozen-input-hash-drift', path.join(labRoadmap, 'docs/product-requirements.md'), (bytes) => Buffer.concat([bytes, Buffer.from('\n')]), 'Run state contract hash mismatch for product-requirements');

    for (const [relative, file] of sourceFiles) {
      assert.equal(fileHash(file), sourceHashes[relative], `Actual source was changed during protocol lab: ${relative}`);
    }
    assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all'], 'verify-final-restored-worktree'), '');
    for (const shell of shells) validate(shell, `final-restored-checkpoint:${shell}`);
    report.restored = true;
    report.status = 'PASS';
    saveReport();
    return report;
  } catch (error) {
    report.status = 'FAIL';
    report.failures = [{ message: error.message }];
    saveReport();
    error.protocolReport = report;
    throw error;
  }
}
