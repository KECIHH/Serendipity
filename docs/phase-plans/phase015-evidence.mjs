import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { requirePriorCaseBinding } from "../../scripts/phase-evidence.mjs";

export const startCommit = "66f595a9348a69016771e86d9a1417b48ddb0ee6";
export const caseTags = {
  "Phase015:schema-bootstrap": "[schema-bootstrap]",
  "Phase015:resolution": "[resolution]",
  "Phase015:isolation-ssrf": "[isolation]",
  "Phase015:timeout-cancel-retry": "[timeout-cancel-retry]",
  "Phase015:quota-cost": "[quota-cost]",
  "Phase015:version-evidence": "[version-evidence]",
  "Phase015:kill-switch": "[kill-switch]",
};
export const caseIds = [...Object.keys(caseTags), "Phase015:mutation"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const negativeDefinitions = [
  {
    id: "guarded-client-boundary",
    file: "src/server/ai/guarded-client.ts",
    testFile: "tests/phase015/provider-registry.test.ts",
    pattern:
      "[isolation] business SDK, network, direct adapter and secret imports stay inside declared boundaries",
    caseId: "Phase015:isolation-ssrf",
  },
  {
    id: "activation-check",
    file: "src/server/services/model-resolution-service.ts",
    testFile: "tests/phase015/prompt-service.test.ts",
    pattern: "[resolution] both resolvers reject disabled tuples and stale activation CAS",
    caseId: "Phase015:resolution",
  },
  {
    id: "kill-switch",
    file: "src/server/ai/guarded-client.ts",
    testFile: "tests/phase015/ai-governance.test.ts",
    pattern:
      "[kill-switch] default and restart stay closed; real ADMIN enablement is audited and guarded",
    caseId: "Phase015:kill-switch",
  },
  {
    id: "reservation-cas",
    file: "src/server/ai/usage-reservations.ts",
    testFile: "tests/phase015/guarded-client.test.ts",
    pattern:
      "[quota-cost] concurrent Decimal reservations never exceed the frozen token or cost cap",
    caseId: "Phase015:quota-cost",
  },
  {
    id: "abort-signal",
    file: "src/server/ai/guarded-client.ts",
    testFile: "tests/phase015/guarded-client.test.ts",
    pattern:
      "[timeout-cancel-retry] external AbortSignal cancels an in-flight request and never retries",
    caseId: "Phase015:timeout-cancel-retry",
  },
  {
    id: "unknown-expiry-release",
    file: "src/server/ai/usage-reservations.ts",
    testFile: "tests/phase015/guarded-client.test.ts",
    pattern: "[quota-cost] NOT_SENT release and unknown upper-bound reconciliation are idempotent",
    caseId: "Phase015:quota-cost",
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
  assert.equal(plan.phase, 15);
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
    originalThreshold: 8,
    automatedThreshold: 8,
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
  const redactions = plan.archiveRedactions
    ? readJson(plan.archiveRedactions.path)
    : { mappings: [] };
  if (plan.archiveRedactions) {
    assert.equal(
      hashFile(plan.archiveRedactions.path),
      plan.archiveRedactions.sha256,
      "ARCHIVE_REDACTION_RECEIPT",
    );
    assert(plan.sourcePaths.includes(plan.archiveRedactions.path));
    assert.equal(redactions.status, "SANITIZED_UNPUBLISHED_FAILURE");
    assert.equal(redactions.mappings.length, 2);
    for (const mapping of redactions.mappings) {
      assert(
        [
          "docs/evidence/attempts/Phase015/attempt-5/attempt.json",
          "docs/evidence/attempts/Phase015/attempt-5/commands/004.json",
        ].includes(mapping.originalPath),
      );
      assert.equal(mapping.publicPath, mapping.originalPath.replace(/\.json$/, "-redacted.json"));
      assert(plan.sourcePaths.includes(mapping.publicPath));
      assert.equal(hashFile(mapping.publicPath), mapping.publicSha256, "ARCHIVE_REDACTION_BYTES");
      assert(mapping.redactions > 0 && mapping.originalBytes > 0);
    }
  }
  const archived = (file, expected) => {
    const mapping = redactions.mappings.find(
      (row) => row.originalPath === file && row.originalSha256 === expected,
    );
    if (mapping) return mapping.publicPath;
    assert.equal(hashFile(file), expected);
    return file;
  };
  for (const [index, previous] of plan.previousAttempts.entries()) {
    assert.equal(previous.attemptId, `attempt-${index + 1}`);
    assert.equal(hashFile(previous.planPath), previous.planHash);
    const failurePath = archived(previous.failurePath, previous.failureHash);
    const old = readJson(previous.planPath),
      failure = readJson(failurePath);
    assert.equal(old.attemptId, previous.attemptId);
    assert.equal(failure.phase, 15);
    assert.equal(failure.attemptId, previous.attemptId);
    assert(["FAIL", "BLOCKED"].includes(failure.status));
    // The original attempt-1 receipt has a documented orphan planHash. Its exact failed bytes remain evidence, never a pass source.
    if (index > 0) assert.equal(failure.planHash, previous.planHash);
    for (const artifact of failure.artifacts ?? []) archived(artifact.path, artifact.sha256);
    requirePriorCaseBinding(plan, old, { readJson, hashFile });
    assert(
      old.sourcePaths.every((file) => plan.sourcePaths.includes(file)),
      "RETRY_DROPPED_SOURCE",
    );
    assert(
      old.supportingChecks.every((check) => plan.supportingChecks.includes(check)),
      "RETRY_DROPPED_CHECK",
    );
  }
  for (const item of plan.cases) {
    assert.equal(item.denominator, 1);
    assert(plan.sourcePaths.includes(item.inputPath));
    assert.equal(
      item.outputPath,
      `docs/evidence/attempts/Phase015/${plan.attemptId}/${item.testCaseId.split(":")[1]}.json`,
    );
    const bindings = plan.assertionBindings[item.testCaseId];
    if (item.testCaseId === "Phase015:mutation") {
      assert.equal(bindings, undefined);
      continue;
    }
    assert(Array.isArray(bindings) && bindings.length > 0, "ASSERTION_BINDINGS_REQUIRED");
    assert.equal(new Set(bindings.map((x) => `${x.file}::${x.fullName}`)).size, bindings.length);
    for (const binding of bindings) {
      assert(binding.file.startsWith("tests/phase015/") && plan.sourcePaths.includes(binding.file));
      assert(binding.fullName.includes(caseTags[item.testCaseId]));
    }
  }
  assert.equal(
    plan.discoverySnapshot.path,
    `docs/evidence/attempts/Phase015/${plan.attemptId}/frozen-discovery.json`,
  );
  if (!allowUnwrittenDiscovery) {
    assert.equal(
      hashFile(plan.discoverySnapshot.path),
      plan.discoverySnapshot.sha256,
      "FROZEN_DISCOVERY_HASH",
    );
    const discovery = readJson(plan.discoverySnapshot.path);
    assert.equal(discovery.length, plan.discoverySnapshot.discovered);
    requireMappings(
      plan,
      discovery.map((row) => ({
        file: path.relative(process.cwd(), row.file).replaceAll("\\", "/"),
        fullName: row.name.replaceAll(" > ", " "),
      })),
    );
  }
  return plan;
}
export function requireInputs(receipt, { hashFile, readJson, readBytes, git }) {
  assert.equal(receipt.phase, 15);
  assert.equal(receipt.requestedThrough, 15);
  assert.equal(receipt.phaseStartCommit, startCommit);
  const old = JSON.parse(git(["show", `${startCommit}:docs/phase-plans/Phase014-inputs.json`]));
  const state = JSON.parse(git(["show", `${startCommit}:docs/roadmap-run.json`]));
  assert.equal(receipt.baselineCommit, state.executionBaselineCommit);
  assert.equal(receipt.executionBaselineCommit, state.executionBaselineCommit);
  assert.equal(receipt.manifestHash, state.manifestHash);
  assert.deepEqual(receipt.checkpointMigration, old.checkpointMigration);
  assert.deepEqual(receipt.pinnedInputs, old.pinnedInputs, "PINNED_INVENTORY");
  for (const item of receipt.pinnedInputs)
    assert.equal(hashFile(item.path), item.sha256, `PINNED_INPUT:${item.path}`);
  for (const [field, policy] of [
    ["checkpointMaintenance", "validationPolicy"],
    ["executionMaintenance", "executionPolicy"],
  ]) {
    assert.deepEqual(receipt[field], old[field]);
    assert.deepEqual(receipt[policy], old[policy]);
    assert.deepEqual(readJson(receipt[field].path).policy, receipt[policy]);
    git(["merge-base", "--is-ancestor", receipt[field].commit, startCommit]);
    for (const binding of [receipt[field], receipt[policy]]) {
      assert.equal(hashFile(binding.path), binding.sha256);
      assert.equal(
        digest(git(["show", `${receipt[field].commit}:${binding.path}`], null)),
        binding.sha256,
      );
      assert(!readBytes(binding.path).includes(13), "POLICY_LF");
    }
  }
  const previous = receipt.prerequisites,
    checkpoint = state.checkpoints.at(-1);
  assert.equal(previous.phase, 14);
  assert.equal(previous.metadataCommit, startCommit);
  assert.equal(previous.artifactCommit, checkpoint.artifactCommit);
  assert.equal(git(["rev-parse", `${startCommit}^`]).trim(), previous.artifactCommit);
  assert.equal(previous.evidencePath, checkpoint.evidencePath);
  assert.equal(previous.evidenceHash, checkpoint.evidenceHash);
  assert.equal(hashFile(previous.evidencePath), previous.evidenceHash);
  assert.equal(
    digest(git(["show", `${startCommit}:${previous.evidencePath}`], null)),
    previous.evidenceHash,
  );
  assert.equal(readJson(previous.evidencePath).status, "PASS");
  assert.equal(
    digest(git(["show", `${startCommit}:${previous.schemaPath}`], null)),
    previous.schemaHash,
  );
  assert.equal(previous.migrations.length, 8);
  for (const item of previous.migrations) {
    assert.equal(hashFile(item.path), item.sha256);
    assert.equal(digest(git(["show", `${startCommit}:${item.path}`], null)), item.sha256);
  }
  const recovery = readJson(receipt.recoveryAdmission.path);
  assert.equal(hashFile(receipt.recoveryAdmission.path), receipt.recoveryAdmission.sha256);
  assert.equal(recovery.mode, "RESUMED_PHASE_CANDIDATE");
  assert.equal(recovery.head, startCommit);
  assert.equal(recovery.remoteHead, startCommit);
  assert.equal(recovery.originalPreflight, "UNVERIFIED_PRESERVED_IN_ATTEMPT_10");
  assert.equal(recovery.isolatedBaseline.workingTree, "");
  assert.equal(recovery.isolatedBaseline.head, startCommit);
  assert.equal(recovery.remoteVerification.exitCode, 0);
  assert.equal(recovery.remoteVerification.head, startCommit);
  assert.deepEqual(recovery.shells.map((x) => x.shell).sort(), [
    "PowerShell 7",
    "Windows PowerShell 5.1",
  ]);
  for (const row of recovery.shells) {
    assert.equal(row.exitCode, 0);
    assert.equal(row.result.status, "PASS");
    assert.equal(row.result.scope, "ROOT_LAYOUT_PHASE_CHECKPOINT_SEAL");
    assert.equal(row.result.protocolFixture, false);
    assert.equal(row.result.completedThrough, 14);
    assert.equal(row.result.currentPhase, 15);
    assert.equal(row.result.artifactCommit, previous.artifactCommit);
    assert.equal(row.result.metadataCommit, startCommit);
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
  for (const [field, statuses] of [
    ["numPassedTests", ["passed"]],
    ["numFailedTests", ["failed"]],
    ["numPendingTests", ["pending", "skipped"]],
    ["numTodoTests", ["todo"]],
  ])
    assert.equal(
      raw[field],
      rows.filter((x) => statuses.includes(x.status)).length,
      `COUNTER:${field}`,
    );
  if (expectedFailure) {
    assert.equal(raw.success, false, "NEGATIVE_UNEXPECTEDLY_GREEN");
    assert.equal(raw.numFailedTests, 1, "NEGATIVE_FAILURE_COUNT");
    if (!allowFiltered) assert.equal(raw.numPendingTests, 0);
    assert.equal(raw.numPassedTests, 0, "NEGATIVE_EXTRA_PASSES");
  } else {
    assert.equal(raw.success, true, "VITEST_FAILED");
    assert(
      rows.every((x) => x.status === "passed"),
      "NONPASSING_TEST",
    );
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
    if (item.testCaseId === "Phase015:mutation")
      return { testCaseId: item.testCaseId, observedIn: "negative-controls-and-restored-card" };
    const actual = rows
      .filter(
        (row) =>
          row.file.startsWith("tests/phase015/") &&
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
  if (id === "guarded-client-boundary")
    return once(
      'import "server-only";\n',
      'import "server-only";\nimport { DeepSeekProvider } from "@/server/ai/deepseek-provider";\nvoid DeepSeekProvider;\n',
    );
  if (id === "activation-check")
    return once(
      'if (!activation || activation.status !== "ACTIVE") throw new Error("CONFIG_ERROR");',
      'if (!activation) throw new Error("CONFIG_ERROR");',
    );
  if (id === "kill-switch")
    return once(
      '  try {\n    if (!(await isAiEnabled(options.db))) return safeError("FEATURE_DISABLED", input.traceId);',
      "  try {",
    );
  if (id === "reservation-cas")
    return once(
      "await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${prefix},0::bigint))`;",
      "await Promise.resolve();",
    );
  if (id === "abort-signal")
    return once('input.signal?.addEventListener("abort", abort, { once: true });', "void abort;");
  if (id === "unknown-expiry-release")
    return once(
      'data: { status: "SETTLED", actualTokens: tokens, actualCost: cost, settledAt: proof.now },',
      'data: { status: "RELEASED", submissionState: "NOT_SENT", settledAt: proof.now },',
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
