import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { requirePriorCaseBinding } from "../../scripts/phase-evidence.mjs";

export const caseIds = [
  "settings",
  "public-projection",
  "dashboard",
  "authorization",
  "m3-regression",
].map((id) => `Phase014:${id}`);
export const tables = [
  "AdminCommandReceipt",
  "ApiKeyConfig",
  "AuditLog",
  "AuthLoginAttempt",
  "AuthSession",
  "ChatMessage",
  "KeyRotationRun",
  "SystemConfig",
  "TravelRecord",
  "User",
];
const start = "baeab8dc0904c10f6df0b6a3bec931d5eb2a07c0";
const previousMetadata = "7fd6285a2d9cf91b2e2b8f3e725c3b99da9253e2";
const previousArtifact = "1ddff2e0d3c89492cb50268ffcc5cb4673a69a31";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

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

export function requireInputs(receipt, { hashFile, readJson, readBytes, git }) {
  assert.equal(receipt.phase, 14);
  assert.equal(receipt.requestedThrough, 14);
  assert.equal(receipt.phaseStartCommit, start);
  assert.equal(receipt.prerequisites.metadataCommit, previousMetadata);
  assert.equal(receipt.prerequisites.artifactCommit, previousArtifact);
  assert.equal(git(["rev-parse", `${start}^`]).trim(), previousMetadata, "INPUT_PARENT");
  assert.equal(
    git(["rev-parse", `${previousMetadata}^`]).trim(),
    previousArtifact,
    "INPUT_ARTIFACT_PARENT",
  );
  for (const [field, policy, version, commit] of [
    [
      "checkpointMaintenance",
      "validationPolicy",
      "phase-verification-v1",
      "408f6ae5516069efcaa423cc61ea431e528bd040",
    ],
    ["executionMaintenance", "executionPolicy", "phase-execution-v2", start],
  ]) {
    const maintenance = receipt[field],
      input = receipt[policy];
    assert.equal(maintenance.commit, commit);
    assert.equal(hashFile(maintenance.path), maintenance.sha256);
    assert.deepEqual(readJson(maintenance.path).policy, input);
    assert.equal(input.version, version);
    assert.equal(hashFile(input.path), input.sha256);
    assert(!readBytes(input.path).includes(13), "INPUT_LF");
    for (const binding of [maintenance, input])
      assert.equal(
        digest(git(["show", `${commit}:${binding.path}`], null)),
        binding.sha256,
        "INPUT_COMMITTED_BYTES",
      );
  }
  const preflight = receipt.preflight;
  assert.equal(preflight.head, start);
  assert.equal(preflight.workingTree, "");
  assert.equal(preflight.branch, "main");
  assert.equal(preflight.remote, "https://github.com/KECIHH/Serendipity.git");
  assert.equal(preflight.originMain, start);
  assert.equal(preflight.remoteHead, start);
  assert.equal(preflight.ahead, 0);
  assert.equal(preflight.behind, 0);
  assert.equal(preflight.currentPhase, 14);
  assert.equal(preflight.completedThrough, 13);
  assert.equal(preflight.remoteVerification.exitCode, 0);
  assert.equal(preflight.remoteVerification.head, start);
  assert.equal(preflight.remoteVerification.command, "git ls-remote origin refs/heads/main");
  assert.deepEqual(preflight.shells.map((shell) => shell.shell).sort(), [
    "PowerShell 7",
    "Windows PowerShell 5.1",
  ]);
  for (const shell of preflight.shells) {
    assert.equal(shell.exitCode, 0);
    assert.equal(shell.result.status, "PASS");
    assert.equal(shell.result.scope, "ROOT_LAYOUT_PHASE_CHECKPOINT_ADMISSION");
    assert.equal(shell.result.protocolFixture, false);
    assert.equal(shell.result.completedThrough, 13);
    assert.equal(shell.result.currentPhase, 14);
    assert.equal(shell.result.artifactCommit, previousArtifact);
    assert.equal(shell.result.metadataCommit, previousMetadata);
    assert.equal(shell.result.maintenanceHead, start);
    assert.equal(shell.result.admissionOnly, true);
    assert.deepEqual(shell.result.checkpointMaintenance, {
      ...receipt.checkpointMaintenance,
      policy: receipt.validationPolicy,
    });
    assert.deepEqual(shell.result.executionMaintenance, {
      ...receipt.executionMaintenance,
      policy: receipt.executionPolicy,
    });
  }
  assert.equal(hashFile(preflight.reportPath), preflight.reportHash);
  for (const [field, value] of Object.entries(readJson(preflight.reportPath)))
    assert.deepEqual(preflight[field], value);
  assert.deepEqual(
    receipt.pinnedInputs,
    JSON.parse(git(["show", `${start}:docs/phase-plans/Phase013-inputs.json`])).pinnedInputs,
    "PINNED_INPUT_INVENTORY",
  );
  for (const item of receipt.pinnedInputs)
    assert.equal(hashFile(item.path), item.sha256, `PINNED_INPUT:${item.path}`);
  assert.equal(hashFile(receipt.prerequisites.evidencePath), receipt.prerequisites.evidenceHash);
  assert.equal(hashFile(receipt.prerequisites.schemaPath), receipt.prerequisites.schemaHash);
  assert.equal(receipt.prerequisites.migrations.length, 8);
  for (const item of receipt.prerequisites.migrations) {
    assert.equal(hashFile(item.path), item.sha256);
    assert.equal(digest(git(["show", `${start}:${item.path}`], null)), item.sha256);
  }
}

export function requirePlan(plan, { readJson, hashFile }) {
  assert.equal(plan.phase, 14);
  assert.equal(plan.testMode, "full");
  assert.equal(plan.crossAttemptReuse, "disabled");
  assert.deepEqual(plan.requiredCaseIds, caseIds);
  assert.deepEqual(
    plan.cases.map((item) => item.testCaseId),
    caseIds,
  );
  assert.deepEqual(plan.threshold, {
    originalThreshold: 5,
    automatedThreshold: 5,
    requiredPassRate: 1,
    waived: false,
  });
  assert.deepEqual(
    plan.negativeControls,
    negativeDefinitions.map((item) => item.id),
  );
  assert.equal(new Set(plan.sourcePaths).size, plan.sourcePaths.length);
  for (const item of plan.cases) {
    assert.equal(item.denominator, 1);
    assert.equal(item.command, "node docs/phase-plans/verify-phase014.mjs --all");
    assert.equal(
      item.outputPath,
      `docs/evidence/attempts/Phase014/${plan.attemptId}/${item.testCaseId.split(":")[1]}.json`,
    );
    assert(plan.sourcePaths.includes(item.inputPath));
  }
  for (const previous of plan.previousAttempts) {
    assert.equal(hashFile(previous.planPath), previous.planHash);
    assert.equal(hashFile(previous.failurePath), previous.failureHash);
    const old = readJson(previous.planPath),
      failure = readJson(previous.failurePath);
    assert.equal(old.attemptId, previous.attemptId);
    assert.equal(failure.phase, 14);
    assert.equal(failure.attemptId, old.attemptId);
    assert(["FAIL", "BLOCKED"].includes(failure.status));
    assert.equal(failure.planHash, previous.planHash);
    for (const artifact of failure.artifacts)
      assert.equal(hashFile(artifact.path), artifact.sha256);
    requirePriorCaseBinding(plan, old, { readJson, hashFile });
    assert(
      old.sourcePaths.every((file) => plan.sourcePaths.includes(file)),
      "RETRY_DROPPED_SOURCE",
    );
    assert.deepEqual(plan.supportingChecks, old.supportingChecks);
    assert.equal(old.testMode, plan.testMode);
  }
}

export function assertions(raw, base) {
  assert(raw && Array.isArray(raw.testResults), "VITEST_REPORT_REQUIRED");
  return raw.testResults.flatMap((suite) => {
    assert(typeof suite.name === "string" && Array.isArray(suite.assertionResults));
    const file = path.relative(base, suite.name).replaceAll("\\", "/");
    assert(!file.startsWith("../") && !path.isAbsolute(file), "VITEST_ROOT");
    return suite.assertionResults.map((test) => {
      assert(typeof test.fullName === "string" && test.fullName.length > 0);
      assert(Array.isArray(test.ancestorTitles) && typeof test.title === "string");
      return {
        file,
        fullName: test.fullName,
        discoveryName: [...test.ancestorTitles, test.title].join(" > "),
        status: test.status,
        failureMessages: test.failureMessages ?? [],
      };
    });
  });
}
export function requireVitest(raw, { base, expectedFailure = false, allowFiltered = false }) {
  const rows = assertions(raw, base);
  assert(rows.length > 0, "VITEST_ZERO_ASSERTIONS");
  assert.equal(
    new Set(rows.map((r) => r.file + "\0" + r.fullName)).size,
    rows.length,
    "VITEST_DUPLICATE",
  );
  assert.equal(raw.numTotalTests, rows.length);
  for (const [field, statuses] of [
    ["numPassedTests", ["passed"]],
    ["numFailedTests", ["failed"]],
    ["numPendingTests", ["skipped", "pending"]],
    ["numTodoTests", ["todo"]],
  ])
    assert.equal(
      raw[field] ?? 0,
      rows.filter((row) => statuses.includes(row.status)).length,
      `VITEST_COUNT:${field}`,
    );
  assert.equal(raw.numRuntimeErrorTestSuites ?? 0, 0);
  assert.equal(raw.unhandledErrors?.length ?? 0, 0, "VITEST_UNHANDLED_ERRORS");
  for (const row of rows) {
    assert(["passed", "failed", "skipped", "pending", "todo"].includes(row.status));
    assert(Array.isArray(row.failureMessages));
    assert(row.failureMessages.every((message) => typeof message === "string"));
    if (row.status !== "failed") assert.equal(row.failureMessages.length, 0);
  }
  if (expectedFailure) {
    assert.equal(raw.success, false);
    assert(raw.numFailedTests > 0);
    for (const row of rows.filter((r) => r.status === "failed")) {
      assert(row.failureMessages.length > 0);
      for (const message of row.failureMessages) {
        const header = message
          .split(/\r?\n/)
          .filter((line) => !/^\s*at\s/.test(line))
          .join("\n");
        assert(
          !/Cannot find module|Failed to resolve|SyntaxError|ReferenceError|PrismaClientInitializationError|\bP(?:1000|1001|1002|1003|1008|1010|1011|1013|1017|2024|2037)\b|\bE(?:CONNREFUSED|CONNRESET|TIMEDOUT)\b|(?:Test|Hook|hook)\s+timed\s+out/i.test(
            header,
          ),
          "NEGATIVE_INFRASTRUCTURE_FAILURE",
        );
      }
    }
  } else {
    assert.equal(raw.success, true);
    assert.equal(raw.numFailedTests, 0);
    assert(raw.numPassedTests > 0);
    if (!allowFiltered)
      assert(
        rows.every((row) => row.status === "passed"),
        "VITEST_SKIPPED_REQUIRED_ASSERTION",
      );
  }
  return rows;
}
export function requireDiscovery(discovery, rows, base) {
  assert(Array.isArray(discovery) && discovery.length > 0, "DISCOVERY_REQUIRED");
  const expected = discovery
    .map((entry) => {
      assert(typeof entry.file === "string" && typeof entry.name === "string");
      const file = path.relative(base, entry.file).replaceAll("\\", "/");
      assert(!file.startsWith("../") && !path.isAbsolute(file));
      return file + "\0" + entry.name;
    })
    .sort();
  assert.equal(new Set(expected).size, expected.length, "DISCOVERY_DUPLICATE");
  assert.deepEqual(
    rows.map((r) => r.file + "\0" + r.discoveryName).sort(),
    expected,
    "DISCOVERY_EXECUTION_MISMATCH",
  );
  assert(rows.every((r) => r.status === "passed"));
  return {
    discoveredAssertions: expected.length,
    executedAssertions: rows.length,
    discoveredFiles: [...new Set(rows.map((r) => r.file))].sort(),
  };
}
export function requireMappings(plan, rows) {
  return plan.cases.map((item) => {
    const selected = rows.filter(
      (row) =>
        row.file === item.assertionSelector.file &&
        row.fullName.includes(item.assertionSelector.tag),
    );
    assert(
      selected.length >= item.assertionSelector.minimum,
      `CASE_MAPPING_MISSING:${item.testCaseId}`,
    );
    assert(selected.every((row) => row.status === "passed"));
    return {
      testCaseId: item.testCaseId,
      assertions: selected.map(({ file, fullName }) => ({ file, fullName })),
      assertionCount: selected.length,
    };
  });
}

export const negativeDefinitions = [
  {
    id: "require-admin",
    file: "src/server/auth/guards.ts",
    testFile: "tests/admin/security.test.ts",
    pattern: "requireAdmin rejects an anonymous route before its resource callback",
    caseId: caseIds[3],
    failure: "expected 200 to be 401",
  },
  {
    id: "public-allowlist",
    file: "src/server/config/config-service.ts",
    testFile: "tests/admin/settings.test.ts",
    pattern:
      "enforces both visibility gates, strips internal fields and changes ETag only for public projection",
    caseId: caseIds[1],
    failure: "expected 503 to be 200",
  },
  {
    id: "revision-cas",
    file: "src/server/admin/settings.ts",
    testFile: "tests/admin/settings.test.ts",
    pattern:
      "admits exactly one same-timestamp CAS winner and persists restart-safe idempotent replay",
    caseId: caseIds[0],
    failure: "expected [ 200, 200 ] to deeply equal [ 200, 409 ]",
  },
  {
    id: "audit-atomicity",
    file: "src/server/admin/settings.ts",
    testFile: "tests/admin/settings.test.ts",
    pattern: "reads exact DTOs and updates every group with paired canonical-hash audits",
    caseId: caseIds[0],
    failure: "expected 503 to be 200",
  },
];
export function mutate(id, original) {
  const replace = (source, expression, replacement) => {
    const matches = [...source.matchAll(new RegExp(expression.source, "g"))];
    assert.equal(matches.length, 1, `MUTATION_ANCHOR:${id}`);
    return source.replace(expression, replacement);
  };
  let changed;
  if (id === "require-admin")
    changed = replace(
      original,
      /const principal = await requireAdmin\(request\);/,
      "const principal = undefined as never;",
    );
  else if (id === "public-allowlist")
    changed = replace(original, /, key: \{ in: \[\.\.\.PUBLIC_CONFIG_KEYS\] \}/, "");
  else if (id === "revision-cas") {
    changed = replace(
      original,
      /if \(target\.revision !== patch\.expectedVersion\)[\s\S]*?;\n/,
      "",
    );
    changed = replace(
      changed,
      /where: \{ id: target\.id, revision: patch\.expectedVersion \}/,
      "where: { id: target.id }",
    );
  } else if (id === "audit-atomicity")
    changed = replace(original, /await writeAuditLog\(tx, \{[\s\S]*?\n\s*\}\);/, "void tx;");
  else throw new Error("UNKNOWN_MUTATION");
  assert.notEqual(changed, original);
  return changed;
}
export function requireNegative(raw, definition, base, readText) {
  const rows = requireVitest(raw, { base, expectedFailure: true, allowFiltered: true });
  const failed = rows.filter((row) => row.status === "failed");
  assert.equal(failed.length, 1, "NEGATIVE_TARGET_COUNT");
  const target = failed[0];
  assert.equal(target.file, definition.testFile);
  assert(target.fullName.endsWith(definition.pattern), "NEGATIVE_WRONG_ASSERTION");
  const message = target.failureMessages.join("\n").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  assert(message.includes(definition.failure), "NEGATIVE_WRONG_FAILURE_SIGNAL");
  const frame = message
    .split(/\r?\n/)
    .find(
      (line) =>
        /^\s*at /.test(line) &&
        line.replaceAll("\\", "/").includes(`${base.replaceAll("\\", "/")}/tests/`),
    );
  assert(
    frame && frame.replaceAll("\\", "/").includes(definition.testFile),
    "NEGATIVE_NO_ORIGINAL_TEST_FRAME",
  );
  const line = Number(frame.match(/:(\d+):\d+\)?$/)?.[1]);
  const testLine = readText(definition.testFile).split("\n")[line - 1];
  assert(testLine?.includes("expect("), "NEGATIVE_NOT_ORIGINAL_EXPECT");
  return {
    file: target.file,
    fullName: target.fullName,
    line,
    assertionSource: testLine.trim(),
    signal: definition.failure,
  };
}

export const browserCaseIds = [
  "login-navigation",
  "settings-edit-conflict",
  "dashboard-states",
  "settings-states",
  "mobile-keyboard",
  "authorization-sessions",
  "logout",
];
export function requireBrowser(report) {
  assert.equal(report.phase, 14);
  assert.equal(report.status, "PASS");
  assert.equal(report.simulation, true);
  assert.equal(report.productionTraffic, false);
  assert.equal(report.notGate, false);
  assert.deepEqual(
    report.results.map((row) => row.id),
    browserCaseIds,
  );
  assert(report.results.every((row) => row.status === "PASS"));
  assert.equal(report.externalRequestCount, 0);
  assert(report.localRequestCount > 0);
  assert.equal(report.privacyFailures, 0);
  assert.equal(report.secretScans.hits, 0);
  assert.equal(report.browserVersion, "140.0.7339.186");
  assert(report.artifacts.some((item) => item.path.endsWith(".png")));
  assert(report.artifacts.some((item) => item.path.endsWith(".html")));
  assert(report.artifacts.some((item) => item.path.endsWith("-axe.json")));
  assert(
    report.commands.some(
      (item) => item.ready && item.stoppedByFixture && item.nodeNetworkGuard.publicRequests === 0,
    ),
  );
  return {
    caseCount: report.results.length,
    browserVersion: report.browserVersion,
    externalRequestCount: 0,
    privacyFailures: 0,
  };
}
export function requireBusiness(rows) {
  const expected = {
    "group-writes": { writes: 5, audits: 5, receipts: 5 },
    "cas-idempotency": {
      statuses: [200, 409],
      winnerRevision: 1,
      sameTimestamp: true,
      auditsAfterReplayAndNextWrite: 2,
    },
    "rollback-AuditLog": { unchanged: true, audits: 0, receipts: 0 },
    "rollback-AdminCommandReceipt": { unchanged: true, audits: 0, receipts: 0 },
    "public-projection": {
      projectedItems: 1,
      privateFieldsVisible: false,
      emptyItems: 0,
      conditionalStatus: 304,
    },
    "dashboard-partial": { failedWidgets: 1, successfulWidgets: 3, failedWidgetHasData: false },
    readiness: { missingMigrationChecks: 8, missingTableChecks: 10, checksumDriftChecks: 1 },
    "database-recovery": { recoveredStatus: 200 },
    authorization: { unchanged: true, unauthorizedAudits: 0, unauthorizedReceipts: 0 },
  };
  assert.equal(rows.length, Object.keys(expected).length, "BUSINESS_OBSERVATION_COUNT");
  assert.deepEqual(rows.map((row) => row.kind).sort(), Object.keys(expected).sort());
  for (const row of rows)
    assert.deepEqual(row.counts, expected[row.kind], `BUSINESS_OBSERVATION:${row.kind}`);
  return rows;
}
