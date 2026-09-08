import assert from 'node:assert/strict';

export const phase001SourcePaths = Object.freeze([
  'docs/git-workflow.md', 'docs/code-style.md', 'docs/ui-design-system.md', 'docs/database.md',
  'docs/phase-plans/Phase001.json', 'docs/phase-plans/Phase001-inputs.json',
  'docs/phase-plans/verify-phase001.mjs', 'docs/phase-plans/prepare-phase001.mjs',
  'docs/phase-plans/retry-phase001.mjs', 'docs/phase-plans/replay-historical-phase.ps1',
  'docs/phase-plans/complete-phase001.mjs', 'docs/agent-execution-contract.md',
  'docs/tech-stack.md', 'docs/directory-structure.md', 'scripts/check-project-layout.mjs',
  'scripts/validate-phase.mjs', 'scripts/validate-phase.ps1', 'scripts/test-validate-phase.mjs',
  'scripts/phase-evidence.mjs',
].sort());

export function requireEvidenceSources(plan, { protocolFixture = false } = {}) {
  const sources = plan.sourcePaths;
  assert(Array.isArray(sources) && sources.length > 0 && sources.every((value) => typeof value === 'string' && value.length > 0), 'PLAN_SOURCE_PATHS: sourcePaths must be nonempty');
  assert.equal(new Set(sources).size, sources.length, 'PLAN_SOURCE_PATHS: duplicate source');
  if (plan.phase === 1 && !protocolFixture) assert.deepEqual([...sources].sort(), phase001SourcePaths, 'PLAN_SOURCE_PATHS: incomplete Phase001 source inventory');
  return [...sources].sort();
}

export function requireHashCoverage(hashes, expectedPaths, hashFile, code) {
  assert(hashes !== null && typeof hashes === 'object' && !Array.isArray(hashes), `${code}: hash map is required`);
  assert.deepEqual(Object.keys(hashes).sort(), [...expectedPaths].sort(), `${code}: hash map must cover every required file exactly`);
  for (const [file, expected] of Object.entries(hashes)) {
    assert(typeof expected === 'string' && /^[0-9a-f]{64}$/.test(expected), `${code}: invalid hash for ${file}`);
    assert.equal(hashFile(file), expected, `${code}: bytes changed for ${file}`);
  }
}

export function requireReviewIdentity(review, implementationContextId, { protocolFixture = false } = {}) {
  const kind = protocolFixture ? 'SYNTHETIC_PROTOCOL_FIXTURE_NOT_AGENT_REVIEW' : 'INDEPENDENT_CODEX_AGENT';
  assert.equal(review.runnerIdentity?.kind, kind, 'REVIEW_IDENTITY: unexpected reviewer kind');
  assert.equal(review.runnerIdentity?.implementationAuthored, false, 'REVIEW_IDENTITY: reviewer authored implementation');
  assert(typeof implementationContextId === 'string' && implementationContextId.length > 0, 'REVIEW_IDENTITY: implementation context is required');
  assert.equal(review.implementationContextId, implementationContextId, 'REVIEW_IDENTITY: implementation context binding differs');
  for (const key of ['contextId', 'reviewerRunId', 'generatedBy']) assert(typeof review[key] === 'string' && review[key].length > 0, `REVIEW_IDENTITY: ${key} is required`);
  assert.notEqual(review.contextId, implementationContextId, 'REVIEW_IDENTITY: reviewer must use a different context');
}

export function requireReportBinding(report, item, planHash, sources, hashFile) {
  for (const [key, value] of Object.entries({ testCaseId: item.testCaseId, command: item.command,
    status: 'PASS', exitCode: 0, numerator: item.denominator, denominator: item.denominator,
    inputPath: item.inputPath, inputHash: hashFile(item.inputPath), planHash })) {
    assert.equal(report[key], value, `REPORT_BINDING: ${item.testCaseId}.${key}`);
  }
  requireHashCoverage(report.sourceHashes, sources, hashFile, 'REPORT_SOURCE_HASH');
}
