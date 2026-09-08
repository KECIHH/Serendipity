import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), '../..');
const roadmapRoot = path.dirname(projectRoot);
const repositoryRoot = path.dirname(roadmapRoot);
const planPath = 'docs/phase-plans/Phase000.json';
const fixturePath = 'docs/phase-plans/Phase000-inputs.json';
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const bytes = (file) => fs.readFileSync(file);
const read = (file) => bytes(file).toString('utf8').replace(/^\uFEFF/, '');
const json = (file) => JSON.parse(read(file));
const fileHash = (file) => sha(bytes(file));
const local = (file) => path.join(projectRoot, file);
const fixture = json(local(fixturePath));
const plan = json(local(planPath));
const bootstrap = json(local('docs/phase-plans/bootstrap.json'));
const manifestFile = path.join(roadmapRoot, 'docs/roadmap-execution-manifest.json');
const manifest = json(manifestFile);
const attemptDirectory = `docs/evidence/attempts/Phase000/${plan.attemptId}`;

function writeJson(file, value, exclusive = true) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: exclusive ? 'wx' : 'w' });
}

function command(program, args, cwd = repositoryRoot) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { command: [program, ...args].join(' '), exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(args, cwd = repositoryRoot) {
  const result = command('git', ['-c', 'core.quotepath=false', ...args], cwd);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  return result.stdout.trim();
}

function sections(text) {
  const lines = text.split('\n');
  const result = new Map();
  let title;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      title = line.slice(3).trim();
      assert(!result.has(title), `Duplicate heading: ${title}`);
      result.set(title, []);
    } else if (title) result.get(title).push(line);
  }
  return new Map([...result].map(([key, value]) => [key, value.join('\n')]));
}

export function checkDocument(kind, text) {
  const checks = [];
  const check = (id, condition) => {
    assert(condition, `${kind}: ${id}`);
    checks.push(id);
  };
  const content = sections(text);
  const includes = (tokens) => tokens.forEach((token) => check(`contains ${token}`, text.includes(token)));
  if (kind === 'constitution') {
    fixture.constitutionHeadings.forEach((heading) => check(`heading ${heading}`, content.has(heading) && content.get(heading).trim().length > 20));
    const excluded = content.get(fixture.constitutionHeadings[4]);
    check('at least three excluded features', (excluded.match(/^[-*] /gm) ?? []).length >= 3);
    ['\u8ba2\u5355', '\u652f\u4ed8', '\u793e\u4ea4', '\u7b2c\u4e09\u65b9\u767b\u5f55'].forEach((token) => check(`exclusion ${token}`, excluded.includes(token)));
    includes(['Serendipity', 'JSON', 'API Key', 'Prompt', '\u6821\u9a8c']);
  } else if (kind === 'execution-contract') {
    fixture.executionHeadings.forEach((heading) => check(`heading ${heading}`, content.has(heading) && content.get(heading).trim().length > 20));
    const decisions = [...content.get(fixture.executionHeadings.at(-1)).matchAll(/^(\d+)\.\s*([^\n\uff1a]+)\uff1a([^\n]+)$/gm)];
    check('exactly 14 numbered decisions', decisions.length === 14);
    decisions.forEach((match, index) => {
      check(`decision ${index + 1} category`, Number(match[1]) === index + 1 && match[2].trim() === fixture.decisionCategories[index]);
      check(`decision ${index + 1} concrete`, match[3].trim().length > 3 && !new RegExp(fixture.forbiddenSelectionPattern).test(match[3]));
    });
    const stateDecision = decisions[11][3].replaceAll('`', '');
    fixture.travelRecordStates.forEach((state) => check(`state ${state}`, stateDecision.includes(state)));
    check('clone target fixed', /clone\s*\u76ee\u6807\u72b6\u6001\u56fa\u5b9a\u4e3a\s*NEEDS_REVALIDATION/.test(stateDecision));
    check('clone cannot use MODIFIED', /clone\s*\u4e0d\u4f7f\u7528\s*MODIFIED/.test(stateDecision));
    includes(['ARTIFACT_THEN_METADATA', 'AGENT_ONLY_AUTOMATED_NEW_BUILD', 'AUTOMATED_TEST_ADMISSION', 'PromptVersion', 'ModelDeployment', 'AuditLog', 'baselineCommit', 'evidenceHash', 'recoveryCommits', 'httpOnly', 'anonTokenHash', 'sourceRefs', '@react-pdf/renderer']);
  } else if (kind === 'completion-log') {
    const rows = text.split('\n').filter((line) => line.startsWith('|')).map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
    check('six-column Markdown header', rows.some((row) => JSON.stringify(row) === JSON.stringify(fixture.logColumns)));
    check('Markdown divider', rows.some((row) => row.length === 6 && row.every((cell) => /^:?-{3,}:?$/.test(cell))));
    includes(['metadata commit', 'artifact commit', 'PhaseNNN', '\u81ea\u52a8\u66f4\u65b0', '\u6301\u4e45']);
  } else if (kind === 'tech-stack') {
    const choices = text.split('\n').filter((line) => /^- [^\uff1a]+\uff1a/.test(line));
    check('explicit npm selection', choices.some((line) => /^- \u5305\u7ba1\u7406\u5668\uff1anpm\s*$/.test(line)));
    check('no alternative package managers', !/\b(?:yarn|pnpm)\b/i.test(text));
    choices.forEach((line) => check(`concrete selection ${line}`, !new RegExp(fixture.forbiddenSelectionPattern).test(line)));
    includes(['Next.js App Router', 'TypeScript', 'Tailwind CSS 4', 'Route Handlers', 'PostgreSQL 17', 'Prisma', 'shadcn/ui', 'lucide-react', 'DeepSeek', 'OpenAI', 'Vitest', 'Playwright', 'Auth.js', 'Credentials', 'httpOnly', 'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'AI_MOCK', 'Phase003', 'Phase004', 'Phase119', 'src/server/services']);
    Object.values(manifest.runtimePolicy).forEach((version) => check(`runtime ${version}`, text.includes(version)));
    fixture.npmCommands.forEach((name) => check(`future command ${name}`, new RegExp(`(?:\\x60|\\s)${name}(?:\\x60|\\s)`).test(text)));
    check('deployment decision recorded', text.includes('\u90e8\u7f72\u65b9\u6848'));
  } else if (kind === 'directory-structure') {
    includes([...fixture.coreDirectories, ...fixture.aiFiles, 'src/app/admin/', 'src/app/api/', 'src/server/services/', 'src/components/ui', 'repositoryRoot', 'roadmapRoot', 'projectRoot']);
    fixture.coreDirectories.forEach((directory) => check(`directory responsibility ${directory}`, text.split('\n').some((line) => line.includes(directory) && line.length > directory.length + 12)));
  } else throw new Error(`Unknown document kind: ${kind}`);
  return { assertions: checks, assertionCount: checks.length };
}

function checkBoundary() {
  const base = path.dirname(manifestFile);
  const normalized = (file) => path.resolve(file).toLowerCase();
  const strictChild = (parent, child) => {
    const value = path.relative(parent, child);
    return value !== '' && !value.startsWith('..') && !path.isAbsolute(value);
  };
  assert.equal(normalized(path.resolve(base, manifest.repositoryRoot)), normalized(repositoryRoot));
  assert.equal(normalized(path.resolve(base, manifest.roadmapRoot)), normalized(roadmapRoot));
  assert.equal(normalized(path.resolve(base, manifest.projectRoot)), normalized(projectRoot));
  assert(strictChild(repositoryRoot, roadmapRoot) && strictChild(roadmapRoot, projectRoot));
  assert.equal(path.basename(projectRoot), 'project');
  assert.equal(normalized(fs.realpathSync(projectRoot)), normalized(projectRoot));
  assert.equal(normalized(git(['rev-parse', '--show-toplevel'])), normalized(repositoryRoot));
  assert.equal(git(['branch', '--show-current']), 'main');
  for (const args of [['remote', 'get-url', '--all', 'origin'], ['remote', 'get-url', '--push', '--all', 'origin']]) assert.equal(git(args), manifest.gitPolicy.remoteUrl);
  for (const root of [roadmapRoot, projectRoot]) assert(!fs.existsSync(path.join(root, '.git')), 'Nested .git');
  assert.equal(git(['ls-tree', '-r', '--name-only', bootstrap.baselineCommit, '--', relative(repositoryRoot, projectRoot)]), '');
  assert.equal(bootstrap.baselineCommit, fixture.baselineCommit);
  assert.equal(bootstrap.manifestHash, fileHash(manifestFile));
  assert.equal(bootstrap.initialState.completedThrough, -1);
  assert.equal(bootstrap.initialState.currentPhase, 0);
  assert.equal(bootstrap.scope.requestedThrough, 0);
  for (const [key, value] of Object.entries({ repositoryRoot, roadmapRoot, projectRoot })) assert.equal(normalized(bootstrap[key]), normalized(value));
  const files = fs.readdirSync(projectRoot, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => relative(projectRoot, path.join(entry.parentPath, entry.name)));
  const unknown = files.filter((file) => !bootstrap.allowedInitializationFiles.includes(file) && !bootstrap.allowedGeneratedPathPrefixes.some((prefix) => file.startsWith(prefix)));
  assert.deepEqual(unknown, [], 'Unknown initialization files');
  assert(!files.some((file) => /^(?:src\/|prisma\/|package(?:-lock)?\.json$|\.env|tsconfig\.json$|next\.config)/.test(file)), 'Future product artifacts');
  return { roots: { repositoryRoot, roadmapRoot, projectRoot }, baselineCommit: bootstrap.baselineCommit, files, unknownFiles: unknown, initialAdmission: fixture.preflight, publicProviderRequests: 0 };
}

function checkPinned() {
  assert.equal(manifest.executionMode, 'NEW_BUILD');
  assert.equal(manifest.operatorMode, 'AGENT_ONLY_AUTOMATED_NEW_BUILD');
  assert.equal(fixture.pinnedInputs.length, 9);
  assert.deepEqual(fixture.pinnedInputs.slice(1).map(({ id, path }) => ({ id, path })), manifest.runStatePinnedInputs);
  const results = fixture.pinnedInputs.map((input) => {
    const file = path.join(roadmapRoot, input.path);
    const object = `${bootstrap.baselineCommit}:${relative(repositoryRoot, file)}`;
    const result = spawnSync('git', ['cat-file', 'blob', object], { cwd: repositoryRoot, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr?.toString());
    assert.equal(fileHash(file), input.sha256, `${input.id} working file drift`);
    assert.equal(sha(result.stdout), input.sha256, `${input.id} baseline bytes drift`);
    assert.equal(git(['rev-parse', object]), input.gitBlob);
    return { ...input, workingSha256: fileHash(file), baselineSha256: sha(result.stdout), blobCommand: `git cat-file blob ${object}`, exitCode: result.status };
  });
  const canonical = read(path.join(roadmapRoot, 'docs/roadmap-canonical-contract.md'));
  const states = read(path.join(roadmapRoot, 'docs/state-machines.md'));
  assert(/CLONE[\s\S]*NEEDS_REVALIDATION/.test(canonical));
  const cloneRow = states.split('\n').find((line) => line.startsWith('| clone '));
  assert(cloneRow && cloneRow.includes('NEEDS_REVALIDATION') && !cloneRow.includes('MODIFIED'));
  const diff = command('git', ['diff', '--check']);
  assert.equal(diff.exitCode, 0, JSON.stringify(diff));
  return { inputs: results, canonicalCloneRow: cloneRow, diff };
}

function sourceHashes() {
  const paths = [...new Set([planPath, fixturePath, 'docs/phase-plans/bootstrap.json', 'docs/phase-plans/verify-phase000.mjs', 'docs/phase-plans/protocol-lab.mjs', ...plan.cases.map((entry) => entry.inputPath)])];
  return Object.fromEntries(paths.map((file) => [file, fileHash(local(file))]));
}

async function lab() {
  const reportPath = local(`.scaffold/Phase000/${plan.attemptId}/protocol-lab.json`);
  const key = sha(JSON.stringify(sourceHashes()));
  if (fs.existsSync(reportPath)) {
    const cached = json(reportPath);
    assert.equal(cached.sourceKey, key, 'Lab sources changed; start a new attempt');
    return cached.report;
  }
  const { runProtocolLab } = await import('./protocol-lab.mjs');
  const report = runProtocolLab({ projectRoot });
  writeJson(reportPath, { sourceKey: key, report });
  return report;
}

function negativeDocuments() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'serendipity-phase000-docs-'));
  const execution = read(local('docs/agent-execution-contract.md'));
  const constitution = read(local('docs/project-constitution.md'));
  const stack = read(local('docs/tech-stack.md'));
  const removeSection = (text, heading) => {
    const lines = text.split('\n');
    let skipping = false;
    return lines.filter((line) => {
      if (line.startsWith('## ')) skipping = line.slice(3).trim() === heading;
      return !skipping;
    }).join('\n');
  };
  const cases = [
    ['exclusions-removed', 'constitution', constitution, removeSection(constitution, fixture.constitutionHeadings[4]), 1, `heading ${fixture.constitutionHeadings[4]}`],
    ['decisions-removed', 'execution-contract', execution, removeSection(execution, fixture.executionHeadings.at(-1)), 1, '14'],
    ['npm-removed', 'tech-stack', stack, stack.split('\n').filter((line) => !line.startsWith('- \u5305\u7ba1\u7406\u5668\uff1a')).join('\n'), 1, 'explicit npm selection'],
    ['ambiguous-decision', 'execution-contract', execution, execution.replace(/^(1\. .+)$/m, '$1 \u4efb\u9009'), 1, 'decision 1 concrete'],
    ['ordinary-prose', 'execution-contract', execution, `${execution}\n## Explanation fixture\n\u5f85\u5b9a\u548c\u4efb\u9009\u662f\u89c4\u5219\u8bf4\u660e\u7684\u793a\u4f8b\u8bcd\u3002\n`, 0, ''],
    ['clone-regression', 'execution-contract', execution, execution.replace(/clone \u76ee\u6807\u72b6\u6001\u56fa\u5b9a\u4e3a `?NEEDS_REVALIDATION`?/, 'clone \u76ee\u6807\u72b6\u6001\u56fa\u5b9a\u4e3a MODIFIED'), 1, 'clone target fixed']
  ];
  return cases.map(([id, kind, original, mutated, expectedExit, diagnostic]) => {
    assert.notEqual(original, mutated, `${id} mutation changed no bytes`);
    const mutationFile = path.join(tempRoot, `${id}.md`);
    fs.writeFileSync(mutationFile, mutated);
    const observed = command(process.execPath, [scriptPath, '--probe', kind, mutationFile], projectRoot);
    assert.equal(observed.exitCode, expectedExit, JSON.stringify(observed));
    assert(observed.stdout.includes(diagnostic), `${id} wrong failure reason`);
    fs.writeFileSync(mutationFile, original);
    const restored = command(process.execPath, [scriptPath, '--probe', kind, mutationFile], projectRoot);
    assert.equal(restored.exitCode, 0, JSON.stringify(restored));
    return { id, expectedExit, diagnostic, beforeHash: sha(original), mutationHash: sha(mutated), observed, restored, restoredHash: fileHash(mutationFile) };
  });
}

async function executeCase(name) {
  const spec = plan.cases.find((entry) => entry.testCaseId === `Phase000:${name}`);
  assert(spec, `Unplanned case: ${name}`);
  const start = performance.now();
  const report = { testCaseId: spec.testCaseId, command: spec.command, attemptId: plan.attemptId, planHash: fileHash(local(planPath)), inputHash: fileHash(local(spec.inputPath)), sourceHashes: sourceHashes(), startedAt: new Date().toISOString(), runtime: { node: process.version, use: 'documentation verification only', productDependenciesInstalled: false }, simulation: true };
  try {
    if (['constitution', 'execution-contract', 'completion-log', 'tech-stack', 'directory-structure'].includes(name)) report.details = checkDocument(name, read(local(spec.inputPath)));
    else if (name === 'project-boundary') report.details = checkBoundary();
    else if (name === 'pinned-inputs') report.details = checkPinned();
    else if (name === 'checkpoint' || name === 'run-state') {
      const protocol = await lab();
      assert.equal(protocol.restored, true);
      report.details = { verificationScope: 'ISOLATED_BASELINE_CLONE', actualPostMetadataSeal: 'REQUIRED_AFTER_METADATA', protocol };
    } else if (name === 'negative-validation') {
      const protocol = await lab();
      assert.equal(protocol.restored, true);
      assert(protocol.negativeChecks.length >= 6, 'Missing protocol failure paths');
      report.details = { documents: negativeDocuments(), protocol };
    } else throw new Error(`No implementation for case ${name}`);
    report.exitCode = 0;
    report.status = 'PASS';
    report.numerator = spec.denominator;
  } catch (error) {
    report.exitCode = 1;
    report.status = 'FAIL';
    report.numerator = 0;
    report.failure = error.message;
    if (error.protocolReport) report.protocolFailure = error.protocolReport;
  }
  report.denominator = spec.denominator;
  report.durationMs = Math.round(performance.now() - start);
  report.completedAt = new Date().toISOString();
  writeJson(local(spec.outputPath), report);
  console.log(JSON.stringify({ testCaseId: spec.testCaseId, status: report.status, outputPath: spec.outputPath, failure: report.failure }));
  return report.exitCode;
}

function auditReports() {
  assert.equal(plan.phase, 0);
  assert.equal(plan.requiredCaseIds.length, 10);
  assert.deepEqual(plan.cases.map((entry) => entry.testCaseId), plan.requiredCaseIds);
  assert.equal(new Set(plan.requiredCaseIds).size, 10);
  const sources = sourceHashes();
  return plan.cases.map((spec) => {
    const report = json(local(spec.outputPath));
    assert.equal(report.status, 'PASS', `${spec.testCaseId} failed`);
    assert.equal(report.exitCode, 0);
    assert.equal(report.testCaseId, spec.testCaseId);
    assert.equal(report.command, spec.command);
    assert.equal(report.attemptId, plan.attemptId);
    assert.equal(report.planHash, fileHash(local(planPath)));
    assert.equal(report.inputHash, fileHash(local(spec.inputPath)));
    assert.equal(report.numerator, spec.denominator);
    assert.equal(report.denominator, spec.denominator);
    assert.deepEqual(report.sourceHashes, sources, 'Sources changed after testing');
    return report;
  });
}

async function metadata() {
  const reports = auditReports();
  checkPinned();
  const reviewPath = `${attemptDirectory}/review.json`;
  const review = json(local(reviewPath));
  assert.equal(review.decision, 'PASS');
  assert.equal(review.planHash, fileHash(local(planPath)));
  assert(review.reviewerRunId && review.contextId && review.runnerIdentity);
  assert.deepEqual(review.sourceHashes, sourceHashes(), 'Review must cover tested sources');
  const artifactCommit = git(['rev-parse', 'HEAD']);
  assert.equal(git(['log', '-1', '--format=%s']), 'phase(000): artifact');
  const prefix = relative(repositoryRoot, projectRoot);
  const artifacts = [...new Set([...Object.keys(sourceHashes()), ...plan.cases.map((entry) => entry.outputPath), reviewPath])];
  for (const file of artifacts) {
    const probe = spawnSync('git', ['cat-file', 'blob', `${artifactCommit}:${prefix}/${file}`], { cwd: repositoryRoot, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(probe.status, 0, `Artifact missing ${file}`);
    assert.equal(sha(probe.stdout), fileHash(local(file)), `Artifact byte drift ${file}`);
  }
  const results = plan.cases.map((spec, index) => ({ testCaseId: spec.testCaseId, command: spec.command, exitCode: reports[index].exitCode, numerator: reports[index].numerator, denominator: spec.denominator, inputHash: `sha256:${fileHash(local(spec.inputPath))}`, outputHash: `sha256:${fileHash(local(spec.outputPath))}`, status: reports[index].status, details: { inputPath: spec.inputPath, outputPath: spec.outputPath, expected: spec.expected } }));
  const evidence = {
    schemaVersion: 'agent-gate-v1', phase: 0, attemptId: plan.attemptId, status: 'PASS', simulation: true,
    operatorMode: manifest.operatorMode, environment: { isolated: true, syntheticUsers: true, providerMode: 'contract-replay', productionTraffic: false },
    artifactCommit, requiredCaseIds: plan.requiredCaseIds, results,
    commands: results.map(({ command, exitCode }) => ({ command, exitCode })),
    inputs: Object.entries(sourceHashes()).map(([file, hash]) => ({ path: file, sha256: hash })), failures: [], generatedAt: new Date().toISOString(),
    details: { planPath, planHash: fileHash(local(planPath)), testedTree: git(['rev-parse', 'HEAD^{tree}']), reviewerRunId: review.reviewerRunId, reviewReportPath: reviewPath, reviewReportHash: fileHash(local(reviewPath)), recoveryCommits: git(['rev-list', '--reverse', `${bootstrap.baselineCommit}..${artifactCommit}^`]).split('\n').filter(Boolean), waived: false, originalThreshold: 10, automatedThreshold: 10, verificationScope: 'PHASE000_DOCUMENTS_AND_ISOLATED_CHECKPOINT', notEvaluated: plan.notApplicable, pendingAfterMetadata: plan.postMetadataChecks, requestedThrough: 0,
      costAccounting: { unit: 'milliseconds', basis: 'actual process monotonic timers for verification; other categories not measured', productImplementation: null, testInfrastructure: null, execution: reports.reduce((sum, report) => sum + report.durationMs, 0), independentReview: review.durationMs ?? null, evidencePreparation: null, cpuPeak: null, memoryPeak: null, artifactBytes: artifacts.reduce((sum, file) => sum + fs.statSync(local(file)).size, 0), retryCount: plan.previousAttempts?.length ?? 0, externalProviderCalls: 0, unmeasured: ['productImplementation', 'testInfrastructure', 'evidencePreparation', 'cpuPeak', 'memoryPeak'] } }
  };
  const gatePath = 'docs/evidence/Phase000-gate.json';
  writeJson(local(gatePath), evidence);
  const { createRunState } = await import('./protocol-lab.mjs');
  const state = createRunState({ manifest, manifestHash: fileHash(manifestFile), repositoryRoot: bootstrap.repositoryRoot, roadmapRoot: bootstrap.roadmapRoot, projectRoot: bootstrap.projectRoot, baselineCommit: bootstrap.baselineCommit, artifactCommit, contractHashes: Object.fromEntries(fixture.pinnedInputs.slice(1).map((input) => [input.id, input.sha256])), evidenceHash: fileHash(local(gatePath)) });
  writeJson(local('docs/roadmap-run.json'), state);
  const template = read(local('docs/phase-plans/completion-log-template.md'));
  const files = [...artifacts, gatePath, 'docs/roadmap-run.json', 'docs/phase-completion-log.md'].map((file) => `\`${file}\``).join(', ');
  const row = `| Phase000 | \u4e94\u4efd\u89c4\u8303\u3001\u542f\u52a8\u6536\u636e\u4e0e\u53ef\u6062\u590d\u53cc\u63d0\u4ea4\u68c0\u67e5\u70b9\u5019\u9009 | ${files} | \`node docs/phase-plans/verify-phase000.mjs --all\`: 10/10 PASS; \`--audit\`: PASS; \u9694\u79bb\u526f\u672c\u53cc shell \u6b63\u53cd\u5411 PASS; artifactCommit=\`${artifactCommit}\`; attemptId=\`${plan.attemptId}\` | \u672a\u521b\u5efa\u4ea7\u54c1 npm \u811a\u672c\uff0c\u672c\u5361\u65e0\u4e1a\u52a1\u3001\u6570\u636e\u5e93\u548c\u6d4f\u89c8\u5668\u6d4b\u8bd5 | \u53ef\u5c01\u53e3\u5019\u9009\uff1b\u6b63\u5f0f metadata \u540e\u6267\u884c\u53cc shell seal\u3001clean \u4e0e GitHub \u540c\u6b65\uff0c\u901a\u8fc7\u540e\u53ef\u8fdb\u5165\u4e0b\u4e00 Phase\uff1b\u672c\u6b21\u6388\u6743\u8303\u56f4\u6b62\u4e8e 000 |\n`;
  fs.writeFileSync(local('docs/phase-completion-log.md'), template + row, { flag: 'wx' });
  checkDocument('completion-log', read(local('docs/phase-completion-log.md')));
  console.log(JSON.stringify({ status: 'METADATA_CANDIDATE_CREATED', artifactCommit, gatePath, evidenceHash: fileHash(local(gatePath)), completedThrough: state.completedThrough, currentPhase: state.currentPhase }));
}

async function main() {
  const [mode, name, file] = process.argv.slice(2);
  if (mode === '--probe') {
    try { console.log(JSON.stringify({ status: 'PASS', ...checkDocument(name, read(file)) })); }
    catch (error) { console.log(JSON.stringify({ status: 'FAIL', error: error.message })); process.exitCode = 1; }
  } else if (mode === '--case') process.exitCode = await executeCase(name);
  else if (mode === '--all') {
    const observations = [];
    for (const spec of plan.cases) {
      const observation = command(process.execPath, [scriptPath, '--case', spec.testCaseId.split(':')[1]], projectRoot);
      observations.push(observation);
      process.stdout.write(observation.stdout);
      if (observation.exitCode !== 0) {
        writeJson(local(`${attemptDirectory}/attempt.json`), { phase: 0, attemptId: plan.attemptId, status: 'FAIL', blockedCategory: 'VERIFICATION', artifactCommit: null, planHash: fileHash(local(planPath)), sourceHashes: sourceHashes(), commands: observations, generatedAt: new Date().toISOString() });
        fs.copyFileSync(local(planPath), local(`${attemptDirectory}/plan.json`), fs.constants.COPYFILE_EXCL);
        writeJson(local(`${attemptDirectory}/source-snapshot.json`), Object.fromEntries(Object.keys(sourceHashes()).map((file) => [file, read(local(file))])));
        process.exitCode = 1;
        return;
      }
    }
    auditReports();
    console.log(JSON.stringify({ status: 'PASS', numerator: 10, denominator: 10 }));
  } else if (mode === '--audit') console.log(JSON.stringify({ status: 'PASS', checks: auditReports().length, sourceHashes: sourceHashes() }));
  else if (mode === '--metadata') await metadata();
  else if (mode === '--next-attempt') {
    assert(fs.existsSync(local(`${attemptDirectory}/attempt.json`)), 'Only a failed attempt can be retried');
    const next = `attempt-${Number(plan.attemptId.split('-').at(-1)) + 1}`;
    const updated = { ...plan, attemptId: next, previousAttempts: [...(plan.previousAttempts ?? []), { attemptId: plan.attemptId, planPath: `${attemptDirectory}/plan.json`, planHash: fileHash(local(planPath)) }], cases: plan.cases.map((entry) => ({ ...entry, outputPath: `docs/evidence/attempts/Phase000/${next}/${path.posix.basename(entry.outputPath)}` })) };
    writeJson(local(planPath), updated, false);
    console.log(JSON.stringify({ previousAttempt: plan.attemptId, nextAttempt: next }));
  } else throw new Error('Use --all, --case NAME, --audit, --metadata or --next-attempt');
}

main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
