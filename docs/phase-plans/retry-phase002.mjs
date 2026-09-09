import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const planPath = 'docs/phase-plans/Phase002.json';
const read = (relative) => fs.readFileSync(path.join(root, relative));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const planBytes = read(planPath);
const plan = JSON.parse(planBytes);
const attemptRoot = `docs/evidence/attempts/Phase002/${plan.attemptId}`;
const failurePath = `${attemptRoot}/attempt.json`;
const reviewPath = `${attemptRoot}/review.json`;
const frozenPath = `${attemptRoot}/frozen-plan.json`;
fs.mkdirSync(path.join(root, attemptRoot), { recursive: true });
const write = (relative, value) => fs.writeFileSync(path.join(root, relative), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });

try {
  if (!fs.existsSync(path.join(root, failurePath))) {
    assert(fs.existsSync(path.join(root, reviewPath)), 'A retry requires an actual runner failure or independent FAIL/BLOCKED review');
    const review = JSON.parse(read(reviewPath));
    assert(['FAIL', 'BLOCKED'].includes(review.decision));
    assert.equal(review.planHash, hash(planBytes));
    assert.equal(review.runnerIdentity?.implementationAuthored, false);
    write(failurePath, { phase: 2, attemptId: plan.attemptId, status: review.decision,
      artifactCommit: null, failureKind: 'INDEPENDENT_REVIEW', reviewPath,
      reviewHash: hash(read(reviewPath)), reviewerRunId: review.reviewerRunId,
      issues: review.issues, planHash: hash(planBytes), generatedAt: new Date().toISOString() });
  }
  const failure = JSON.parse(read(failurePath));
  assert(['FAIL', 'BLOCKED'].includes(failure.status));
  assert.equal(failure.phase, 2);
  assert.equal(failure.attemptId, plan.attemptId);
  assert.equal(failure.planHash, hash(planBytes));
  if (fs.existsSync(path.join(root, frozenPath))) assert.equal(hash(read(frozenPath)), hash(planBytes), 'Frozen attempt plan changed');
  else fs.writeFileSync(path.join(root, frozenPath), planBytes, { flag: 'wx' });
  const next = `attempt-${Number(plan.attemptId.split('-')[1]) + 1}`;
  for (const item of plan.cases) item.outputPath = item.outputPath.replace(`/${plan.attemptId}/`, `/${next}/`);
  plan.previousAttempts.push({ attemptId: plan.attemptId, planPath: frozenPath, planHash: hash(planBytes) });
  plan.attemptId = next;
  fs.writeFileSync(path.join(root, planPath), `${JSON.stringify(plan, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'RETRY_PREPARED', attemptId: next, preservedPlanHash: hash(planBytes), requiredCases: plan.requiredCaseIds.length }));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }));
  process.exitCode = 1;
}
