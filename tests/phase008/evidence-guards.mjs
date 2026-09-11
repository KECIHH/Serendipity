import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  createPhase008RetryPlan,
  requirePhase008FailureChain,
  requirePhase008Generation,
  requirePhase008ImplementationBinding,
  requirePhase008Preflight,
} from "../../docs/phase-plans/phase008-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clone = (value) => structuredClone(value);
const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;
const changedHash = (value) => `${value[0] === "0" ? "1" : "0"}${value.slice(1)}`;

function repositoryFile(file) {
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  assert(relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative));
  return absolute;
}

const readText = (file) => fs.readFileSync(repositoryFile(file), "utf8");
const readJson = (file) => JSON.parse(readText(file));
const hashFile = (file) => digest(fs.readFileSync(repositoryFile(file)));

function parseOutput(args) {
  if (args.length === 0) return null;
  assert(
    args.length === 2 && args[0] === "--output" && args[1].length > 0,
    "Usage: node tests/phase008/evidence-guards.mjs [--output <path>]",
  );
  return path.resolve(root, args[1]);
}

const outputPath = parseOutput(process.argv.slice(2));
const results = [];

async function check(name, expected, operation, requiredErrorPrefix) {
  let observed = "ACCEPT";
  let matchingError = true;
  try {
    await operation();
  } catch (error) {
    observed = "REJECT";
    matchingError =
      requiredErrorPrefix === undefined ||
      (error instanceof Error && error.message.startsWith(requiredErrorPrefix));
  }
  results.push({
    name,
    expected,
    observed,
    status: observed === expected && matchingError ? "PASS" : "FAIL",
    ...(requiredErrorPrefix === undefined ? {} : { requiredErrorPrefix, matchingError }),
  });
}

function generationCommand(generation) {
  const matches = generation.records.filter((record) =>
    record.arguments?.includes("--create-only"),
  );
  assert.equal(matches.length, 1, "The actual receipt must contain exactly one generation command");
  return matches[0];
}

/** Synthetic prior attempts live solely in this map; no report file or database is modified. */
function failureFixture(sourcePlan, status = "FAIL") {
  const planPath = "docs/evidence/attempts/Phase008/attempt-1/frozen-plan.json";
  const failurePath = "docs/evidence/attempts/Phase008/attempt-1/attempt.json";
  const previousPlan = { ...clone(sourcePlan), attemptId: "attempt-1", previousAttempts: [] };
  const files = new Map([[planPath, jsonBytes(previousPlan)]]);
  const planHash = digest(files.get(planPath));
  files.set(
    failurePath,
    jsonBytes({
      phase: 8,
      attemptId: "attempt-1",
      status,
      planHash,
      artifactCommit: null,
    }),
  );
  const plan = {
    ...clone(sourcePlan),
    attemptId: "attempt-2",
    previousAttempts: [
      {
        attemptId: "attempt-1",
        planPath,
        planHash,
        failurePath,
        failureHash: digest(files.get(failurePath)),
      },
    ],
  };
  const memoryRead = (file) => {
    assert(files.has(file), "Requested in-memory evidence is missing");
    return files.get(file);
  };
  const dependencies = {
    readJson: (file) => JSON.parse(memoryRead(file)),
    hashFile: (file) => digest(memoryRead(file)),
  };
  function updateFailure(change) {
    const failure = dependencies.readJson(failurePath);
    change(failure);
    files.set(failurePath, jsonBytes(failure));
    // Rebind the checksum so the negative test reaches the semantic check it names.
    plan.previousAttempts[0].failureHash = dependencies.hashFile(failurePath);
  }
  return { plan, files, dependencies, planPath, failurePath, updateFailure };
}

/** Every generation freezes the prior hashes before the next generation is constructed. */
function retryFixture(sourcePlan, attemptNumber = 3, legacyEarlyPlans = false) {
  const files = new Map();
  const references = [];
  const paths = (number) => ({
    planPath: `docs/evidence/attempts/Phase008/attempt-${number}/frozen-plan.json`,
    failurePath: `docs/evidence/attempts/Phase008/attempt-${number}/attempt.json`,
  });
  for (let number = 1; number <= attemptNumber; number += 1) {
    const attemptId = `attempt-${number}`;
    const previousAttempts = clone(references);
    if (legacyEarlyPlans && number <= 2) {
      for (const previous of previousAttempts) {
        delete previous.failurePath;
        delete previous.failureHash;
      }
    }
    const frozen = {
      ...clone(sourcePlan),
      attemptId,
      previousAttempts,
      cases: sourcePlan.cases.map((entry) => ({
        ...clone(entry),
        outputPath: entry.outputPath.replace(/\/attempt-[1-9][0-9]*\//g, `/${attemptId}/`),
      })),
    };
    const { planPath, failurePath } = paths(number);
    files.set(planPath, jsonBytes(frozen));
    const planHash = digest(files.get(planPath));
    files.set(
      failurePath,
      jsonBytes({
        phase: 8,
        attemptId,
        status: "FAIL",
        planHash,
        artifactCommit: null,
        reason: `Synthetic failure for attempt ${number}`,
      }),
    );
    references.push({
      attemptId,
      planPath,
      planHash,
      failurePath,
      failureHash: digest(files.get(failurePath)),
    });
  }
  const memoryRead = (file) => {
    assert(files.has(file), "Requested in-memory retry evidence is missing");
    return files.get(file);
  };
  const dependencies = {
    readJson: (file) => JSON.parse(memoryRead(file)),
    hashFile: (file) => digest(memoryRead(file)),
  };
  const currentPaths = paths(attemptNumber);
  const plan = dependencies.readJson(currentPaths.planPath);
  function refreshCurrentEvidence() {
    files.set(currentPaths.planPath, jsonBytes(plan));
    const failure = dependencies.readJson(currentPaths.failurePath);
    failure.planHash = dependencies.hashFile(currentPaths.planPath);
    files.set(currentPaths.failurePath, jsonBytes(failure));
  }
  function rebindFirstFailureInCurrentPlan() {
    const first = paths(1);
    const failure = dependencies.readJson(first.failurePath);
    failure.reason = "A different explanation must not rewrite a historical failure";
    files.set(first.failurePath, jsonBytes(failure));
    plan.previousAttempts[0].failureHash = dependencies.hashFile(first.failurePath);
  }
  return {
    plan,
    files,
    dependencies,
    paths,
    currentPaths,
    refreshCurrentEvidence,
    rebindFirstFailureInCurrentPlan,
  };
}

async function main() {
  const plan = readJson("docs/phase-plans/Phase008.json");
  const receipt = readJson("docs/phase-plans/Phase008-inputs.json");
  const preflight = readJson("docs/evidence/attempts/Phase008/setup/preflight.json");
  const generation = readJson("docs/evidence/attempts/Phase008/setup/migration-generation.json");
  const migrationPath = generation.generatedMigrationPath;
  const generationDependencies = { receipt, hashFile, readText, migrationPath };

  await check("preflight accepts the actual two-shell seal", "ACCEPT", () =>
    requirePhase008Preflight(clone(preflight)),
  );

  for (const [name, mutate] of [
    [
      "duplicate PowerShell7 is not a second shell",
      (value) => {
        value.shells[1] = clone(value.shells[0]);
      },
    ],
    [
      "a protocol fixture is not an actual seal",
      (value) => {
        value.shells[0].result.protocolFixture = true;
      },
    ],
    [
      "an unrelated seal scope is rejected",
      (value) => {
        value.shells[0].result.scope = "PROTOCOL_FIXTURE";
      },
    ],
    [
      "a failing shell exit is rejected",
      (value) => {
        value.shells[0].exitCode = 1;
      },
    ],
    [
      "a failing seal result is rejected",
      (value) => {
        value.shells[1].result.status = "FAIL";
      },
    ],
    [
      "a missing second shell is rejected",
      (value) => {
        value.shells.pop();
      },
    ],
    [
      "the prior completed phase cannot change",
      (value) => {
        value.shells[0].result.completedThrough = 6;
      },
    ],
    [
      "the admitted current phase cannot change",
      (value) => {
        value.shells[1].result.currentPhase = 9;
      },
    ],
  ]) {
    const value = clone(preflight);
    mutate(value);
    await check(`preflight rejects ${name}`, "REJECT", () => requirePhase008Preflight(value));
  }

  await check("generation accepts the actual migration receipt and file hashes", "ACCEPT", () =>
    requirePhase008Generation(clone(generation), generationDependencies),
  );

  for (const [name, mutate] of [
    [
      "echo --create-only is not Prisma migration generation",
      (command) => {
        command.command = "echo --create-only";
        command.executable = "cmd.exe";
        command.arguments = ["/c", "echo", "--create-only"];
        command.stdout = "--create-only\n";
      },
    ],
    [
      "a failed generation command",
      (command) => {
        command.exitCode = 1;
      },
    ],
    [
      "a timed-out generation command",
      (command) => {
        command.timedOut = true;
      },
    ],
    [
      "a missing timedOut field",
      (command) => {
        delete command.timedOut;
      },
    ],
    [
      "missing standard output",
      (command) => {
        delete command.stdout;
      },
    ],
    [
      "missing standard error",
      (command) => {
        delete command.stderr;
      },
    ],
  ]) {
    const value = clone(generation);
    mutate(generationCommand(value));
    await check(`generation rejects ${name}`, "REJECT", () =>
      requirePhase008Generation(value, generationDependencies),
    );
  }

  for (const field of ["rawMigrationHash", "migrationHash"]) {
    const value = clone(generation);
    value[field] = changedHash(value[field]);
    await check(`generation rejects altered ${field}`, "REJECT", () =>
      requirePhase008Generation(value, generationDependencies),
    );
  }

  for (const file of [generation.rawMigrationPath, migrationPath]) {
    await check(`generation rejects changed SQL bytes at ${file}`, "REJECT", () =>
      requirePhase008Generation(clone(generation), {
        ...generationDependencies,
        hashFile: (candidate) =>
          candidate === file ? changedHash(hashFile(candidate)) : hashFile(candidate),
      }),
    );
  }

  for (const status of ["FAIL", "BLOCKED"]) {
    const fixture = failureFixture(plan, status);
    await check(`failure chain accepts a checksum-bound prior ${status}`, "ACCEPT", () =>
      requirePhase008FailureChain(fixture.plan, fixture.dependencies),
    );
  }

  for (const [name, mutate] of [
    [
      "a missing failure receipt path",
      (fixture) => {
        delete fixture.plan.previousAttempts[0].failurePath;
      },
    ],
    [
      "a missing failure receipt hash",
      (fixture) => {
        delete fixture.plan.previousAttempts[0].failureHash;
      },
    ],
    [
      "a missing receipt file",
      (fixture) => {
        fixture.files.delete(fixture.failurePath);
      },
    ],
    [
      "a failure receipt hash drift",
      (fixture) => {
        fixture.files.set(fixture.failurePath, `${fixture.files.get(fixture.failurePath)}\n`);
      },
    ],
    [
      "a frozen plan hash drift",
      (fixture) => {
        fixture.files.set(fixture.planPath, `${fixture.files.get(fixture.planPath)}\n`);
      },
    ],
    [
      "a receipt for a different attempt",
      (fixture) => {
        fixture.updateFailure((failure) => {
          failure.attemptId = "attempt-2";
        });
      },
    ],
    [
      "a successful receipt substituted for a failed attempt",
      (fixture) => {
        fixture.updateFailure((failure) => {
          failure.status = "PASS";
        });
      },
    ],
    [
      "a receipt from another phase",
      (fixture) => {
        fixture.updateFailure((failure) => {
          failure.phase = 7;
        });
      },
    ],
    [
      "a receipt bound to the wrong plan",
      (fixture) => {
        fixture.updateFailure((failure) => {
          failure.planHash = changedHash(failure.planHash);
        });
      },
    ],
    [
      "a failure claiming an artifact commit",
      (fixture) => {
        fixture.updateFailure((failure) => {
          failure.artifactCommit = "a".repeat(40);
        });
      },
    ],
    [
      "a frozen plan for a different attempt even with matching checksums",
      (fixture) => {
        const previous = fixture.dependencies.readJson(fixture.planPath);
        previous.attemptId = "attempt-99";
        fixture.files.set(fixture.planPath, jsonBytes(previous));
        fixture.plan.previousAttempts[0].planHash = fixture.dependencies.hashFile(fixture.planPath);
        fixture.updateFailure((failure) => {
          failure.planHash = fixture.plan.previousAttempts[0].planHash;
        });
      },
    ],
  ]) {
    const fixture = failureFixture(plan);
    mutate(fixture);
    await check(`failure chain rejects ${name}`, "REJECT", () =>
      requirePhase008FailureChain(fixture.plan, fixture.dependencies),
    );
  }

  {
    const fixture = retryFixture(plan);
    await check(
      "failure chain accepts three generations with preserved prior hashes",
      "ACCEPT",
      () => requirePhase008FailureChain(fixture.plan, fixture.dependencies),
    );
  }

  for (const [name, mutate] of [
    [
      "an empty prior chain for attempt-4",
      (value) => {
        value.previousAttempts = [];
      },
    ],
    [
      "a missing middle attempt",
      (value) => {
        value.previousAttempts.splice(1, 1);
      },
    ],
    [
      "prior attempts in reverse order",
      (value) => {
        value.previousAttempts.reverse();
      },
    ],
    [
      "a duplicate prior attempt replacing a required one",
      (value) => {
        value.previousAttempts[1] = clone(value.previousAttempts[0]);
      },
    ],
  ]) {
    const fixture = retryFixture(plan, 4);
    mutate(fixture.plan);
    await check(`failure chain rejects ${name}`, "REJECT", () =>
      requirePhase008FailureChain(fixture.plan, fixture.dependencies),
    );
  }

  {
    const fixture = retryFixture(plan);
    fixture.rebindFirstFailureInCurrentPlan();
    await check(
      "failure chain rejects rebinding an old failure already pinned by the second frozen plan",
      "REJECT",
      () => requirePhase008FailureChain(fixture.plan, fixture.dependencies),
    );
  }

  {
    const fixture = retryFixture(plan, 3, true);
    await check(
      "failure chain accepts the documented early frozen-plan bridge without failure fields",
      "ACCEPT",
      () => requirePhase008FailureChain(fixture.plan, fixture.dependencies),
    );
  }

  {
    const fixture = retryFixture(plan, 4, true);
    const thirdPaths = fixture.paths(3);
    const third = fixture.dependencies.readJson(thirdPaths.planPath);
    delete third.previousAttempts[0].failurePath;
    delete third.previousAttempts[0].failureHash;
    fixture.files.set(thirdPaths.planPath, jsonBytes(third));
    const thirdReference = fixture.plan.previousAttempts[2];
    thirdReference.planHash = fixture.dependencies.hashFile(thirdPaths.planPath);
    const thirdFailure = fixture.dependencies.readJson(thirdPaths.failurePath);
    thirdFailure.planHash = thirdReference.planHash;
    fixture.files.set(thirdPaths.failurePath, jsonBytes(thirdFailure));
    thirdReference.failureHash = fixture.dependencies.hashFile(thirdPaths.failurePath);
    await check(
      "failure chain rejects omitted failure fields after the early historical bridge",
      "REJECT",
      () => requirePhase008FailureChain(fixture.plan, fixture.dependencies),
    );
  }

  {
    const fixture = retryFixture(plan);
    const originalPlan = clone(fixture.plan);
    const originalFiles = [...fixture.files];
    await check(
      "retry plan preserves every old hash and appends only the current failed attempt",
      "ACCEPT",
      async () => {
        const next = await createPhase008RetryPlan(fixture.plan, fixture.dependencies);
        const expectedReference = {
          attemptId: originalPlan.attemptId,
          ...fixture.currentPaths,
          planHash: fixture.dependencies.hashFile(fixture.currentPaths.planPath),
          failureHash: fixture.dependencies.hashFile(fixture.currentPaths.failurePath),
        };
        const expected = {
          ...clone(originalPlan),
          attemptId: "attempt-4",
          previousAttempts: [...clone(originalPlan.previousAttempts), expectedReference],
          cases: originalPlan.cases.map((entry) => ({
            ...clone(entry),
            outputPath: entry.outputPath.replace("/attempt-3/", "/attempt-4/"),
          })),
        };
        assert.deepEqual(next, expected);
        assert.deepEqual(fixture.plan, originalPlan);
        assert.deepEqual([...fixture.files], originalFiles);
        assert.notStrictEqual(next.previousAttempts, fixture.plan.previousAttempts);
        assert.notStrictEqual(next.previousAttempts[0], fixture.plan.previousAttempts[0]);
        requirePhase008FailureChain(next, fixture.dependencies);
      },
    );
  }

  {
    const fixture = retryFixture(plan);
    fixture.rebindFirstFailureInCurrentPlan();
    // Keep the current plan/failure mutually consistent: rejection must come from old bindings.
    fixture.refreshCurrentEvidence();
    await check(
      "retry plan rejects altered old failure bytes even when current receipts are rebound",
      "REJECT",
      () => createPhase008RetryPlan(fixture.plan, fixture.dependencies),
    );
  }

  {
    const fixture = retryFixture(plan);
    const failure = fixture.dependencies.readJson(fixture.currentPaths.failurePath);
    failure.planHash = changedHash(failure.planHash);
    fixture.files.set(fixture.currentPaths.failurePath, jsonBytes(failure));
    await check(
      "retry plan rejects a current failure bound to the wrong frozen plan",
      "REJECT",
      () => createPhase008RetryPlan(fixture.plan, fixture.dependencies),
    );
  }

  {
    const fixture = retryFixture(plan);
    fixture.plan.scope = "A changed current plan has not been frozen";
    await check("retry plan rejects a current input different from its frozen plan", "REJECT", () =>
      createPhase008RetryPlan(fixture.plan, fixture.dependencies),
    );
  }

  {
    const fixture = retryFixture(plan);
    fixture.files.delete(fixture.currentPaths.failurePath);
    await check("retry plan rejects a missing current failure receipt", "REJECT", () =>
      createPhase008RetryPlan(fixture.plan, fixture.dependencies),
    );
  }

  const snapshot = Object.fromEntries(
    [...new Set([...plan.sourcePaths, migrationPath])]
      .sort()
      .map((file) => [file, fs.existsSync(repositoryFile(file)) ? hashFile(file) : null]),
  );
  const sourceFile = Object.keys(snapshot).find(
    (file) => file.startsWith("src/") && snapshot[file] !== null,
  );
  assert(sourceFile, "The implementation fixture must contain an actual source file");
  await check("implementation binding accepts identical actual source snapshots", "ACCEPT", () =>
    requirePhase008ImplementationBinding(snapshot, clone(snapshot)),
  );
  await check("implementation binding accepts identical nullable entries", "ACCEPT", () =>
    requirePhase008ImplementationBinding(
      { "optional-fixture.ts": null },
      { "optional-fixture.ts": null },
    ),
  );

  const addedFiles = [
    "src/server/__phase008_untested_fixture.ts",
    "src/app/api/__phase008_untested_fixture/route.ts",
    "prisma/migrations/99999999999999_untested_fixture/migration.sql",
  ];
  for (const file of addedFiles) {
    assert(!Object.hasOwn(snapshot, file));
    const actual = { ...clone(snapshot), [file]: digest("synthetic untested bytes") };
    await check(
      `implementation binding rejects an added file ${file}`,
      "REJECT",
      () => requirePhase008ImplementationBinding(snapshot, actual),
      "IMPLEMENTATION_CHANGED",
    );
  }

  for (const [name, mutate] of [
    [
      "a deleted source entry",
      (actual) => {
        delete actual[sourceFile];
      },
    ],
    [
      "a source file replaced by null",
      (actual) => {
        actual[sourceFile] = null;
      },
    ],
    [
      "a changed source hash",
      (actual) => {
        actual[sourceFile] = changedHash(actual[sourceFile]);
      },
    ],
    [
      "an added nullable path",
      (actual) => {
        actual["src/server/__phase008_new_null_fixture.ts"] = null;
      },
    ],
  ]) {
    const actual = clone(snapshot);
    mutate(actual);
    await check(
      `implementation binding rejects ${name}`,
      "REJECT",
      () => requirePhase008ImplementationBinding(snapshot, actual),
      "IMPLEMENTATION_CHANGED",
    );
  }
}

try {
  await main();
} catch {
  results.push({
    name: "evidence guard fixture initialization",
    expected: "ACCEPT",
    observed: "REJECT",
    status: "FAIL",
  });
}

const report = {
  phase: 8,
  scope: "PHASE008_EVIDENCE_GUARD_REGRESSION",
  status: results.every(({ status }) => status === "PASS") ? "PASS" : "FAIL",
  databaseAccess: false,
  mutations: "MEMORY_ONLY",
  count: results.length,
  passed: results.filter(({ status }) => status === "PASS").length,
  failed: results.filter(({ status }) => status === "FAIL").length,
  cases: results,
};
const serialized = jsonBytes(report);
if (outputPath !== null) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, serialized, { flag: "wx" });
}
process.stdout.write(serialized);
if (report.status !== "PASS") process.exitCode = 1;
