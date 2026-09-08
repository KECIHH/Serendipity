import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const planPath = 'docs/phase-plans/Phase001.json';
const planBytes = fs.readFileSync(path.join(root, planPath));
const plan = JSON.parse(planBytes);
const previousRoot = `docs/evidence/attempts/Phase001/${plan.attemptId}`;
fs.mkdirSync(path.join(root, previousRoot), { recursive: true });
const frozenPath = `${previousRoot}/frozen-plan.json`;
fs.writeFileSync(path.join(root, frozenPath), planBytes, { flag: 'wx' });
const planHash = createHash('sha256').update(planBytes).digest('hex');
const failurePath = path.join(root, previousRoot, 'attempt.json');
if (!fs.existsSync(failurePath)) {
  const reviewPath = `${previousRoot}/review.json`;
  if (fs.existsSync(path.join(root, reviewPath))) {
    const reviewBytes = fs.readFileSync(path.join(root, reviewPath));
    const review = JSON.parse(reviewBytes);
    assert(['FAIL', 'BLOCKED'].includes(review.decision), 'Retry requires an actual failed review');
    assert.equal(review.planHash, planHash);
    assert.equal(review.runnerIdentity.implementationAuthored, false);
    fs.writeFileSync(failurePath, `${JSON.stringify({
      phase: 1, attemptId: plan.attemptId, status: 'FAIL', artifactCommit: null,
      failureKind: 'INDEPENDENT_REVIEW', reviewPath,
      reviewHash: createHash('sha256').update(reviewBytes).digest('hex'),
      reviewerRunId: review.reviewerRunId, issues: review.issues,
      planHash, frozenPlanPath: frozenPath, generatedAt: new Date().toISOString(),
    }, null, 2)}\n`, { flag: 'wx' });
  } else {
  assert.equal(plan.attemptId, 'attempt-1', 'Later attempts must have a runner-produced failure report');
  fs.writeFileSync(failurePath, `${JSON.stringify({
    phase: 1, attemptId: plan.attemptId, status: 'FAIL', artifactCommit: null,
    command: 'node --check docs/phase-plans/verify-phase001.mjs', exitCode: 1,
    message: 'SyntaxError: Invalid regular expression flags at verify-phase001.mjs:208. The literal /prisma\\/ was missing the closing slash. Replaced with structured startsWith path check.',
    alsoAffected: ['--check git-workflow', '--check code-style', '--check ui-design-system'],
    planHash, frozenPlanPath: frozenPath, generatedAt: new Date().toISOString(),
  }, null, 2)}\n`, { flag: 'wx' });
  }
}
const next = `attempt-${Number(plan.attemptId.split('-')[1]) + 1}`;
for (const test of plan.cases) test.outputPath = test.outputPath.replace(`/${plan.attemptId}/`, `/${next}/`);
plan.previousAttempts = plan.previousAttempts.map((previous) => {
  if (previous.planPath) return previous;
  const old = JSON.parse(fs.readFileSync(path.join(root, previous.path), 'utf8'));
  return { attemptId: old.attemptId, planPath: previous.path, planHash: previous.sha256 };
});
plan.previousAttempts.push({ attemptId: plan.attemptId, planPath: frozenPath, planHash });
plan.attemptId = next;
fs.writeFileSync(path.join(root, planPath), `${JSON.stringify(plan, null, 2)}\n`);
console.log(JSON.stringify({ previousAttempt: previousRoot, currentAttempt: next, preservedPlanHash: planHash, retainedRequiredCases: plan.requiredCaseIds.length }));
