import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const prefix = "PHASE011_EVIDENCE";
const sha256 = /^[0-9a-f]{64}$/;
const objectId = /^[0-9a-f]{40,64}$/;

export function requirePhase011Preflight(preflight) {
  assert.equal(preflight.phase, 11, `${prefix}: wrong phase`);
  assert.equal(preflight.workingTree, "", `${prefix}: dirty admission`);
  assert.equal(preflight.branch, "main");
  assert.equal(preflight.remote, "https://github.com/KECIHH/Serendipity.git");
  assert.match(preflight.head, objectId);
  assert.equal(preflight.originMain, preflight.head);
  assert.equal(preflight.remoteHead, preflight.head);
  assert.equal(preflight.ahead, 0);
  assert.equal(preflight.behind, 0);
  assert(Array.isArray(preflight.shells));
  const commands = {
    "PowerShell 7": "pwsh -NoProfile -File scripts/validate-phase.ps1 -CompletedThrough 10 -Strict -Json",
    "Windows PowerShell 5.1": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/validate-phase.ps1 -CompletedThrough 10 -Strict -Json",
  };
  assert.deepEqual(preflight.shells.map((shell) => shell.shell).sort(), Object.keys(commands).sort(), `${prefix}: both distinct shells are required`);
  for (const shell of preflight.shells) {
    assert.equal(shell.command, commands[shell.shell]);
    assert.equal(shell.exitCode, 0);
    assert.equal(shell.result.status, "PASS");
    assert.equal(shell.result.scope, "ROOT_LAYOUT_PHASE_CHECKPOINT_SEAL");
    assert.equal(shell.result.protocolFixture, false);
    assert.equal(shell.result.layoutVersion, 2);
    assert.equal(shell.result.projectGitPrefix, "");
    assert.equal(shell.result.completedThrough, 10);
    assert.equal(shell.result.currentPhase, 11);
    assert.equal(shell.result.metadataCommit, preflight.head);
    assert.match(shell.result.artifactCommit, objectId);
    assert.equal(shell.result.artifactCommit, preflight.shells[0].result.artifactCommit);
  }
}

export function requirePhase011Generation(generation, { receipt, hashFile, readText, migrationPath }) {
  assert.match(migrationPath, /^prisma\/migrations\/[0-9]{14}_auth_session_login_attempt\/migration\.sql$/);
  assert.equal(generation.generatedMigrationPath, migrationPath);
  assert.equal(generation.rawMigrationPath, "docs/evidence/attempts/Phase011/setup/auth_session_login_attempt.generated.sql");
  assert.equal(generation.protectionPath, "docs/phase-plans/auth-session-protection.sql");
  assert.equal(generation.sqlAppendMode, "GENERATED_THEN_PROTECTION");
  for (const field of ["rawMigrationHash", "migrationHash", "schemaHash", "previousSchemaHash", "protectionHash"]) assert.match(generation[field], sha256);
  assert.equal(hashFile(generation.rawMigrationPath), generation.rawMigrationHash);
  assert.equal(hashFile(generation.protectionPath), generation.protectionHash);
  assert.equal(hashFile(migrationPath), generation.migrationHash);
  assert.equal(generation.schemaPath, "prisma/schema.prisma");
  assert.equal(hashFile(generation.schemaPath), generation.schemaHash);
  assert.equal(generation.previousSchemaHash, receipt.prerequisites.schemaHash);
  assert.deepEqual(generation.previousMigrations, receipt.prerequisites.migrations);
  assert.equal(generation.previousMigrations.length, 5);
  for (const previous of generation.previousMigrations) assert.equal(hashFile(previous.path), previous.sha256);
  assert.equal(generation.simulation, true);
  assert.equal(generation.productionTraffic, false);
  const commandPattern = /^npm run db:migrate -- (?:--name auth_session_login_attempt --create-only|--create-only --name auth_session_login_attempt)(?: --skip-generate)?$/;
  assert(Array.isArray(generation.records));
  const commands = generation.records.filter((record) => record && typeof record.command === "string" && commandPattern.test(record.command));
  assert.equal(commands.length, 1, `${prefix}: one exact migration generation command is required`);
  const command = commands[0];
  assert.equal(command.exitCode, 0);
  assert.equal(command.timedOut, false);
  assert.equal(typeof command.stdout, "string");
  assert.equal(typeof command.stderr, "string");
  const raw = readText(generation.rawMigrationPath);
  const protection = readText(generation.protectionPath);
  assert(!raw.includes("\r") && !protection.includes("\r"), `${prefix}: tested SQL must use LF`);
  assert.deepEqual([...raw.matchAll(/CREATE TABLE "([^"]+)"/g)].map((entry) => entry[1]).sort(), ["AuthLoginAttempt", "AuthSession"]);
  assert(!/ALTER TABLE "(User|SystemConfig|TravelRecord|ChatMessage|AuditLog|ApiKeyConfig)"|DROP\s|INSERT\s/i.test(raw));
  assert.equal(readText(migrationPath), `${raw.trimEnd()}\n\n${protection.trimEnd()}\n`, `${prefix}: generated SQL and reviewed protection must be exact`);
}

export function requirePhase011FailureChain(plan, { readJson, hashFile }) {
  assert.equal(plan.phase, 11);
  assert(Array.isArray(plan.previousAttempts));
  assert.match(plan.attemptId, /^attempt-[1-9][0-9]*$/);
  const ordinal = Number(plan.attemptId.slice("attempt-".length));
  assert(Number.isSafeInteger(ordinal) && ordinal <= 10000);
  const expectedIds = Array.from({ length: ordinal - 1 }, (_, index) => `attempt-${index + 1}`);
  assert.deepEqual(plan.previousAttempts.map((entry) => entry.attemptId), expectedIds, `${prefix}: complete ordered failure history is required`);
  const currentBindings = new Map(plan.previousAttempts.map((entry) => [entry.attemptId, entry]));
  for (const previous of plan.previousAttempts) {
    assert.equal(previous.planPath, `docs/evidence/attempts/Phase011/${previous.attemptId}/frozen-plan.json`);
    assert.equal(previous.failurePath, `docs/evidence/attempts/Phase011/${previous.attemptId}/attempt.json`);
    assert.match(previous.planHash, sha256);
    assert.match(previous.failureHash, sha256);
    assert.equal(hashFile(previous.planPath), previous.planHash);
    assert.equal(hashFile(previous.failurePath), previous.failureHash);
    const old = readJson(previous.planPath);
    assert.equal(old.phase, 11);
    assert.equal(old.attemptId, previous.attemptId);
    const oldOrdinal = Number(old.attemptId.slice("attempt-".length));
    assert(Array.isArray(old.previousAttempts));
    assert.deepEqual(old.previousAttempts.map((entry) => entry.attemptId), expectedIds.slice(0, oldOrdinal - 1), `${prefix}: frozen history is incomplete`);
    for (const inherited of old.previousAttempts) {
      assert.deepEqual(inherited, currentBindings.get(inherited.attemptId), `${prefix}: frozen prior binding changed`);
    }
    const failure = readJson(previous.failurePath);
    assert.equal(failure.phase, 11);
    assert.equal(failure.attemptId, previous.attemptId);
    assert(["FAIL", "BLOCKED"].includes(failure.status), `${prefix}: prior attempt must be a failure`);
    assert.equal(failure.planHash, previous.planHash);
    assert.equal(failure.artifactCommit, null, `${prefix}: failure receipt precedes artifact commit`);
  }
}

export function createPhase011RetryPlan(plan, { readJson, hashFile }) {
  requirePhase011FailureChain(plan, { readJson, hashFile });
  const planPath = `docs/evidence/attempts/Phase011/${plan.attemptId}/frozen-plan.json`;
  const failurePath = `docs/evidence/attempts/Phase011/${plan.attemptId}/attempt.json`;
  assert.deepEqual(readJson(planPath), plan, `${prefix}: current frozen plan changed`);
  const next = structuredClone(plan);
  next.attemptId = `attempt-${Number(plan.attemptId.slice("attempt-".length)) + 1}`;
  next.previousAttempts.push({ attemptId: plan.attemptId, planPath, planHash: hashFile(planPath), failurePath, failureHash: hashFile(failurePath) });
  for (const item of next.cases) item.outputPath = item.outputPath.replace(`/${plan.attemptId}/`, `/${next.attemptId}/`);
  requirePhase011FailureChain(next, { readJson, hashFile });
  return next;
}

export function requirePhase011ImplementationBinding(expectedSnapshot, actualSnapshot) {
  assert(expectedSnapshot && typeof expectedSnapshot === "object" && !Array.isArray(expectedSnapshot));
  assert(actualSnapshot && typeof actualSnapshot === "object" && !Array.isArray(actualSnapshot));
  assert.deepEqual(actualSnapshot, expectedSnapshot, "IMPLEMENTATION_CHANGED: implementation files were added, removed or changed after verification");
}

export function getPhase011ImplementationSnapshot({ root, plan, receipt, git, hashFile, inventory, migrationPath }) {
  const migrations = inventory("prisma/migrations").filter((file) => file.endsWith("/migration.sql")).sort();
  assert.deepEqual(migrations, [...receipt.prerequisites.migrations.map((entry) => entry.path), migrationPath].sort(), "IMPLEMENTATION_CHANGED: unexpected migration inventory");
  const plannedSources = new Set([...plan.sourcePaths, migrationPath]);
  for (const file of [...inventory("src"), ...inventory("tests"), ...inventory("prisma")]) {
    assert(plannedSources.has(file), `IMPLEMENTATION_CHANGED: unregistered product or test file ${file}`);
  }
  const changed = [...new Set([
    ...git(["diff", "--name-only", "-z", receipt.phaseStartCommit]).split("\0"),
    ...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
  ].filter(Boolean))].sort();
  for (const file of changed) assert(plan.modificationScope.some((scope) => scope.endsWith("/") ? file.startsWith(scope) : scope === file), `IMPLEMENTATION_CHANGED: out-of-scope path ${file}`);
  return Object.fromEntries(changed.filter((file) => !file.startsWith("docs/evidence/attempts/Phase011/"))
    .map((file) => [file, fs.existsSync(path.join(root, file)) ? hashFile(file) : null]));
}
