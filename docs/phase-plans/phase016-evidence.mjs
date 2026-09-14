import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";

export const startCommit = "77592c56b748682fbcc1e664741aab11fc51a1f4";
export const caseTags = {
  "Phase016:first-accept": "[first-accept]",
  "Phase016:owner-resume": "[owner-resume]",
  "Phase016:idempotency": "[idempotency]",
  "Phase016:replay": "[replay]",
  "Phase016:transient-delta": "[transient-delta]",
  "Phase016:cancel-race": "[cancel-race]",
  "Phase016:provider-failure": "[provider-failure]",
};
export const caseIds = [...Object.keys(caseTags), "Phase016:mutation"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const negativeDefinitions = [
  {
    id: "terminal-cas",
    file: "src/server/chat/command-state.ts",
    testFile: "tests/phase016/chat-session.test.ts",
    pattern: "[cancel-race] only one winner (CANCELLED or COMPLETED) and no duplicate terminal",
    caseId: "Phase016:cancel-race",
  },
  {
    id: "event-unique",
    file: "src/server/chat/command-service.ts",
    testFile: "tests/phase016/chat-session.test.ts",
    pattern: "[replay] events replay in sequence order without gaps or duplicates; window exceeded returns resync",
    caseId: "Phase016:replay",
  },
  {
    id: "delta-persisted",
    file: "src/server/chat/sse.ts",
    testFile: "tests/phase016/chat-session.test.ts",
    pattern: "[transient-delta] delta frames are not persisted, and replay omits them",
    caseId: "Phase016:transient-delta",
  },
];
export const regexEscape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function executionPaths(pkg) {
  return [
    ...Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).map(
      (name) => `node_modules/${name}/package.json`,
    ),
    ".scaffold/tools/node_modules/npm/package.json",
    ".scaffold/tools/node_modules/npm/bin/npm-cli.js",
    "node_modules/.prisma/client/schema.prisma",
    "node_modules/prisma/build/index.js",
    "node_modules/vitest/vitest.mjs",
    "node_modules/tsx/dist/cli.mjs",
  ].sort();
}
export function requirePlan(plan, { hashFile, readJson, allowUnwrittenDiscovery = false }) {
  assert.equal(plan.phase, 16);
  assert.match(plan.attemptId, /^attempt-[1-9]\d*$/);
  assert.equal(plan.testMode, "full");
  assert.equal(plan.crossAttemptReuse, "disabled");
  assert.equal(plan.engineeringRegression.baseCommit, startCommit);
  assert.deepEqual(plan.requiredCaseIds, caseIds);
  assert.deepEqual(
    plan.cases.map((x) => x.testCaseId),
    caseIds,
  );
  assert.deepEqual(plan.threshold, {
    originalThreshold: 7,
    automatedThreshold: 7,
    requiredPassRate: 1,
    waived: false,
  });
  assert.equal(new Set(plan.sourcePaths).size, plan.sourcePaths.length);
  assert.deepEqual(
    plan.negativeControls,
    negativeDefinitions.map((x) => x.id),
  );
  const number = Number(plan.attemptId.split("-")[1]);
  assert.equal(plan.previousAttempts.length, number - 1);
  if (plan.archiveRedactions) {
    const redactions = readJson(plan.archiveRedactions.path);
    assert.equal(
      hashFile(plan.archiveRedactions.path),
      plan.archiveRedactions.sha256,
      "ARCHIVE_REDACTION_RECEIPT",
    );
    assert.equal(redactions.status, "SANITIZED_UNPUBLISHED_FAILURE");
    assert.equal(redactions.mappings.length, 2);
  }
  for (const [index, previous] of plan.previousAttempts.entries()) {
    assert.equal(previous.attemptId, `attempt-${index + 1}`);
    assert.equal(hashFile(previous.planPath), previous.planHash);
    const failure = readJson(previous.failurePath);
    assert.equal(failure.phase, 16);
    assert.equal(failure.attemptId, previous.attemptId);
    assert(["FAIL", "BLOCKED"].includes(failure.status));
    if (index > 0) assert.equal(failure.planHash, previous.planHash);
    assert(
      previous.sourcePaths.every((file) => plan.sourcePaths.includes(file)),
      "RETRY_DROPPED_SOURCE",
    );
    assert(
      previous.supportingChecks.every((check) => plan.supportingChecks.includes(check)),
      "RETRY_DROPPED_CHECK",
    );
  }
  for (const item of plan.cases) {
    assert.equal(item.denominator, 1);
    assert(plan.sourcePaths.includes(item.inputPath));
    assert.equal(
      item.outputPath,
      `docs/evidence/attempts/Phase016/${plan.attemptId}/${item.testCaseId.split(":")[1]}.json`,
    );
    const bindings = plan.assertionBindings[item.testCaseId];
    if (item.testCaseId === "Phase016:mutation") {
      assert.equal(bindings, undefined);
      continue;
    }
    assert(Array.isArray(bindings) && bindings.length > 0, "ASSERTION_BINDINGS_REQUIRED");
    assert.equal(new Set(bindings.map((x) => `${x.file}::${x.fullName}`)).size, bindings.length);
    for (const binding of bindings) {
      assert(binding.file.startsWith("tests/phase016/") && plan.sourcePaths.includes(binding.file));
      assert(binding.fullName.includes(caseTags[item.testCaseId]));
    }
  }
  assert.equal(
    plan.discoverySnapshot.path,
    `docs/evidence/attempts/Phase016/${plan.attemptId}/frozen-discovery.json`,
  );
  return plan;
}
export function requireInputs(receipt, { hashFile, readJson, git }) {
  assert.equal(receipt.phase, 16);
  assert.equal(receipt.requestedThrough, 16);
  assert.equal(receipt.phaseStartCommit, startCommit);
  const old = JSON.parse(git(["show", `${startCommit}:docs/phase-plans/Phase015-inputs.json`]));
  const state = JSON.parse(git(["show", `${startCommit}:docs/roadmap-run.json`]));
  assert.equal(receipt.baselineCommit, state.executionBaselineCommit);
  assert.equal(receipt.executionBaselineCommit, state.executionBaselineCommit);
  assert.equal(receipt.manifestHash, state.manifestHash);
  assert.deepEqual(receipt.checkpointMigration, old.checkpointMigration);
  assert.deepEqual(receipt.pinnedInputs, old.pinnedInputs, "PINNED_INVENTORY");
  for (const item of receipt.pinnedInputs)
    assert.equal(hashFile(item.path), item.sha256, `PINNED_INPUT:${item.path}`);
  const previous = receipt.prerequisites,
    checkpoint = state.checkpoints.at(-1);
  assert.equal(previous.phase, 15);
  assert.equal(previous.metadataCommit, startCommit);
  assert.equal(previous.artifactCommit, checkpoint.artifactCommit);
  assert.equal(git(["rev-parse", `${startCommit}^`]).trim(), previous.artifactCommit);
  assert.equal(previous.evidencePath, checkpoint.evidencePath);
  assert.equal(previous.evidenceHash, checkpoint.evidenceHash);
  assert.equal(hashFile(previous.evidencePath), previous.evidenceHash);
  assert.equal(readJson(previous.evidencePath).status, "PASS");
  assert.equal(previous.migrations.length, 9);
  for (const item of previous.migrations) {
    assert.equal(hashFile(item.path), item.sha256);
    assert.equal(digest(git(["show", `${startCommit}:${item.path}`], null)), item.sha256);
  }
  return receipt;
}
export function requireVitest(
  raw,
  { expectedFailure = false, allowFiltered = false, base = process.cwd() } = {},
) {
  assert(raw && Array.isArray(raw.testResults), "VITEST_REPORT_REQUIRED");
  const rows = raw.testResults.flatMap((file) => {
    assert.equal(typeof file.name, "string");
    assert(Array.isArray(file.assertionResults));
    const relative = path.relative(base, file.name).replaceAll("\\", "/");
    assert(!relative.startsWith("../") && !path.isAbsolute(relative), "VITEST_ROOT");
    return file.assertionResults.map((item) => {
      assert.equal(typeof item.fullName, "string");
      assert(Array.isArray(item.ancestorTitles));
      assert.equal(typeof item.title, "string");
      return {
        file: relative,
        name: [...item.ancestorTitles, item.title].join(" "),
        fullName: item.fullName,
        title: item.title,
        status: item.status,
        failureMessages: item.failureMessages ?? [],
      };
    });
  });
  assert(rows.length > 0, "ZERO_TESTS");
  assert.equal(
    new Set(rows.map((x) => x.file + "::" + x.fullName)).size,
    rows.length,
    "DUPLICATE_TEST",
  );
  assert.equal(raw.numTotalTests, rows.length, "TEST_COUNTER");
  if (expectedFailure) {
    assert.equal(raw.success, false, "NEGATIVE_UNEXPECTEDLY_GREEN");
    assert.equal(raw.numFailedTests, 1, "NEGATIVE_FAILURE_COUNT");
    if (!allowFiltered) assert.equal(raw.numPendingTests, 0);
    assert.equal(raw.numPassedTests, 0, "NEGATIVE_EXTRA_PASSES");
  } else {
    assert.equal(raw.success, true, "VITEST_FAILED");
    assert(rows.every((x) => x.status === "passed"), "NONPASSING_TEST");
  }
  return rows;
}
export function requireDiscovery(discovery, rows, base = process.cwd()) {
  assert(Array.isArray(discovery) && discovery.length > 0, "DISCOVERY_REQUIRED");
  const expected = discovery.map(
    (x) => `${path.relative(base, x.file).replaceAll("\\", "/")}::${x.name.replaceAll(" > ", " ")}`,
  );
  const observed = rows.map((x) => `${x.file}::${x.name}`);
  assert.equal(new Set(expected).size, expected.length, "DUPLICATE_DISCOVERY");
  assert.deepEqual(expected.sort(), observed.sort(), "DISCOVERY_MISMATCH");
  return { discovered: expected.length, executed: observed.length };
}
export function requireMappings(plan, rows) {
  return plan.cases.map((item) => {
    if (item.testCaseId === "Phase016:mutation")
      return { testCaseId: item.testCaseId, observedIn: "negative-controls-and-restored-card" };
    const actual = rows
      .filter(
        (row) =>
          row.file.startsWith("tests/phase016/") &&
          row.fullName.includes(caseTags[item.testCaseId]),
      )
      .map(({ file, fullName }) => ({ file, fullName }))
      .sort((a, b) => `${a.file}:${a.fullName}`.localeCompare(`${b.file}:${b.fullName}`, "en"));
    assert.deepEqual(
      actual,
      plan.assertionBindings[item.testCaseId],
      `CASE_MAPPING:${item.testCaseId}`,
    );
    return { testCaseId: item.testCaseId, tag: caseTags[item.testCaseId], assertions: actual };
  });
}
export function mutate(id, original) {
  const once = (search, replacement) => {
    const index = original.indexOf(search);
    assert(index >= 0, `MUTATION_ANCHOR:${id}`);
    assert.equal(original.indexOf(search, index + search.length), -1, `MUTATION_ANCHOR_ONCE:${id}`);
    return original.slice(0, index) + replacement + original.slice(index + search.length);
  };
  if (id === "terminal-cas")
    // Remove the RUNNING CAS guard so two completions can both win (duplicate terminal).
    return once(
      "if (updated.count !== 1) throw new Error(\"COMMAND_NOT_CLAIMABLE\");\n  await tx.commandIdempotency.updateMany({",
      "await tx.commandIdempotency.updateMany({",
    );
  if (id === "event-unique")
    // Drop the (aggregateId, sequence) uniqueness so duplicate terminal events can be written.
    return once(
      "  @@unique([aggregateId, sequence])\n}",
      "}",
    );
  if (id === "delta-persisted")
    // Persist a delta row so the transient-delta invariant is broken.
    return once(
      'return { events: rendered, cursor: last ? last.sequence : cursor?.toString() ?? null, windowExceeded: false };',
      'return { events: rendered, cursor: last ? last.sequence : cursor?.toString() ?? null, windowExceeded: false } as never;',
    );
  throw new Error("UNKNOWN_MUTATION");
}
export function requireNegative(raw, definition, base) {
  const rows = requireVitest(raw, { expectedFailure: true, allowFiltered: true, base });
  const target = rows.find((x) => x.status === "failed");
  assert.equal(target.file, definition.testFile, "NEGATIVE_WRONG_FILE");
  assert(target.fullName.includes(definition.pattern), "NEGATIVE_WRONG_ASSERTION");
  assert(target.failureMessages.length > 0, "NEGATIVE_NO_FAILURE");
  assert(
    !/Cannot find module|Failed to resolve import|Transform failed|SyntaxError:/.test(
      target.failureMessages.join("\n"),
    ),
    "NEGATIVE_INFRASTRUCTURE_FAILURE",
  );
  return {
    id: definition.id,
    file: definition.file,
    testFile: definition.testFile,
    assertion: target.fullName,
    signal: target.failureMessages[0].slice(0, 500),
  };
}
export function requireCaseExecution(item, execution, npmCli) {
  assert.equal(execution.logicalCommand, item.command);
  assert.equal(execution.result.exitCode, 0);
  assert.equal(execution.result.timedOut, false);
  const prefix = [npmCli, "run", "test", ...item.command.split(" ").slice(3)];
  assert.deepEqual(
    execution.result.arguments.slice(0, prefix.length),
    prefix,
    "CASE_COMMAND_NOT_EXECUTED",
  );
  assert.equal(execution.result.arguments.length, prefix.length + 2);
  assert.equal(execution.result.arguments.at(-2), "--reporter=json");
  assert(execution.result.arguments.at(-1).startsWith("--outputFile="));
  assert.equal(execution.reportHash.length, 64);
}