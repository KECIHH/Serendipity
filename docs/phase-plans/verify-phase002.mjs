import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { domainToASCII, fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyApi, verifyForbiddenRoutes } from './check-phase002-api.mjs';
import { verifyPrompt, verifySchema } from './check-phase002-schema-prompt.mjs';
import { checkProvider, checkPrivacy } from './check-phase002-provider-privacy.mjs';
import { checkGeneratedRegistry, loadRegistry, validateRegistry } from '../../scripts/generate-api-contract.mjs';
import { requireEvidenceSources, requireHashCoverage, requireReviewIdentity, requireReportBinding } from '../../scripts/phase-evidence.mjs';

const originalRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runnerPath = path.join(originalRoot, 'docs/phase-plans/verify-phase002.mjs');
const planPath = 'docs/phase-plans/Phase002.json';
const receiptPath = 'docs/phase-plans/Phase002-inputs.json';
const frozenReviewPath = 'docs/evidence/attempts/Phase002/attempt-4/review.json';
const frozenReviewHash = '872ea77c344211b84a2bced9aa65377e44049394ca5d5a5ae31828066e4f5858';
export const documentPaths = Object.freeze(['docs/api.md', 'docs/prompt-design.md', 'docs/travel-plan-schema.md',
  'docs/travel-data-provider-strategy.md', 'docs/privacy-and-user-data.md', 'docs/index.md',
  'docs/auth.md', 'docs/hosting.md', 'docs/admin.md', 'docs/crypto.md']);
export const phase002SourcePaths = Object.freeze([
  '.gitattributes', 'AGENTS.md', frozenReviewPath, ...documentPaths, 'docs/agent-execution-contract.md', 'docs/database.md', 'docs/directory-structure.md',
  planPath, receiptPath, 'docs/phase-plans/check-phase002-api.mjs', 'docs/phase-plans/check-phase002-provider-privacy.mjs',
  'docs/phase-plans/check-phase002-schema-prompt.mjs', 'docs/phase-plans/complete-phase002.mjs',
  'docs/phase-plans/retry-phase002.mjs', 'docs/phase-plans/verify-phase002.mjs',
  'docs/project-constitution.md', 'docs/project-layout.json', 'docs/tech-stack.md', 'docs/ui-design-system.md',
  'scripts/check-project-layout.mjs', 'scripts/generate-api-contract.mjs', 'scripts/phase-evidence.mjs',
  'scripts/validate-phase.mjs', 'scripts/validate-phase.ps1',
].sort());

export const sha256 = value => createHash('sha256').update(value).digest('hex');
const bytes = (root, relative) => fs.readFileSync(path.join(root, relative));
const text = (root, relative) => bytes(root, relative).toString('utf8').replace(/^\uFEFF/, '');
const json = (root, relative) => JSON.parse(text(root, relative));
const hash = (root, relative) => sha256(bytes(root, relative));
const normalized = value => path.resolve(value).replaceAll(path.sep, '/');
const within = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
function requireThat(condition, code, message = code) { assert(condition, `${code}: ${message}`); }
function writeJson(root, relative, value, exclusive = true) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { flag: exclusive ? 'wx' : 'w' });
}
function run(root, executable, commandArgs, timeout = 180000) {
  const env = { ...process.env }; delete env.PSModulePath;
  const result = spawnSync(executable, commandArgs, { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { command: [executable, ...commandArgs].map(value => /\s/.test(value) ? `'${value.replaceAll("'", "''")}'` : value).join(' '), exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}
function successful(result) { assert.equal(result.exitCode, 0, `${result.command}\n${result.stderr}\n${result.stdout}`); return result; }
const git = (root, args) => successful(run(root, 'git', ['-c', 'core.quotepath=false', ...args])).stdout.trim();

export function failureDetails(error) {
  const assertion = error instanceof Error && error.name === 'AssertionError' && error.code === 'ERR_ASSERTION';
  const message = error instanceof Error ? error.message : String(error);
  return { status: 'FAIL', failureClass: assertion ? 'CONTRACT_ASSERTION' : 'CHECKER_RUNTIME_ERROR',
    errorName: error?.name || 'NonErrorThrow', errorCode: error?.code || null,
    diagnostic: message.split(/\r?\n/, 1)[0], message };
}

export function requireContractFailure(result, expectedDiagnostic, id) {
  assert.equal(result.exitCode, 1, `NEGATIVE_EXIT_CODE: ${id}`);
  requireThat(result.stdout.trim() === '', 'NEGATIVE_UNEXPECTED_OUTPUT', id);
  let failure;
  try { failure = JSON.parse(result.stderr.trim()); }
  catch { assert.fail(`NEGATIVE_FAILURE_REPORT: ${id}`); }
  requireThat(failure?.status === 'FAIL' && failure.failureClass === 'CONTRACT_ASSERTION'
    && failure.errorName === 'AssertionError' && failure.errorCode === 'ERR_ASSERTION', 'NEGATIVE_UNEXPECTED_ERROR', id);
  requireThat(typeof failure.diagnostic === 'string' && (failure.diagnostic === expectedDiagnostic
    || failure.diagnostic.startsWith(`${expectedDiagnostic}:`)), 'NEGATIVE_WRONG_DIAGNOSTIC', `${id}: ${failure.diagnostic}`);
  return failure;
}

export function requirePhase002Sources(plan) {
  assert.equal(plan.phase, 2, 'PLAN_PHASE');
  assert.equal(plan.requestedThrough, 2, 'PLAN_AUTHORIZED_SCOPE');
  const sources = requireEvidenceSources(plan);
  assert.deepEqual(sources, phase002SourcePaths, 'PHASE002_SOURCE_COVERAGE');
  assert.deepEqual(plan.requiredCaseIds, ['api', 'prompt', 'schema', 'provider', 'privacy', 'index', 'forbidden-routes', 'links'].map(name => `Phase002:${name}`), 'PHASE002_FIXED_CASES');
  assert.deepEqual(plan.cases.map(item => item.testCaseId), plan.requiredCaseIds, 'PHASE002_CASE_ORDER');
  for (const item of plan.cases) {
    assert.equal(item.denominator, 1, 'PHASE002_GROUP_DENOMINATOR');
    assert.equal(item.command, `node docs/phase-plans/verify-phase002.mjs --case ${item.testCaseId.split(':')[1]}`, 'PHASE002_COMMAND');
    assert.equal(item.outputPath, `docs/evidence/attempts/Phase002/${plan.attemptId}/${item.testCaseId.split(':')[1]}.json`, 'PHASE002_OUTPUT');
  }
  assert.equal(plan.threshold.originalThreshold, 8);
  assert.equal(plan.threshold.automatedThreshold, 8);
  assert.equal(plan.threshold.waived, false);
  return sources;
}

export function sourceHashes(root) { return Object.fromEntries(phase002SourcePaths.map(relative => [relative, hash(root, relative)])); }

export function checkPins(root) {
  const receipt = json(root, receiptPath);
  const first = json(root, 'docs/phase-plans/Phase001-inputs.json');
  const { manifest } = loadRegistry(root);
  assert.equal(receipt.phase, 2);
  assert.equal(receipt.requestedThrough, 2);
  assert.equal(receipt.layoutVersion, 2);
  assert.equal(receipt.phaseStartCommit, receipt.preflight.head);
  assert.equal(receipt.executionBaselineCommit, first.executionBaselineCommit);
  assert.equal(receipt.baselineCommit, first.baselineCommit);
  assert.equal(new Set(receipt.pinnedInputs.map(pin => pin.id)).size, receipt.pinnedInputs.length, 'PIN_DUPLICATE_ID');
  assert.equal(new Set(receipt.pinnedInputs.map(pin => pin.path)).size, receipt.pinnedInputs.length, 'PIN_DUPLICATE_PATH');
  for (const pin of receipt.pinnedInputs) {
    assert.deepEqual(Object.keys(pin).sort(), ['id', 'path', 'sha256'], 'PIN_FORMAT');
    requireThat(pin.path.startsWith(`${receipt.roadmapRoot}/`) && !pin.path.includes('..'), 'PIN_PATH');
    requireThat(within(fs.realpathSync(path.join(root, receipt.roadmapRoot)), fs.realpathSync(path.join(root, pin.path))), 'PIN_SYMLINK_ESCAPE');
    assert.equal(hash(root, pin.path), pin.sha256, `PIN_HASH: ${pin.id}`);
    assert.equal(receipt.sourceLocations[pin.id], normalized(path.join(originalRoot, pin.path)), `PIN_ABSOLUTE_SOURCE: ${pin.id}`);
  }
  const expected = ['manifest', ...manifest.runStatePinnedInputs.map(input => input.id)];
  for (const id of expected) assert.deepEqual(receipt.pinnedInputs.find(pin => pin.id === id), first.pinnedInputs.find(pin => pin.id === id), `FROZEN_RUN_INPUT: ${id}`);
  for (const contract of manifest.localContracts.filter(item => item.required)) requireThat(receipt.pinnedInputs.some(pin => pin.id === contract.id && pin.path === `${receipt.roadmapRoot}/${contract.path}`), 'PIN_REQUIRED_CONTRACT');
  assert.equal(receipt.pinnedInputs.find(pin => pin.id === 'manifest').sha256, receipt.manifestHash);
  assert.equal(receipt.pinnedInputs.find(pin => pin.id === 'phase-card').path, `${receipt.roadmapRoot}/Phase002.md`);
  assert.equal(receipt.preflight.porcelain, '', 'ADMISSION_WAS_CLEAN');
  assert.equal(receipt.preflight.originMain, receipt.phaseStartCommit, 'ADMISSION_WAS_SYNCED');
  assert.equal(receipt.preflight.completedThrough, 1);
  assert.equal(receipt.preflight.currentPhase, 2);
  assert.equal(receipt.preflight.branch, 'main');
  assert.equal(receipt.preflight.remote, manifest.gitPolicy.remoteUrl);
  assert.equal(hash(root, receipt.recovery.originalReceiptPath), receipt.recovery.originalReceiptHash, 'RECOVERED_RECEIPT_HASH');
  const previousReceipt = json(root, receipt.recovery.originalReceiptPath);
  assert.deepEqual(previousReceipt.pinnedInputs.map(({ sourceAbsolutePath, ...pin }) => pin), receipt.pinnedInputs, 'RECOVERY_DID_NOT_CHANGE_INPUTS');
  return { pinnedInputs: receipt.pinnedInputs.length, frozenRunInputs: expected.length, sourceHashesUnchangedAcrossRecovery: true };
}

function markerBody(content, name) {
  const start = `<!-- ${name}:start -->`; const end = `<!-- ${name}:end -->`;
  assert.equal(content.split(start).length, 2, `INDEX_MARKER: ${name}`);
  assert.equal(content.split(end).length, 2, `INDEX_MARKER: ${name}`);
  return content.split(start)[1].split(end)[0];
}
function table(content) {
  return content.split('\n').filter(line => line.trim().startsWith('|')).map(line => line.trim().slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim())).filter(row => !row.every(cell => /^:?-+:?$/.test(cell)));
}
function prose(content) {
  let fence = null;
  return content.split('\n').map(line => {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (match && (!fence || match[1][0] === fence)) { fence = fence ? null : match[1][0]; return ''; }
    return fence ? '' : line;
  }).join('\n');
}
export function markdownLinks(content) {
  const plain = prose(content).replace(/(`+)([\s\S]*?)\1/g, '');
  const links = [];
  for (const match of plain.matchAll(/\[[^\]\n]+\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g)) links.push(match[1] || match[2]);
  const references = new Map([...plain.matchAll(/^\s*\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/gm)].map(match => [match[1].toLowerCase(), match[2] || match[3]]));
  for (const match of plain.matchAll(/\[([^\]]+)\]\[([^\]]*)\]/g)) {
    const id = (match[2] || match[1]).toLowerCase();
    requireThat(references.has(id), 'LINK_REFERENCE_MISSING', id); links.push(references.get(id));
  }
  for (const match of plain.matchAll(/<a\s+[^>]*href=["']([^"']+)["']/g)) links.push(match[1]);
  return links;
}
function anchors(content) {
  const plain = prose(content); const counts = new Map(); const result = new Set();
  for (const match of plain.matchAll(/<a\s+[^>]*(?:id|name)=["']([^"']+)["']/g)) result.add(match[1]);
  for (const match of plain.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1].replace(/<[^>]+>/g, '').replace(/[\[\]`*_]/g, '').trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
    const number = counts.get(base) || 0; counts.set(base, number + 1); result.add(number ? `${base}-${number}` : base);
  }
  return result;
}
function resolveLink(root, owner, href) {
  requireThat(!/^(?:https?:|mailto:|data:|javascript:)/i.test(href), 'LINK_EXTERNAL_UNPINNED', href);
  const separator = href.indexOf('#');
  const target = decodeURIComponent(separator < 0 ? href : href.slice(0, separator));
  const fragment = separator < 0 ? null : decodeURIComponent(href.slice(separator + 1));
  const receipt = json(root, receiptPath);
  let file;
  if (/^[A-Za-z]:[\/]/.test(target) || path.isAbsolute(target)) {
    const normalizedTarget = target.replaceAll('\\', '/');
    const pin = receipt.pinnedInputs.find(input => receipt.sourceLocations[input.id] === normalizedTarget);
    requireThat(pin, 'LINK_UNPINNED_ABSOLUTE_SOURCE', href);
    file = path.join(root, pin.path);
    requireThat(hash(root, pin.path) === pin.sha256, 'LINK_PIN_HASH', pin.id);
  } else {
    file = target ? path.resolve(root, path.dirname(owner), target) : path.join(root, owner);
    requireThat(within(root, file), 'LINK_ROOT_ESCAPE', href);
    requireThat(!within(path.join(root, receipt.roadmapRoot), file), 'LINK_ROADMAP_REQUIRES_ABSOLUTE_SOURCE', href);
  }
  requireThat(fs.existsSync(file) && fs.statSync(file).isFile(), 'LINK_MISSING_FILE', `${owner} -> ${href}`);
  requireThat(within(fs.realpathSync(root), fs.realpathSync(file)), 'LINK_SYMLINK_ESCAPE', href);
  if (fragment) requireThat(anchors(fs.readFileSync(file, 'utf8')).has(fragment), 'LINK_MISSING_FRAGMENT', `${owner} -> ${href}`);
  return path.relative(root, file).replaceAll(path.sep, '/');
}

export function checkIndexDocuments(root) {
  const content = text(root, 'docs/index.md');
  const { manifest } = loadRegistry(root);
  const entries = table(markerBody(content, 'project-contract-index'));
  assert.deepEqual(entries.shift(), ['id', 'file', 'owner', 'producerPhase', 'consumers', 'hashRecord'], 'INDEX_COLUMNS');
  const expected = manifest.projectContracts.filter(contract => contract.required && contract.producerPhase <= 2);
  assert.equal(entries.length, expected.length, 'INDEX_CONTRACT_COUNT');
  assert.equal(new Set(entries.map(row => row[0])).size, entries.length, 'INDEX_DUPLICATE_OWNER');
  for (const contract of expected) {
    const row = entries.find(item => item[0] === contract.id);
    requireThat(row && row.length === 6 && row.every(Boolean), 'INDEX_INCOMPLETE_ENTRY', contract.id);
    assert.equal(Number(row[3]), contract.producerPhase, 'INDEX_PRODUCER');
    const links = markdownLinks(row[1]); assert.equal(links.length, 1);
    assert.equal(resolveLink(root, 'docs/index.md', links[0]), contract.path, 'INDEX_CONTRACT_PATH');
  }
  assert.equal(entries.filter(row => Number(row[3]) === 2).length, 10);
  const sourceRows = table(markerBody(content, 'input-sources')); sourceRows.shift();
  const receipt = json(root, receiptPath);
  const expectedIds = ['manifest', ...manifest.runStatePinnedInputs.map(input => input.id), 'phase-card'];
  assert.deepEqual(sourceRows.map(row => row[0]).sort(), expectedIds.sort(), 'INDEX_INPUT_SET');
  for (const row of sourceRows) {
    const pin = receipt.pinnedInputs.find(input => input.id === row[0]);
    assert.equal(row[2], pin.sha256, 'INDEX_INPUT_HASH');
    assert.deepEqual(markdownLinks(row[1]), [receipt.sourceLocations[pin.id]], 'INDEX_INPUT_ABSOLUTE_SOURCE');
  }
  const features = table(markerBody(content, 'feature-matrix'));
  assert.deepEqual(features.shift(), ['featureId', 'page', 'schema', 'database', 'apiOperationIds', 'producerPhases', 'tests']);
  assert.deepEqual(features.map(row => row[0]), Array.from({ length: 12 }, (_, i) => `F-${String(i + 1).padStart(2, '0')}`), 'FEATURE_COVERAGE');
  const operations = new Set(manifest.apiRegistry.map(operation => operation.operationId));
  for (const row of features) {
    requireThat(row.length === 7 && row.every(Boolean), 'FEATURE_MATRIX_EMPTY_CELL', row[0]);
    for (const operation of row[4].split(',')) requireThat(operations.has(operation), 'FEATURE_UNKNOWN_OPERATION', operation);
  }
  for (const phrase of ['repositoryRoot=projectRoot', '历史非权威区', '149', '8/8', 'Phase001', '真实 HTTP']) requireThat(content.includes(phrase), 'INDEX_BOUNDARY', phrase);
  return { currentProjectContracts: expected.length, phase002Contracts: 10, featureCoverage: { numerator: 12, denominator: 12 }, absolutePrimaryInputs: sourceRows.length };
}

export function checkLinks(root) {
  const observations = [];
  for (const relative of documentPaths) {
    const content = text(root, relative);
    requireThat(content.length > 0 && !content.includes('\r'), 'DOCUMENT_LF', relative);
    for (const href of markdownLinks(content)) observations.push({ owner: relative, href, target: resolveLink(root, relative, href) });
    if (relative !== 'docs/api.md') requireThat(!content.includes('<!-- api-registry:start -->'), 'SECOND_API_REGISTRY', relative);
  }
  for (const forbidden of ['docs/api-spec.md', 'docs/api-contract.md']) requireThat(!fs.existsSync(path.join(root, forbidden)), 'SECOND_API_CONTRACT', forbidden);
  const registry = checkGeneratedRegistry(root);
  return { contractCount: documentPaths.length, linkCount: observations.length, unresolvedLinks: 0, duplicateCanonicalEndpoints: registry.duplicateEndpoints, observations };
}

function checkScope(root) {
  const plan = json(root, planPath); requirePhase002Sources(plan);
  const receipt = json(root, receiptPath);
  assert.equal(git(root, ['rev-parse', 'HEAD']), receipt.phaseStartCommit, 'PHASE_START_CHANGED_BEFORE_ARTIFACT');
  const changed = new Set([...git(root, ['diff', '--name-only', receipt.phaseStartCommit]).split('\n'), ...git(root, ['ls-files', '--others', '--exclude-standard']).split('\n')].filter(Boolean));
  for (const file of changed) requireThat(plan.modificationScope.some(scope => scope.endsWith('/') ? file.startsWith(scope) : file === scope), 'PHASE_SCOPE', file);
  for (const file of ['src', 'prisma', 'tests', 'public', 'package.json', 'package-lock.json', 'node_modules', '.env']) requireThat(!fs.existsSync(path.join(root, file)), 'PREMATURE_PRODUCT', file);
  for (const file of phase002SourcePaths) requireThat(!bytes(root, file).includes(13), 'SOURCE_LF', file);
  assert.equal(git(root, ['remote', 'get-url', 'origin']), receipt.preflight.remote, 'REMOTE_CHANGED');
  assert.equal(git(root, ['remote', 'get-url', '--push', 'origin']), receipt.preflight.remote, 'REMOTE_CHANGED');
  return { changedFiles: changed.size, productArtifactsCreated: 0, sourceCount: phase002SourcePaths.length };
}

function checkWhitespacePolicy(root) {
  const rules = text(root, '.gitattributes').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  assert.deepEqual(rules, ['* text=auto eol=lf', `${frozenReviewPath} whitespace=-blank-at-eof`], 'FROZEN_EVIDENCE_WHITESPACE_SCOPE');
  assert.equal(hash(root, frozenReviewPath), frozenReviewHash, 'FROZEN_REVIEW_BYTE_HASH');
  const review = json(root, frozenReviewPath);
  assert.equal(review.decision, 'FAIL'); assert.equal(review.phase, 2); assert.equal(review.attemptId, 'attempt-4');
  const reviewBytes = bytes(root, frozenReviewPath);
  requireThat(!reviewBytes.includes(13) && !text(root, frozenReviewPath).startsWith('\uFEFF'), 'FROZEN_REVIEW_LF');
  assert.equal(text(root, frozenReviewPath).match(/\n*$/)[0].length, 2, 'FROZEN_REVIEW_CAPTURED_EOF');
  return { scope: 'EXACT_IMMUTABLE_FAILED_REVIEW', path: frozenReviewPath, sha256: frozenReviewHash,
    allowedDiagnostic: 'new blank line at EOF', preservedTrailingLFCount: 2, originalBytesPreserved: true };
}

function checkGitWhitespace(root) {
  const policy = checkWhitespacePolicy(root);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'serendipity-phase002-whitespace-'));
  successful(run(temporary, 'git', ['init', '--quiet']));
  fs.writeFileSync(path.join(temporary, '.gitattributes'), bytes(root, '.gitattributes'));
  const reviewFile = path.join(temporary, frozenReviewPath);
  fs.mkdirSync(path.dirname(reviewFile), { recursive: true });
  fs.writeFileSync(reviewFile, bytes(root, frozenReviewPath));
  const ordinaryFile = path.join(temporary, 'ordinary.json');
  fs.writeFileSync(ordinaryFile, '{}\n');
  const stagedFiles = ['.gitattributes', frozenReviewPath, 'ordinary.json'];
  const stage = () => successful(run(temporary, 'git', ['add', '--', ...stagedFiles]));
  const check = () => run(temporary, 'git', ['diff', '--cached', '--check']);
  stage();
  const baseline = successful(check());
  const observations = [];
  for (const item of [
    { id: 'ordinary-json-extra-eof', file: ordinaryFile, mutate: value => Buffer.from(`${value.toString('utf8')}\n`), diagnostic: 'ordinary.json:2: new blank line at EOF.' },
    { id: 'frozen-review-trailing-space', file: reviewFile, mutate: value => Buffer.from(value.toString('utf8').replace('{\n', '{ \n')), diagnostic: `${frozenReviewPath}:1: trailing whitespace.` },
  ]) {
    const original = fs.readFileSync(item.file);
    fs.writeFileSync(item.file, item.mutate(original)); stage();
    const rejected = check();
    assert.equal(rejected.exitCode, 2, `GIT_WHITESPACE_NEGATIVE_EXIT: ${item.id}`);
    assert.equal(rejected.stderr, '', `GIT_WHITESPACE_STDERR: ${item.id}`);
    requireThat(rejected.stdout.split('\n').includes(item.diagnostic), 'GIT_WHITESPACE_WRONG_DIAGNOSTIC', item.id);
    fs.writeFileSync(item.file, original); stage();
    const restored = successful(check());
    observations.push({ id: item.id, expectedDiagnostic: item.diagnostic, rejected, restored });
  }
  assert.equal(sha256(fs.readFileSync(reviewFile)), frozenReviewHash, 'WHITESPACE_FIXTURE_RESTORES_ORIGINAL');
  return { policy, temporary, baseline, observations, exceptionAppliesOnlyToCapturedEOF: true };
}

function checkAdmission(root) {
  const receipt = json(root, receiptPath);
  const first = json(root, 'docs/phase-plans/Phase001-inputs.json');
  const state = json(root, 'docs/roadmap-run.json');
  assert.equal(state.completedThrough, 1); assert.equal(state.currentPhase, 2);
  assert.deepEqual(state.currentLayoutPhaseSeal, receipt.preflight.checkpoint);
  assert.equal(git(root, ['rev-parse', `${receipt.phaseStartCommit}^`]), receipt.preflight.checkpoint.artifactCommit);
  assert.equal(hash(root, receipt.preflight.checkpoint.evidencePath), receipt.preflight.checkpoint.evidenceHash);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'serendipity-phase002-admission-'));
  const checkout = path.join(temporary, 'repository');
  successful(run(root, 'git', ['clone', '--quiet', '--no-checkout', '--no-hardlinks', root, checkout]));
  successful(run(checkout, 'git', ['checkout', '--quiet', 'main']));
  assert.equal(git(checkout, ['rev-parse', 'HEAD']), receipt.phaseStartCommit, 'ADMISSION_CHECKOUT_COMMIT');
  successful(run(checkout, 'git', ['remote', 'set-url', 'origin', receipt.preflight.remote]));
  for (const pin of new Map([...first.pinnedInputs, ...receipt.pinnedInputs].map(pin => [pin.path, pin])).values()) {
    const target = path.join(checkout, pin.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, pin.path), target);
    assert.equal(sha256(fs.readFileSync(target)), pin.sha256);
  }
  const observations = [];
  for (const shell of ['powershell', 'pwsh']) {
    const result = successful(run(checkout, shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/validate-phase.ps1', '-CompletedThrough', '1', '-Strict', '-Json']));
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'PASS'); assert.equal(report.metadataCommit, receipt.phaseStartCommit);
    assert.equal(report.preservedHistoricalFiles, 44);
    observations.push({ shell, ...result });
  }
  assert.equal(git(checkout, ['status', '--porcelain=v1', '--untracked-files=all']), '');
  return { phaseStartCommit: receipt.phaseStartCommit, originalAdmissionWasCleanAndSynced: true, isolatedPredecessorSeal: observations, historicalFilesPreserved: 44, temporary, productionTraffic: false };
}

export function readPolicy(root, file, name) {
  const content = text(root, file); const marker = `<!-- contract:${name} -->`;
  assert.equal(content.split(marker).length, 2, `POLICY_BLOCK_COUNT: ${name}`);
  const match = content.split(marker)[1].match(/^\s*```json\s*([\s\S]*?)```/);
  requireThat(match, 'POLICY_JSON', name);
  return JSON.parse(match[1]);
}
function fixtureCollector() {
  const fixtures = [];
  return { fixtures, test(id, fn) { requireThat(!fixtures.some(item => item.id === id), 'FIXTURE_DUPLICATE_ID', id); fn(); fixtures.push({ id, status: 'PASS' }); },
    reject(id, fn, diagnostic) {
      this.test(id, () => assert.throws(fn, error => error instanceof Error && !['TypeError', 'ReferenceError', 'SyntaxError'].includes(error.name) && error.message.includes(diagnostic), `${id}: expected contract rejection ${diagnostic}`));
    } };
}
function exactKeys(value, keys, code) { requireThat(value && typeof value === 'object' && !Array.isArray(value), code); assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), code); }

function checkAuthentication(root) {
  const policy = readPolicy(root, 'docs/auth.md', 'auth-policy'); const collector = fixtureCollector();
  exactKeys(policy, ['schemaVersion', 'producerPhase', 'implementationPhases', 'roles', 'userStatuses', 'sessionStatuses', 'email', 'password', 'session', 'throttle', 'csrf', 'registration', 'erasure'], 'AUTH_POLICY_FIELDS');
  assert.equal(policy.producerPhase, 2); assert.equal(policy.schemaVersion, 1);
  assert.deepEqual(policy.roles, ['USER', 'ADMIN']); assert.deepEqual(policy.sessionStatuses, ['ACTIVE', 'REVOKED', 'EXPIRED']);
  assert.deepEqual(policy.password, { encoding: 'UTF-8', minBytes: 12, maxBytes: 72, normalize: false, algorithm: 'bcryptjs', cost: 12, missingAccountCompare: 'DUMMY_HASH' }, 'AUTH_PASSWORD_POLICY');
  assert.equal(policy.email.normalizer, 'normalizeEmailV1'); assert.equal(policy.email.localPart, 'ASCII_DOT_ATOM');
  assert.equal(policy.email.domain, 'UTS46_NON_TRANSITIONAL_TO_ASCII'); assert.equal(policy.email.localMaxBytes, 64); assert.equal(policy.email.maxBytes, 254); assert.equal(policy.email.lowercaseAscii, true);
  assert.deepEqual(policy.session, { randomBits: 256, persist: 'SHA256_HASH_ONLY', httpOnly: true, sameSite: 'Lax', path: '/', secureOutsideLoopback: true, absoluteMaxAgeSeconds: 43200, slidingExpiry: false, databaseCheckEveryRequest: true, logoutOrder: ['REVOKE_DATABASE', 'COMMIT', 'CLEAR_COOKIE'] }, 'AUTH_SESSION_POLICY');
  assert.deepEqual(policy.throttle, { owner: 'AuthLoginAttempt', scopes: ['LOGIN', 'REGISTER'], locks: 'SORTED_POSTGRES_ADVISORY_XACT', windowSeconds: 900, accountLimit: 5, ipLimit: 20, lockSeconds: 900, reservationSeconds: 60, countedStates: ['RESERVED', 'FAILED'], successClearsFailures: false, storageFailure: 'DENY' }, 'AUTH_THROTTLE_POLICY');
  assert.deepEqual(policy.csrf, { tokenRequired: true, originAllowlist: true, rejectCrossSite: true }, 'AUTH_CSRF_POLICY');
  assert.deepEqual(policy.registration, { httpStatus: 202, role: 'USER', newAndExistingIndistinguishable: true, createsSession: false, mergesAnonymous: false }, 'AUTH_REGISTER_POLICY');
  assert.deepEqual(policy.erasure, { freshPasswordAtAdmission: true, confirmErasure: true, ledgerBeforeProjection: true, reauthorizeAcceptedIntent: false }, 'AUTH_ERASURE_POLICY');
  const normalizeEmail = input => {
    requireThat(typeof input === 'string', 'AUTH_EMAIL'); const parts = input.trim().split('@'); requireThat(parts.length === 2, 'AUTH_EMAIL');
    const [local, rawDomain] = parts;
    requireThat(local.length >= 1 && Buffer.byteLength(local) <= policy.email.localMaxBytes && /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..'), 'AUTH_EMAIL');
    const domain = domainToASCII(rawDomain);
    requireThat(domain.length > 0 && domain.split('.').every(label => label.length >= 1 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)), 'AUTH_EMAIL');
    const output = `${local}@${domain}`.toLowerCase(); requireThat(Buffer.byteLength(output) <= policy.email.maxBytes, 'AUTH_EMAIL'); return output;
  };
  collector.test('auth:email-case-and-idna', () => assert.equal(normalizeEmail(' A.B@例子.测试 '), 'a.b@xn--fsqu00a.xn--0zwm56d'));
  for (const [id, value] of [['double-dot', 'a..b@example.invalid'], ['leading-dot', '.a@example.invalid'], ['unicode-local', '际遇@example.invalid'], ['local-65', `${'a'.repeat(65)}@example.invalid`], ['bad-domain', 'a@-example.invalid'], ['extra-at', 'a@b@example.invalid']]) collector.reject(`auth:email-${id}`, () => normalizeEmail(value), 'AUTH_EMAIL');
  const password = value => { const size = Buffer.byteLength(value, 'utf8'); requireThat(size >= policy.password.minBytes && size <= policy.password.maxBytes, 'AUTH_PASSWORD_LENGTH'); return value; };
  for (const [id, value] of [['min', 'a'.repeat(12)], ['max-ascii', 'a'.repeat(72)], ['max-cjk', '旅'.repeat(24)], ['max-emoji', '🌏'.repeat(18)], ['preserve-spaces', '  pass word  ']]) collector.test(`auth:password-${id}`, () => assert.equal(password(value), value));
  for (const [id, value] of [['short', 'a'.repeat(11)], ['overlong', 'a'.repeat(73)], ['cjk-overlong', '旅'.repeat(25)]]) collector.reject(`auth:password-${id}`, () => password(value), 'AUTH_PASSWORD_LENGTH');
  const principal = { sessionStatus: 'ACTIVE', userStatus: 'ACTIVE', role: 'ADMIN', audience: 'ADMIN', version: 4, currentVersion: 4, expiresAt: 43200, now: 43199, databaseAvailable: true };
  const authorize = current => requireThat(current.databaseAvailable && current.sessionStatus === 'ACTIVE' && current.userStatus === 'ACTIVE' && current.expiresAt > current.now && current.version === current.currentVersion && policy.roles.includes(current.role) && (current.audience === 'USER' || current.audience === 'ADMIN' && current.role === 'ADMIN'), 'AUTH_SESSION_DENIED');
  collector.test('auth:active-principal', () => authorize(principal));
  for (const [id, mutation] of [['revoked', { sessionStatus: 'REVOKED' }], ['expired', { now: 43200 }], ['disabled', { userStatus: 'DISABLED' }], ['version', { currentVersion: 5 }], ['role', { role: 'USER' }], ['database', { databaseAvailable: false }], ['audience', { audience: 'UNKNOWN' }]]) collector.reject(`auth:session-${id}`, () => authorize({ ...principal, ...mutation }), 'AUTH_SESSION_DENIED');
  const admission = ({ account, ip, store = true }) => requireThat(store && account < policy.throttle.accountLimit && ip < policy.throttle.ipLimit, 'AUTH_THROTTLED');
  collector.test('auth:throttle-below-both', () => admission({ account: 4, ip: 19 }));
  for (const [id, sample] of [['account', { account: 5, ip: 0 }], ['ip', { account: 0, ip: 20 }], ['storage', { account: 0, ip: 0, store: false }]]) collector.reject(`auth:throttle-${id}`, () => admission(sample), 'AUTH_THROTTLED');
  const counted = (attempt, now) => attempt.createdAt > now - policy.throttle.windowSeconds && policy.throttle.countedStates.includes(attempt.status) && (attempt.status !== 'RESERVED' || attempt.reservedUntil > now);
  collector.test('auth:reserved-unexpired-counts', () => assert(counted({ status: 'RESERVED', createdAt: 0, reservedUntil: 60 }, 59)));
  collector.test('auth:reserved-expiry-boundary', () => assert(!counted({ status: 'RESERVED', createdAt: 0, reservedUntil: 60 }, 60)));
  collector.test('auth:success-keeps-failed-history', () => assert.deepEqual(['FAILED', 'SUCCEEDED'].filter(status => counted({ status, createdAt: 50 }, 100)), ['FAILED']));
  return { scope: 'DOCUMENT_RULE_FIXTURES_NOT_AUTH_IMPLEMENTATION', fixtureCount: collector.fixtures.length, fixtures: collector.fixtures, bcryptOrDatabaseInvocations: 0 };
}

function checkAdmin(root) {
  const policy = readPolicy(root, 'docs/admin.md', 'admin-policy'); const c = fixtureCollector();
  assert.equal(policy.guard, 'DATABASE_ACTIVE_ADMIN_BEFORE_RESOURCE_QUERY', 'ADMIN_GUARD'); assert.equal(policy.privateDataRequiresOwner, true, 'ADMIN_OWNER_BOUNDARY');
  assert.deepEqual(policy.userUpdate, { casField: 'revision', requestField: 'expectedVersion', minActiveAdmins: 1, allowSelfRoleStatusChange: false, isolation: 'Serializable', reasonMinLength: 1, reasonMaxLength: 500, checkCasBeforeNoop: true, noopIncrements: false, changeRevisionIncrement: 1, changeSessionVersionIncrement: 1, revokeActiveSessions: true }, 'ADMIN_UPDATE_POLICY');
  assert.deepEqual(policy.audit, { appendOnly: true, sameTransaction: true, failure: 'ROLLBACK', paginationMax: 100, tieBreaker: 'id', loginThrottleAuthority: false }, 'ADMIN_AUDIT_POLICY');
  assert.deepEqual(policy.rotation, { candidateStatus: 'DISABLED', networkInsideTransaction: false, referenceSetRechecked: true, allReferencesSwitchAtomically: true, emergencyRevokeImmediate: true, historyOverwritten: false }, 'ADMIN_ROTATION_POLICY');
  assert.deepEqual(policy.configUpdate, { casField: 'revision', updatedAtIsCas: false, publicRequiresKeyAllowlist: true, immutableVersions: true, tupleActivation: 'activatePromptModelTuple', tupleRevisionShared: true }, 'ADMIN_CONFIG_POLICY');
  assert.deepEqual(policy.receipt, { producerPhase: 12, scope: ['ownerUserId', 'operationId', 'resourceId', 'idempotencyKeyHash'], minimumTerminalHours: 24, activeExpires: false, samePayload: 'REPLAY_SAFE_RESULT', differentPayload: '409_IDEMPOTENCY_KEY_REUSED' }, 'ADMIN_RECEIPT_POLICY');
  const proposal = { actorId: 'fixture-admin-a', targetId: 'fixture-admin-b', oldRole: 'ADMIN', oldStatus: 'ACTIVE', role: 'USER', status: 'ACTIVE', revision: 3, expectedVersion: 3, remainingActiveAdmins: 1, auditAvailable: true };
  const decide = value => {
    requireThat(value.revision === value.expectedVersion, 'ADMIN_CAS');
    if (value.role === value.oldRole && value.status === value.oldStatus) return 'NO_CHANGE';
    requireThat(value.actorId !== value.targetId || policy.userUpdate.allowSelfRoleStatusChange, 'ADMIN_SELF');
    requireThat(value.remainingActiveAdmins >= policy.userUpdate.minActiveAdmins, 'ADMIN_LAST');
    requireThat(value.auditAvailable, 'ADMIN_AUDIT_ROLLBACK'); return 'ATOMIC_CHANGE_PROPOSAL';
  };
  c.test('admin:valid-proposal', () => assert.equal(decide(proposal), 'ATOMIC_CHANGE_PROPOSAL'));
  c.test('admin:noop', () => assert.equal(decide({ ...proposal, role: 'ADMIN' }), 'NO_CHANGE'));
  for (const [id, changes, code] of [['self', { targetId: proposal.actorId }, 'ADMIN_SELF'], ['last', { remainingActiveAdmins: 0 }, 'ADMIN_LAST'], ['cas', { expectedVersion: 2 }, 'ADMIN_CAS'], ['stale-noop', { expectedVersion: 2, role: 'ADMIN' }, 'ADMIN_CAS'], ['audit', { auditAvailable: false }, 'ADMIN_AUDIT_ROLLBACK']]) c.reject(`admin:${id}`, () => decide({ ...proposal, ...changes }), code);
  const switchReferences = value => requireThat(value.keyRevision === value.expectedKeyRevision && value.referenceHash === value.expectedReferenceHash && value.allRevisionsMatch && value.auditAvailable && value.oldStatus !== 'REVOKED', 'ADMIN_ROTATION_REJECTED');
  const rotation = { keyRevision: 2, expectedKeyRevision: 2, referenceHash: 'fixture-set-a', expectedReferenceHash: 'fixture-set-a', allRevisionsMatch: true, auditAvailable: true, oldStatus: 'ACTIVE' };
  c.test('admin:rotation-all-references', () => switchReferences(rotation));
  for (const [id, changes] of [['set-changed', { referenceHash: 'fixture-set-b' }], ['revision-changed', { allRevisionsMatch: false }], ['audit-failed', { auditAvailable: false }], ['emergency-revoked', { oldStatus: 'REVOKED' }]]) c.reject(`admin:rotation-${id}`, () => switchReferences({ ...rotation, ...changes }), 'ADMIN_ROTATION_REJECTED');
  return { scope: 'DOCUMENT_RULE_FIXTURES_NOT_DATABASE_TRANSACTIONS', fixtureCount: c.fixtures.length, fixtures: c.fixtures, businessDatabaseWrites: 0 };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function checkCrypto(root) {
  const policy = readPolicy(root, 'docs/crypto.md', 'crypto-policy'); const c = fixtureCollector();
  assert.deepEqual(policy.envelopeFields, ['version', 'keyId', 'algorithm', 'iv', 'ciphertext', 'tag'], 'CRYPTO_FIELDS');
  assert.equal(policy.version, 1); assert.equal(policy.algorithm, 'A256GCM'); assert.equal(policy.serialization, 'RFC8785_JCS_UTF8'); assert.equal(policy.storage, 'String @db.Text');
  for (const [key, expected] of Object.entries({ keyBytes: 32, ivBytes: 12, tagBytes: 16, ciphertextMinBytes: 1, ciphertextMaxBytes: 16384, freshRandomIv: true, overwriteEncryptedKey: false, fingerprintDisplayLength: 12, internalError: 'SECRET_DECRYPT_FAILED', publicError: 'CONFIG_ERROR', normalCallsRequire: 'ACTIVE', keyId: 'SHA256_OF_ENCRYPTION_KEY_BYTES', encoding: 'CANONICAL_PADDED_BASE64' })) assert.equal(policy[key], expected, `CRYPTO_POLICY: ${key}`);
  assert.deepEqual(policy.aadFields, ['recordId', 'provider', 'envelopeVersion'], 'CRYPTO_AAD_FIELDS');
  assert.deepEqual(policy.columnBindings, { version: 'envelopeVersion', keyId: 'encryptionKeyId' });
  assert.deepEqual(policy.transitions, { ACTIVE: ['DISABLED', 'REVOKED'], DISABLED: ['ACTIVE', 'REVOKED'], REVOKED: [] }, 'CRYPTO_TRANSITIONS');
  const key = randomBytes(policy.keyBytes); const keyId = sha256(key); const plaintext = randomBytes(32);
  const context = { recordId: 'fixture-key-record', provider: 'fixture-provider', envelopeVersion: 1, encryptionKeyId: keyId };
  const aad = value => Buffer.from(canonicalJson(Object.fromEntries(policy.aadFields.map(field => [field, value[field]]))), 'utf8');
  const encode = () => { const iv = randomBytes(policy.ivBytes); const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad(context)); const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]); return { version: 1, keyId, algorithm: policy.algorithm, iv: iv.toString('base64'), ciphertext: encrypted.toString('base64'), tag: cipher.getAuthTag().toString('base64') }; };
  const decodeBase64 = (value, min, max) => { requireThat(typeof value === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'CRYPTO_BASE64'); const decoded = Buffer.from(value, 'base64'); requireThat(decoded.toString('base64') === value && decoded.length >= min && decoded.length <= max, 'CRYPTO_LENGTH_OR_ENCODING'); return decoded; };
  const decrypt = (encoded, row = context) => {
    exactKeys(encoded, policy.envelopeFields, 'CRYPTO_SCHEMA');
    requireThat(encoded.version === policy.version && encoded.version === row.envelopeVersion && encoded.algorithm === policy.algorithm && encoded.keyId === keyId && encoded.keyId === row.encryptionKeyId, 'CRYPTO_SCHEMA');
    const iv = decodeBase64(encoded.iv, policy.ivBytes, policy.ivBytes); const ciphertext = decodeBase64(encoded.ciphertext, policy.ciphertextMinBytes, policy.ciphertextMaxBytes); const tag = decodeBase64(encoded.tag, policy.tagBytes, policy.tagBytes);
    try { const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(aad(row)); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(ciphertext), decipher.final()]); } catch (error) { throw new Error('CRYPTO_AUTH_FAILED', { cause: error }); }
  };
  const envelope = encode();
  c.test('crypto:gcm-round-trip', () => assert.deepEqual(decrypt(envelope), plaintext));
  c.test('crypto:canonical-json-round-trip', () => assert.equal(canonicalJson(JSON.parse(canonicalJson(envelope))), canonicalJson(envelope)));
  c.test('crypto:random-iv-distinct-ciphertext', () => { const second = encode(); assert.notEqual(second.iv, envelope.iv); assert.notEqual(second.ciphertext, envelope.ciphertext); assert.equal(second.keyId, envelope.keyId); });
  for (const [id, change] of [['version-string', { version: '1' }], ['algorithm', { algorithm: 'AES-CBC' }], ['key-id', { keyId: '0'.repeat(64) }], ['extra-field', { extra: true }]]) c.reject(`crypto:${id}`, () => decrypt({ ...envelope, ...change }), 'CRYPTO_SCHEMA');
  for (const [id, change, code] of [['unpadded', { tag: envelope.tag.replace(/=+$/, '') }, 'CRYPTO_BASE64'], ['short-iv', { iv: Buffer.alloc(11).toString('base64') }, 'CRYPTO_LENGTH_OR_ENCODING'], ['empty-ciphertext', { ciphertext: '' }, 'CRYPTO_LENGTH_OR_ENCODING'], ['overlong', { ciphertext: Buffer.alloc(16385).toString('base64') }, 'CRYPTO_LENGTH_OR_ENCODING']]) c.reject(`crypto:${id}`, () => decrypt({ ...envelope, ...change }), code);
  for (const field of ['recordId', 'provider']) c.reject(`crypto:aad-${field}`, () => decrypt(envelope, { ...context, [field]: 'different-fixture' }), 'CRYPTO_AUTH_FAILED');
  for (const field of ['ciphertext', 'tag']) c.reject(`crypto:tampered-${field}`, () => { const value = Buffer.from(envelope[field], 'base64'); value[0] ^= 1; decrypt({ ...envelope, [field]: value.toString('base64') }); }, 'CRYPTO_AUTH_FAILED');
  c.reject('crypto:revoked-cannot-reactivate', () => requireThat(policy.transitions.REVOKED.includes('ACTIVE'), 'CRYPTO_REVOKED_TERMINAL'), 'CRYPTO_REVOKED_TERMINAL');
  key.fill(0); plaintext.fill(0);
  return { scope: 'ISOLATED_SYNTHETIC_CRYPTO_PRIMITIVE_AND_DOCUMENT_SCHEMA', fixtureCount: c.fixtures.length, fixtures: c.fixtures, secretValuesOrEnvelopeRecorded: false, applicationServiceImplemented: false };
}

function checkHosting(root) {
  const policy = readPolicy(root, 'docs/hosting.md', 'hosting-policy'); const c = fixtureCollector(); const { manifest } = loadRegistry(root);
  assert.deepEqual(policy.applicationServices, ['web', 'worker', 'postgres']); assert.equal(policy.privacyService, 'privacy-ledger'); assert.equal(policy.coordinationAuthority, 'POSTGRESQL'); assert.equal(policy.externalQueue, 'ABSENT'); assert.equal(policy.postgresMajor, 17);
  for (const key of ['node', 'npm', 'next']) assert.equal(policy.runtime[key], manifest.runtimePolicy[key]);
  assert.deepEqual(policy.images, { sameWebWorkerDigest: true, immutableDigest: true, nonRoot: true, implicitMigrate: false, implicitSeed: false, providerCallsAtBoot: false }, 'HOSTING_IMAGE_POLICY');
  assert.deepEqual(policy.privacyStorage, { separateDatabase: true, separateVolume: true, separateBackupSet: true, environmentKey: 'PRIVACY_LEDGER_DATABASE_URL', firstProducerPhase: 84 }, 'HOSTING_LEDGER_STORAGE');
  assert.deepEqual(policy.restoration, { stopTrafficFirst: true, requireCurrentLedgerWatermark: true, replayBeforeReadiness: true, objectsMustBeReconciled: true, tokenRotationReplacesErasure: false, killAutomaticallyResumes: false }, 'HOSTING_RESTORE_POLICY');
  assert.equal(policy.environment, 'ISOLATED_SYNTHETIC'); assert.equal(policy.productionTraffic, false);
  const topology = { applicationDatabase: 'postgresql://fixture.invalid/application', ledgerDatabase: 'postgresql://fixture.invalid/privacy', applicationVolume: 'fixture-app-volume', ledgerVolume: 'fixture-ledger-volume', applicationBackupSet: 'fixture-app-backups', ledgerBackupSet: 'fixture-ledger-backups', webDigest: `sha256:${'a'.repeat(64)}`, workerDigest: `sha256:${'a'.repeat(64)}`, externalQueue: 'ABSENT' };
  const databaseIdentity = input => { const url = new URL(input); return `${url.hostname.toLowerCase()}:${url.port || '5432'}${decodeURIComponent(url.pathname)}`; };
  const validate = value => {
    requireThat(databaseIdentity(value.applicationDatabase) !== databaseIdentity(value.ledgerDatabase), 'HOSTING_SAME_DATABASE');
    requireThat(value.applicationVolume !== value.ledgerVolume, 'HOSTING_SAME_VOLUME'); requireThat(value.applicationBackupSet !== value.ledgerBackupSet, 'HOSTING_SAME_BACKUP');
    requireThat(value.webDigest === value.workerDigest && /^sha256:[0-9a-f]{64}$/.test(value.webDigest), 'HOSTING_DIGEST'); requireThat(value.externalQueue === policy.externalQueue, 'HOSTING_QUEUE');
  };
  c.test('hosting:separate-persistence', () => validate(topology));
  for (const [id, change, diagnostic] of [['same-database', { ledgerDatabase: 'postgresql://fixture.invalid:5432/application?schema=privacy' }, 'HOSTING_SAME_DATABASE'], ['same-volume', { ledgerVolume: topology.applicationVolume }, 'HOSTING_SAME_VOLUME'], ['same-backup', { ledgerBackupSet: topology.applicationBackupSet }, 'HOSTING_SAME_BACKUP'], ['different-digest', { workerDigest: `sha256:${'b'.repeat(64)}` }, 'HOSTING_DIGEST'], ['external-queue', { externalQueue: 'REDIS' }, 'HOSTING_QUEUE']]) c.reject(`hosting:${id}`, () => validate({ ...topology, ...change }), diagnostic);
  const recovery = { trafficStopped: true, currentWatermark: 23, replayedWatermark: 23, objectsReconciled: true, bodyErased: true, killResumed: false };
  const readiness = value => requireThat(value.trafficStopped && Number.isSafeInteger(value.currentWatermark) && value.currentWatermark > 0 && value.replayedWatermark === value.currentWatermark && value.objectsReconciled && value.bodyErased && !value.killResumed, 'HOSTING_NOT_READY');
  c.test('hosting:watermark-replayed', () => readiness(recovery));
  for (const [id, change] of [['missing-watermark', { currentWatermark: null }], ['behind-watermark', { replayedWatermark: 22 }], ['watermark-rollback', { currentWatermark: 22 }], ['object-pending', { objectsReconciled: false }], ['token-only', { bodyErased: false }], ['traffic-open', { trafficStopped: false }], ['kill-auto-resumed', { killResumed: true }]]) c.reject(`hosting:${id}`, () => readiness({ ...recovery, ...change }), 'HOSTING_NOT_READY');
  return { scope: 'DOCUMENT_TOPOLOGY_RULES_NOT_DEPLOYMENT', fixtureCount: c.fixtures.length, fixtures: c.fixtures, databaseOrContainerInvocations: 0 };
}

function makeDocumentFixture(root, label) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `serendipity-phase002-${label}-`));
  const receipt = json(root, receiptPath);
  const files = new Set([...git(root, ['ls-files']).split('\n'), ...phase002SourcePaths, receipt.recovery.originalReceiptPath,
    ...json(root, 'docs/phase-plans/Phase001-inputs.json').pinnedInputs.map(pin => pin.path), ...receipt.pinnedInputs.map(pin => pin.path)]);
  for (const relative of files) {
    requireThat(relative && within(root, path.resolve(root, relative)), 'FIXTURE_COPY_PATH', relative);
    const target = path.join(temporary, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, relative), target);
  }
  return temporary;
}
function replacePolicy(root, relative, name, mutate) {
  const content = text(root, relative); const policy = readPolicy(root, relative, name); mutate(policy);
  const marker = `<!-- contract:${name} -->`; const before = content.slice(0, content.indexOf(marker) + marker.length);
  const tail = content.slice(content.indexOf(marker) + marker.length);
  fs.writeFileSync(path.join(root, relative), before + tail.replace(/^(\s*```json\s*)[\s\S]*?(```)/, (_, prefix, suffix) => `${prefix}${JSON.stringify(policy, null, 2)}\n${suffix}`));
}
function changeManifestFixture(root, mutate) {
  const receipt = json(root, receiptPath); const pin = receipt.pinnedInputs.find(input => input.id === 'manifest'); const manifest = json(root, pin.path);
  mutate(manifest); writeJson(root, pin.path, manifest, false); pin.sha256 = hash(root, pin.path); receipt.manifestHash = pin.sha256; writeJson(root, receiptPath, receipt, false);
}
function runMutations(root, label, cases) {
  const temporary = makeDocumentFixture(root, label); const observations = [];
  const originalHashes = sourceHashes(root);
  for (const item of cases) {
    const before = new Map(item.files.map(file => [file, fs.existsSync(path.join(temporary, file)) ? bytes(temporary, file) : null]));
    item.mutate(temporary);
    requireThat([...before].some(([file, value]) => value === null ? fs.existsSync(path.join(temporary, file)) : !fs.existsSync(path.join(temporary, file)) || sha256(value) !== hash(temporary, file)), 'MUTATION_MUST_CHANGE_BYTES', item.id);
    const mutatedHashes = Object.fromEntries(item.files.map(file => [file, fs.existsSync(path.join(temporary, file)) ? hash(temporary, file) : null]));
    const rejected = run(root, process.execPath, [runnerPath, '--root', temporary, '--check', item.check]);
    requireContractFailure(rejected, item.diagnostic, item.id);
    for (const [file, value] of before) {
      const target = path.resolve(temporary, file); requireThat(within(temporary, target), 'MUTATION_RESTORE_PATH');
      if (value === null) { if (fs.existsSync(target)) fs.unlinkSync(target); }
      else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); }
    }
    const restored = successful(run(root, process.execPath, [runnerPath, '--root', temporary, '--check', item.check]));
    observations.push({ id: item.id, expectedDiagnostic: item.diagnostic, mutatedHashes, rejected, restored });
  }
  assert.deepEqual(sourceHashes(root), originalHashes, 'MUTATIONS_MUST_NOT_TOUCH_ORIGINAL_FILES');
  return { scope: 'ISOLATED_DOCUMENT_MUTATIONS', temporary, caseCount: observations.length, observations, originalSourcesUnmodified: true };
}

function checkForbiddenMutations(root) {
  const receipt = json(root, receiptPath); const manifestPath = receipt.pinnedInputs.find(pin => pin.id === 'manifest').path;
  const forbidden = ['/api/nlu/parse', '/api/nlu/extract', '/api/plan/generate']; const cases = [];
  for (const route of forbidden) {
    const file = `src/app${route}/route.ts`;
    cases.push({ id: `forbidden-registry:${route}`, files: [manifestPath, receiptPath], check: 'forbidden-routes', diagnostic: 'API_FORBIDDEN_ROUTE', mutate: fixture => changeManifestFixture(fixture, manifest => { manifest.apiRegistry[0].path = route; }) });
    cases.push({ id: `forbidden-file:${route}`, files: [file], check: 'forbidden-routes', diagnostic: 'API_FORBIDDEN_ROUTE_FILE', mutate: fixture => { const target = path.join(fixture, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'export function POST() { throw new Error("isolated forbidden route fixture"); }\n'); } });
  }
  const grouped = 'src/app/(fixture)/api/nlu/parse/route.ts';
  cases.push({ id: 'forbidden-grouped-route', files: [grouped], check: 'forbidden-routes', diagnostic: 'API_FORBIDDEN_GROUPED_ROUTE_FILE', mutate: fixture => { const target = path.join(fixture, grouped); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'export const POST = () => null;\n'); } });
  const unregistered = 'src/app/api/phase002-unregistered/route.ts';
  cases.push({ id: 'unregistered-business-route', files: [unregistered], check: 'api', diagnostic: 'API_UNREGISTERED_ROUTE', mutate: fixture => { const target = path.join(fixture, unregistered); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'export function GET() { return null; }\n'); } });
  return runMutations(root, 'forbidden', cases);
}

function checkLinkMutations(root) {
  const receipt = json(root, receiptPath); const manifestPath = receipt.pinnedInputs.find(pin => pin.id === 'manifest').path;
  const prdPath = receipt.pinnedInputs.find(pin => pin.id === 'product-requirements').path;
  const append = (fixture, relative, value) => fs.appendFileSync(path.join(fixture, relative), value);
  return runMutations(root, 'links', [
    { id: 'dangling-file', files: ['docs/index.md'], check: 'links', diagnostic: 'LINK_MISSING_FILE', mutate: fixture => append(fixture, 'docs/index.md', '\n[bad](phase002-does-not-exist.md)\n') },
    { id: 'dangling-fragment', files: ['docs/index.md'], check: 'links', diagnostic: 'LINK_MISSING_FRAGMENT', mutate: fixture => append(fixture, 'docs/index.md', '\n[bad](api.md#phase002-missing-fragment)\n') },
    { id: 'deleted-index-target', files: ['docs/auth.md'], check: 'links', diagnostic: 'LINK_MISSING_FILE', mutate: fixture => fs.unlinkSync(path.join(fixture, 'docs/auth.md')) },
    { id: 'duplicate-canonical-endpoint', files: [manifestPath, receiptPath], check: 'links', diagnostic: 'API_DUPLICATE_ENDPOINT', mutate: fixture => changeManifestFixture(fixture, manifest => { manifest.apiRegistry.push({ ...manifest.apiRegistry[0], operationId: 'fixture.duplicate' }); }) },
    { id: 'undefined-producer', files: [manifestPath, receiptPath], check: 'links', diagnostic: 'Invalid producerPhase', mutate: fixture => changeManifestFixture(fixture, manifest => { manifest.apiRegistry[0].producerPhase = 999; }) },
    { id: 'second-api-contract', files: ['docs/api-contract.md'], check: 'links', diagnostic: 'SECOND_API_CONTRACT', mutate: fixture => fs.writeFileSync(path.join(fixture, 'docs/api-contract.md'), '# isolated duplicate contract fixture\n') },
    { id: 'index-hash-drift', files: ['docs/index.md'], check: 'index-documents', diagnostic: 'INDEX_INPUT_HASH', mutate: fixture => fs.writeFileSync(path.join(fixture, 'docs/index.md'), text(fixture, 'docs/index.md').replace(receipt.manifestHash, '0'.repeat(64))) },
    { id: 'local-input-hash-drift', files: [prdPath], check: 'pins', diagnostic: 'PIN_HASH', mutate: fixture => append(fixture, prdPath, '\nIsolated input drift fixture.\n') },
    { id: 'missing-admin-guard', files: ['docs/admin.md'], check: 'admin', diagnostic: 'ADMIN_GUARD', mutate: fixture => replacePolicy(fixture, 'docs/admin.md', 'admin-policy', policy => { policy.guard = 'CLIENT_ROLE'; }) },
    { id: 'weakened-password-limit', files: ['docs/auth.md'], check: 'auth', diagnostic: 'AUTH_PASSWORD_POLICY', mutate: fixture => replacePolicy(fixture, 'docs/auth.md', 'auth-policy', policy => { policy.password.maxBytes = 73; }) },
    { id: 'weakened-crypto-aad', files: ['docs/crypto.md'], check: 'crypto', diagnostic: 'CRYPTO_AAD_FIELDS', mutate: fixture => replacePolicy(fixture, 'docs/crypto.md', 'crypto-policy', policy => { policy.aadFields = ['provider']; }) },
    { id: 'shared-privacy-database', files: ['docs/hosting.md'], check: 'hosting', diagnostic: 'HOSTING_LEDGER_STORAGE', mutate: fixture => replacePolicy(fixture, 'docs/hosting.md', 'hosting-policy', policy => { policy.privacyStorage.separateDatabase = false; }) },
    { id: 'broadened-evidence-whitespace-exception', files: ['.gitattributes'], check: 'whitespace-policy', diagnostic: 'FROZEN_EVIDENCE_WHITESPACE_SCOPE', mutate: fixture => fs.writeFileSync(path.join(fixture, '.gitattributes'), text(fixture, '.gitattributes').replace(`${frozenReviewPath} whitespace=-blank-at-eof`, '*.json whitespace=-blank-at-eof')) },
    { id: 'frozen-failed-review-byte-change', files: [frozenReviewPath], check: 'whitespace-policy', diagnostic: 'FROZEN_REVIEW_BYTE_HASH', mutate: fixture => append(fixture, frozenReviewPath, ' ') },
    { id: 'frozen-failed-review-normalization', files: [frozenReviewPath], check: 'whitespace-policy', diagnostic: 'FROZEN_REVIEW_BYTE_HASH', mutate: fixture => fs.writeFileSync(path.join(fixture, frozenReviewPath), text(fixture, frozenReviewPath).replace(/\n\n$/, '\n')) },
  ]);
}

function checkEvidenceProbe(root) {
  const probe = json(root, '.scaffold/evidence-probe.json');
  requireThat(probe.scope === 'SYNTHETIC_BINDING_NEGATIVE_FIXTURE_NOT_AGENT_REVIEW', 'PROBE_SCOPE');
  const plan = probe.plan; const sources = requirePhase002Sources(plan); const hashFile = relative => hash(root, relative);
  requireReportBinding(probe.report, plan.cases[0], hash(root, planPath), sources, hashFile);
  requireReviewIdentity(probe.review, plan.implementationContextId);
  requireHashCoverage(probe.review.sourceHashes, sources, hashFile, 'REVIEW_FILE_HASH');
  requireHashCoverage(probe.review.reportHashes, ['.scaffold/binding-report.json'], hashFile, 'REVIEW_FILE_HASH');
  return { scope: probe.scope, accepted: true, independentReviewPerformed: false };
}
function checkRuntimeErrorGuard(root, temporary) {
  const target = path.join(temporary, '.scaffold/typeerror-target.mjs');
  const wrapper = path.join(temporary, '.scaffold/typeerror-wrapper.mjs');
  const moduleUrl = JSON.stringify(pathToFileURL(runnerPath).href);
  const targetScript = operation => `import assert from 'node:assert/strict';\nimport { failureDetails } from ${moduleUrl};\ntry { ${operation} } catch (error) { process.stderr.write(JSON.stringify(failureDetails(error)) + '\\n'); process.exitCode = 1; }\n`;
  const mutated = targetScript("throw new TypeError('REPORT_BINDING');");
  const restoredTarget = targetScript("assert.fail('REPORT_BINDING');");
  fs.writeFileSync(wrapper, `import { spawnSync } from 'node:child_process';\nimport { failureDetails, requireContractFailure } from ${moduleUrl};\nconst result = spawnSync(process.execPath, [${JSON.stringify(target)}], { encoding: 'utf8', timeout: 30000, windowsHide: true });\ntry { requireContractFailure({ exitCode: result.status, stdout: result.stdout, stderr: result.stderr }, 'REPORT_BINDING', 'runtime-probe'); process.stdout.write(JSON.stringify({ status: 'PASS', expectedContractRejectionVerified: true }) + '\\n'); } catch (error) { process.stderr.write(JSON.stringify(failureDetails(error)) + '\\n'); process.exitCode = 1; }\n`);
  fs.writeFileSync(target, mutated);
  const rejected = run(root, process.execPath, [wrapper]);
  requireContractFailure(rejected, 'NEGATIVE_UNEXPECTED_ERROR', 'same-diagnostic-typeerror');
  fs.writeFileSync(target, restoredTarget);
  const restored = successful(run(root, process.execPath, [wrapper]));
  assert.equal(JSON.parse(restored.stdout).expectedContractRejectionVerified, true);
  return { id: 'same-diagnostic-typeerror-must-not-pass', mutatedScriptHash: sha256(mutated), restoredScriptHash: sha256(restoredTarget),
    expectedDiagnostic: 'NEGATIVE_UNEXPECTED_ERROR', rejected, restored, targetScope: 'ISOLATED_CHECKER_ERROR_CLASS_FIXTURE' };
}
function checkEvidenceMutations(root) {
  const temporary = makeDocumentFixture(root, 'evidence'); const plan = json(temporary, planPath);
  const sources = sourceHashes(temporary); const first = plan.cases[0];
  const report = { testCaseId: first.testCaseId, command: first.command, status: 'PASS', exitCode: 0, numerator: first.denominator, denominator: first.denominator, inputPath: first.inputPath, inputHash: hash(temporary, first.inputPath), planHash: hash(temporary, planPath), sourceHashes: sources };
  writeJson(temporary, '.scaffold/binding-report.json', report);
  const probe = { scope: 'SYNTHETIC_BINDING_NEGATIVE_FIXTURE_NOT_AGENT_REVIEW', plan, report,
    review: { runnerIdentity: { kind: 'INDEPENDENT_CODEX_AGENT', implementationAuthored: false }, implementationContextId: plan.implementationContextId, contextId: 'synthetic-different-context-fixture', reviewerRunId: 'synthetic-identity-validation-fixture', generatedBy: 'fixture-not-a-review', sourceHashes: sources, reportHashes: { '.scaffold/binding-report.json': hash(temporary, '.scaffold/binding-report.json') } } };
  writeJson(temporary, '.scaffold/evidence-probe.json', probe);
  const baseline = successful(run(root, process.execPath, [runnerPath, '--root', temporary, '--check', 'evidence-probe']));
  const cases = [
    ['missing-source-inventory', 'PHASE002_SOURCE_COVERAGE', item => { item.plan.sourcePaths.pop(); }],
    ['empty-report-source-map', 'REPORT_SOURCE_HASH', item => { item.report.sourceHashes = {}; }],
    ['changed-report-source-hash', 'REPORT_SOURCE_HASH', item => { item.report.sourceHashes['docs/api.md'] = '0'.repeat(64); }],
    ['wrong-plan-hash', 'REPORT_BINDING', item => { item.report.planHash = '0'.repeat(64); }],
    ['failed-case-as-pass', 'REPORT_BINDING', item => { item.report.exitCode = 1; }],
    ['empty-review-source-map', 'REVIEW_FILE_HASH', item => { item.review.sourceHashes = {}; }],
    ['empty-review-report-map', 'REVIEW_FILE_HASH', item => { item.review.reportHashes = {}; }],
    ['same-review-context', 'REVIEW_IDENTITY', item => { item.review.contextId = item.plan.implementationContextId; }],
    ['implementation-authored-review', 'REVIEW_IDENTITY', item => { item.review.runnerIdentity.implementationAuthored = true; }],
    ['synthetic-review-kind', 'REVIEW_IDENTITY', item => { item.review.runnerIdentity.kind = 'SYNTHETIC_PROTOCOL_FIXTURE_NOT_AGENT_REVIEW'; }],
  ];
  const observations = [];
  for (const [id, diagnostic, mutate] of cases) {
    const value = structuredClone(probe); mutate(value); writeJson(temporary, '.scaffold/evidence-probe.json', value, false);
    const rejected = run(root, process.execPath, [runnerPath, '--root', temporary, '--check', 'evidence-probe']);
    requireContractFailure(rejected, diagnostic, id);
    writeJson(temporary, '.scaffold/evidence-probe.json', probe, false);
    const restored = successful(run(root, process.execPath, [runnerPath, '--root', temporary, '--check', 'evidence-probe']));
    observations.push({ id, expectedDiagnostic: diagnostic, rejected, restored });
  }
  return { scope: probe.scope, temporary, baseline, caseCount: observations.length, observations,
    runtimeErrorGuard: checkRuntimeErrorGuard(root, temporary), independentReviewPerformed: false };
}

const rawChecks = {
  api: root => verifyApi(root), prompt: root => verifyPrompt(root, { mutations: false }), schema: root => verifySchema(root, { mutations: false }),
  provider: root => checkProvider(root), privacy: root => checkPrivacy(root),
  'index-documents': checkIndexDocuments, links: checkLinks, pins: checkPins, 'forbidden-routes': verifyForbiddenRoutes,
  auth: checkAuthentication, admin: checkAdmin, crypto: checkCrypto, hosting: checkHosting, 'evidence-probe': checkEvidenceProbe,
  'whitespace-policy': checkWhitespacePolicy,
};
const checks = {
  api: root => ({ api: verifyApi(root), authentication: checkAuthentication(root), administration: checkAdmin(root), crypto: checkCrypto(root) }),
  prompt: root => verifyPrompt(root), schema: root => verifySchema(root),
  provider: root => ({ provider: checkProvider(root), hosting: checkHosting(root) }), privacy: root => checkPrivacy(root),
  index: root => ({ index: checkIndexDocuments(root), pinnedInputs: checkPins(root), scope: checkScope(root), whitespace: checkGitWhitespace(root), layout: successful(run(root, process.execPath, ['scripts/check-project-layout.mjs'])), predecessor: checkAdmission(root) }),
  'forbidden-routes': root => ({ contract: verifyForbiddenRoutes(root), negative: checkForbiddenMutations(root) }),
  links: root => ({ links: checkLinks(root), negativeDocuments: checkLinkMutations(root), evidenceBindings: checkEvidenceMutations(root) }),
};

function executeCase(root, name, plan) {
  requireThat(checks[name], 'UNKNOWN_CASE', name);
  const item = plan.cases.find(test => test.testCaseId === `Phase002:${name}`); requireThat(item, 'UNPLANNED_CASE', name);
  requireThat(!fs.existsSync(path.join(root, `docs/evidence/attempts/Phase002/${plan.attemptId}/attempt.json`)), 'FAILED_ATTEMPT_REQUIRES_RETRY');
  requireThat(!fs.existsSync(path.join(root, item.outputPath)), 'REPORT_ALREADY_EXISTS', item.outputPath);
  const startedAt = new Date().toISOString(); const start = performance.now(); const measured = sourceHashes(root);
  const details = checks[name](root);
  assert.deepEqual(sourceHashes(root), measured, 'SOURCE_CHANGED_DURING_VERIFICATION');
  const report = { testCaseId: item.testCaseId, command: item.command, status: 'PASS', exitCode: 0, numerator: item.denominator, denominator: item.denominator,
    inputPath: item.inputPath, inputHash: hash(root, item.inputPath), planHash: hash(root, planPath), sourceHashes: measured,
    startedAt, completedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - start),
    environment: 'ISOLATED_SYNTHETIC', productionTraffic: false, details };
  writeJson(root, item.outputPath, report);
  console.log(JSON.stringify({ testCaseId: item.testCaseId, status: 'PASS', numerator: item.denominator, denominator: item.denominator, outputPath: item.outputPath }));
}

function main() {
  const args = process.argv.slice(2); const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  const root = path.resolve(option('--root', originalRoot));
  try {
    if (args.includes('--check')) {
      const name = option('--check'); requireThat(rawChecks[name], 'UNKNOWN_CHECK', name);
      console.log(JSON.stringify({ status: 'PASS', details: rawChecks[name](root) }));
    } else {
      const plan = json(root, planPath); requirePhase002Sources(plan);
      if (args.includes('--all')) for (const item of plan.cases) executeCase(root, item.testCaseId.split(':')[1], plan);
      else executeCase(root, option('--case'), plan);
    }
  } catch (error) {
    const failure = failureDetails(error);
    if (!args.includes('--check') && root === originalRoot) {
      const plan = json(root, planPath); const outputPath = `docs/evidence/attempts/Phase002/${plan.attemptId}/attempt.json`;
      if (!fs.existsSync(path.join(root, outputPath))) writeJson(root, outputPath, { ...failure, phase: 2, attemptId: plan.attemptId, artifactCommit: null,
        command: `node docs/phase-plans/verify-phase002.mjs ${args.join(' ')}`, exitCode: 1, planHash: hash(root, planPath),
        sourceHashes: Object.fromEntries(phase002SourcePaths.filter(file => fs.existsSync(path.join(root, file))).map(file => [file, hash(root, file)])), generatedAt: new Date().toISOString() });
    }
    console.error(JSON.stringify(failure)); process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
