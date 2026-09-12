import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  requirePhase013Preflight,
  requirePhase013Inputs,
  requirePhase013Generation,
  requirePhase013FailureChain,
  createPhase013RetryPlan,
  requirePhase013ImplementationBinding,
  requirePhase013Vitest,
  requirePhase013CaseMapping,
  requirePhase013Discovery,
  phase013BusinessObservations,
  phase013FixtureBinding,
  requirePhase013BrowserReport,
  requirePhase013ScopeRepair,
  phase013NegativeControlDefinitions,
  phase013NegativeControlContract,
  requirePhase013NegativeControl,
} from "../../docs/phase-plans/phase013-evidence.mjs";
import { requireReportBinding, requirePriorCaseBinding } from "../../scripts/phase-evidence.mjs";
import {
  root,
  plan,
  planPath,
  receiptPath,
  generationPath,
  migrationPath,
  hash,
  read,
  json,
  git,
  command,
  scanSensitiveText,
  safeDiagnostics,
  dbConfig,
} from "../../docs/phase-plans/phase013-runtime.mjs";

const receipt = json(receiptPath);
const generation = json(generationPath);
const inputDependencies = { hashFile: hash, readJson: json, readBytes: read, git };
const generationDependencies = {
  receipt,
  hashFile: hash,
  readText: (file) => read(file).toString(),
  migrationPath,
};
const results = [];
function check(name, operation) {
  operation();
  results.push({ name, status: "PASS" });
}
function rejects(name, value, mutate, verify) {
  check(name, () => {
    const changed = structuredClone(value);
    mutate(changed);
    assert.throws(() => verify(changed));
  });
}

check("actual admission binds both shells, original metadata and synchronized maintenance", () =>
  requirePhase013Preflight(receipt.preflight),
);
for (const [name, mutate] of [
  ["missing-shell", (value) => value.shells.pop()],
  [
    "duplicate-shell",
    (value) => {
      value.shells[1] = value.shells[0];
    },
  ],
  [
    "failed-shell",
    (value) => {
      value.shells[0].exitCode = 1;
    },
  ],
  [
    "dirty-admission",
    (value) => {
      value.workingTree = " M source";
    },
  ],
  [
    "wrong-phase",
    (value) => {
      value.phase = 12;
    },
  ],
  [
    "wrong-original-metadata",
    (value) => {
      value.shells[0].result.metadataCommit = value.head;
    },
  ],
  [
    "wrong-maintenance-head",
    (value) => {
      value.shells[0].result.maintenanceHead = "0".repeat(40);
    },
  ],
  [
    "unsynchronized-remote",
    (value) => {
      value.remoteHead = "0".repeat(40);
    },
  ],
])
  rejects("reject admission " + name, receipt.preflight, mutate, requirePhase013Preflight);
check("actual input receipt binds immutable maintenance and policy bytes", () =>
  requirePhase013Inputs(receipt, inputDependencies),
);
for (const [name, mutate] of [
  [
    "missing-maintenance",
    (value) => {
      delete value.checkpointMaintenance;
    },
  ],
  [
    "wrong-maintenance-commit",
    (value) => {
      value.checkpointMaintenance.commit = value.prerequisites.metadataCommit;
    },
  ],
  [
    "wrong-policy-hash",
    (value) => {
      value.validationPolicy.sha256 = "0".repeat(64);
    },
  ],
  [
    "wrong-policy-version",
    (value) => {
      value.validationPolicy.version = "unknown";
    },
  ],
  [
    "old-phase-start",
    (value) => {
      value.phaseStartCommit = value.prerequisites.metadataCommit;
    },
  ],
  [
    "changed-frozen-input",
    (value) => {
      value.pinnedInputs[0].sha256 = "0".repeat(64);
    },
  ],
  [
    "preflight-report-hash",
    (value) => {
      value.preflight.reportHash = "0".repeat(64);
    },
  ],
])
  rejects("reject input " + name, receipt, mutate, (value) =>
    requirePhase013Inputs(value, inputDependencies),
  );
check(
  "actual custom migration binds previous seven migrations, reviewed repair and failed SQL history",
  () => requirePhase013Generation(generation, generationDependencies),
);
for (const [name, mutate] of [
  [
    "changed-migration",
    (value) => {
      value.migrationHash = "0".repeat(64);
    },
  ],
  [
    "changed-protection",
    (value) => {
      value.protectionHash = "0".repeat(64);
    },
  ],
  [
    "omitted-baseline",
    (value) => {
      value.previousMigrations.pop();
    },
  ],
  [
    "false-table-creation",
    (value) => {
      value.newTables = 1;
    },
  ],
  [
    "false-generation-mode",
    (value) => {
      value.mode = "PRISMA_GENERATED";
    },
  ],
  [
    "missing-actual-commands",
    (value) => {
      value.records = [];
    },
  ],
  [
    "failed-actual-command",
    (value) => {
      value.records[0].exitCode = 1;
    },
  ],
])
  rejects("reject migration " + name, generation, mutate, (value) =>
    requirePhase013Generation(value, generationDependencies),
  );
check("actual failure history remains complete and immutable", () =>
  requirePhase013FailureChain(plan, { readJson: json, hashFile: hash, git }),
);
const repairedPrevious = plan.previousAttempts.find((entry) => entry.scopeRepairPath);
if (repairedPrevious) {
  const repair = json(repairedPrevious.scopeRepairPath);
  check(
    "append-only scope repair binds actual failures duplicates and all original evidence bytes",
    () => {
      requirePhase013ScopeRepair(repair, repairedPrevious, { readJson: json, hashFile: hash });
    },
  );
  check(
    "scope repair rejects forged failed identities changed historical bytes and unrelated scope widening",
    () => {
      for (const mutate of [
        (value) => {
          value.failureHash = "0".repeat(64);
        },
        (value) => {
          value.sourceReportHash = "0".repeat(64);
        },
        (value) => {
          value.failedAssertions.pop();
        },
        (value) => {
          value.duplicateAssertionIdentities = [];
        },
        (value) => {
          value.scopeAdditions.push("tests/lib/json.test.ts");
        },
        (value) => {
          delete value.preservedEvidenceHashes[value.failurePath];
        },
        (value) => {
          value.originalTestSources[0].sha256 = "0".repeat(64);
        },
      ]) {
        const changed = structuredClone(repair);
        mutate(changed);
        assert.throws(() =>
          requirePhase013ScopeRepair(changed, repairedPrevious, { readJson: json, hashFile: hash }),
        );
      }
      const changed = structuredClone(plan);
      changed.previousAttempts.find((entry) => entry.scopeRepairPath).scopeRepairHash = "0".repeat(
        64,
      );
      assert.throws(() =>
        requirePhase013FailureChain(changed, { readJson: json, hashFile: hash, git }),
      );
    },
  );
}
if (plan.previousAttempts.length > 0) {
  rejects(
    "reject missing prior attempt",
    plan,
    (value) => {
      value.previousAttempts.pop();
    },
    (value) => requirePhase013FailureChain(value, { readJson: json, hashFile: hash, git }),
  );
  rejects(
    "reject changed prior hash",
    plan,
    (value) => {
      value.previousAttempts[0].planHash = "0".repeat(64);
    },
    (value) => requirePhase013FailureChain(value, { readJson: json, hashFile: hash, git }),
  );
}
check("previous required cases cannot be removed or reduced", () => {
  const prior = structuredClone(plan);
  const changed = structuredClone(plan);
  changed.cases.pop();
  assert.throws(() => requirePriorCaseBinding(changed, prior));
  changed.cases = structuredClone(prior.cases);
  changed.cases[0].denominator = 0;
  assert.throws(() => requirePriorCaseBinding(changed, prior));
});
check("implementation snapshot rejects edit deletion and newly added sources", () => {
  const expected = { "source.ts": "a".repeat(64), "deleted.ts": null };
  requirePhase013ImplementationBinding(expected, structuredClone(expected));
  for (const changed of [
    { ...expected, "source.ts": "b".repeat(64) },
    { "deleted.ts": null },
    { ...expected, "new.ts": "c".repeat(64) },
  ])
    assert.throws(() => requirePhase013ImplementationBinding(expected, changed));
});

const syntheticAssertions = [];
for (const item of plan.cases)
  syntheticAssertions.push({
    file: item.assertionSelector.file,
    fullName: "fixture " + item.assertionSelector.tag + " original assertion",
    discoveryName: "fixture > " + item.assertionSelector.tag + " original assertion",
    status: "passed",
    failureMessages: [],
  });
for (const file of [
  "tests/lib/secret-envelope.test.ts",
  "tests/integration/secret-envelope.test.ts",
  "tests/admin/api-keys-client.test.tsx",
  "tests/admin/logs-client.test.tsx",
])
  syntheticAssertions.push({
    file,
    fullName: "fixture original assertion",
    discoveryName: "fixture > original assertion",
    status: "passed",
    failureMessages: [],
  });
for (const tag of ["authorization", "crypto-redaction", "failure-atomicity"])
  syntheticAssertions.push({
    file: "tests/admin/logs.test.ts",
    fullName: "fixture [" + tag + "] original assertion",
    discoveryName: "fixture > [" + tag + "] original assertion",
    status: "passed",
    failureMessages: [],
  });
check("same-execution mapping requires exact business file tags and all supplemental files", () => {
  const mapping = requirePhase013CaseMapping(plan, syntheticAssertions);
  assert.deepEqual(Object.keys(mapping), plan.requiredCaseIds);
});
for (const item of plan.cases)
  check("reject omitted business group " + item.testCaseId, () => {
    const missing = syntheticAssertions.filter(
      (entry) =>
        !(
          entry.file === item.assertionSelector.file &&
          entry.fullName.includes(item.assertionSelector.tag)
        ),
    );
    assert.throws(() => requirePhase013CaseMapping(plan, missing));
  });
check("reject failed mapped assertion and missing supplemental browser component", () => {
  const failed = structuredClone(syntheticAssertions);
  failed[0].status = "failed";
  assert.throws(() => requirePhase013CaseMapping(plan, failed));
  assert.throws(() =>
    requirePhase013CaseMapping(
      plan,
      syntheticAssertions.filter((entry) => entry.file !== "tests/admin/api-keys-client.test.tsx"),
    ),
  );
});
const discovery = syntheticAssertions.map((entry) => ({
  file: path.join(root, entry.file),
  name: entry.discoveryName,
}));
check(
  "full discovery binds every exact assertion and rejects omitted renamed or extra tests",
  () => {
    requirePhase013Discovery(discovery, syntheticAssertions, root);
    assert.throws(() => requirePhase013Discovery(discovery.slice(1), syntheticAssertions, root));
    const renamed = structuredClone(discovery);
    renamed[0].file = path.join(root, "tests/renamed.test.ts");
    assert.throws(() => requirePhase013Discovery(renamed, syntheticAssertions, root));
    assert.throws(() =>
      requirePhase013Discovery([...discovery, discovery[0]], syntheticAssertions, root),
    );
  },
);
const raw = {
  success: true,
  numTotalTests: 1,
  numFailedTests: 0,
  numPassedTests: 1,
  numPendingTests: 0,
  numTodoTests: 0,
  numRuntimeErrorTestSuites: 0,
  testResults: [
    {
      name: path.join(root, "tests/example.test.ts"),
      assertionResults: [
        {
          title: "assertion",
          ancestorTitles: ["fixture"],
          fullName: "fixture assertion",
          status: "passed",
          failureMessages: [],
        },
      ],
    },
  ],
};
check(
  "raw Vitest requires actual assertions and rejects empty skip runtime/import error and false green",
  () => {
    requirePhase013Vitest(raw, { base: root });
    for (const mutate of [
      (value) => {
        value.testResults = [];
      },
      (value) => {
        value.numPendingTests = 1;
      },
      (value) => {
        value.numRuntimeErrorTestSuites = 1;
      },
      (value) => {
        value.numPassedTests = 0;
      },
      (value) => {
        value.testResults[0].assertionResults[0].status = "failed";
      },
    ]) {
      const changed = structuredClone(raw);
      mutate(changed);
      assert.throws(() => requirePhase013Vitest(changed, { base: root }));
    }
    assert.throws(() => requirePhase013Vitest(raw, { base: root, expectedFailure: true }));
  },
);

// These constructed reports test the evidence parser only. Product acceptance
// always obtains a new baseline and mutation process for the current attempt.
function recountVitest(report) {
  const entries = report.testResults.flatMap((suite) => suite.assertionResults);
  report.numTotalTests = entries.length;
  report.numPassedTests = entries.filter((entry) => entry.status === "passed").length;
  report.numFailedTests = entries.filter((entry) => entry.status === "failed").length;
  report.numPendingTests = entries.filter((entry) =>
    ["skipped", "pending"].includes(entry.status),
  ).length;
  report.numTodoTests = entries.filter((entry) => entry.status === "todo").length;
  report.success = report.numFailedTests === 0;
  return report;
}

function syntheticNegativeControl(definition) {
  const expectedContract = phase013NegativeControlContract(definition.id, read);
  const negativeRoot = path.join(root, ".scaffold/phase013/fixtures/helper-" + definition.id);
  const baselineRaw = structuredClone(raw);
  baselineRaw.testResults = definition.files.map((file) => ({
    name: path.join(root, file),
    assertionResults: expectedContract.requiredFailures
      .filter((required) => required.file === file)
      .map((required) => ({
        title: required.fullName,
        ancestorTitles: [],
        fullName: required.fullName,
        status: "passed",
        failureMessages: [],
      })),
  }));
  baselineRaw.testResults[0].assertionResults.push({
    title: "isolated helper supplemental assertion",
    ancestorTitles: [],
    fullName: "isolated helper supplemental assertion",
    status: "passed",
    failureMessages: [],
  });
  recountVitest(baselineRaw);
  const negativeRaw = structuredClone(baselineRaw);
  for (const [index, suite] of negativeRaw.testResults.entries()) {
    suite.name = path.join(negativeRoot, definition.files[index]);
    for (const entry of suite.assertionResults) {
      const required = expectedContract.requiredFailures.find(
        (candidate) => candidate.fullName === entry.fullName,
      );
      if (!required) continue;
      entry.status = "failed";
      const target = path.join(negativeRoot, required.file).replaceAll("\\", "/");
      const dependency = pathToFileURL(
        path.join(root, "node_modules/@vitest/expect/dist/index.js"),
      ).href;
      entry.failureMessages = [
        required.failureHeader +
          `\n    at Proxy.<anonymous> (${dependency}:100:12)` +
          `\n    at ${target}:${required.location.line}:${required.location.column}` +
          `\n    at runWithTimeout (${dependency}:200:20)`,
      ];
    }
  }
  recountVitest(negativeRaw);
  return {
    baselineRaw,
    baselineRecord: {
      command: "isolated helper synthetic baseline",
      cwd: root,
      exitCode: 0,
      timedOut: false,
      signal: null,
    },
    negativeRaw,
    negativeRecord: {
      command: "isolated helper synthetic mutation",
      cwd: negativeRoot,
      exitCode: 1,
      timedOut: false,
      signal: null,
    },
    expectedContract,
  };
}

for (const definition of phase013NegativeControlDefinitions()) {
  const fixture = syntheticNegativeControl(definition);
  const required = fixture.expectedContract.requiredFailures[0];
  const primary = (value, field = "negativeRaw") =>
    value[field].testResults
      .flatMap((suite) => suite.assertionResults)
      .find((entry) => entry.fullName === required.fullName);
  const verify = (value, readBytes = read) =>
    requirePhase013NegativeControl(definition.id, { ...value, readBytes });
  const targetFrame = (value) =>
    path.join(value.negativeRecord.cwd, required.file).replaceAll("\\", "/") +
    `:${required.location.line}:${required.location.column}`;
  check("exact negative security assertion is required for " + definition.id, () => {
    const actual = verify(fixture);
    assert.equal(actual.observedFailures.length, fixture.expectedContract.requiredFailures.length);
    assert.deepEqual(actual.contract, fixture.expectedContract);
  });
  for (const header of [
    "PrismaClientInitializationError: P1001: Cannot reach database server",
    "Error: connect ECONNREFUSED 127.0.0.1:5432",
    "Error: Test timed out in 5000ms.",
    "Error: Hook timed out in 10000ms.",
    "Error: beforeAll hook timed out in 10000ms.",
    "Error: afterEach hook timed out in 10000ms.",
    "AssertionError: expected 503 to be 201 // Object.is equality",
  ])
    rejects(
      `${definition.id} rejects same file/fullName with ${header}`,
      fixture,
      (value) => {
        primary(value).failureMessages = [header + "\n    at " + targetFrame(value)];
      },
      verify,
    );
  for (const [name, mutate] of [
    [
      "wrong matcher line",
      (value) => {
        primary(value).failureMessages[0] = primary(value).failureMessages[0].replace(
          targetFrame(value),
          targetFrame(value).replace(
            `:${required.location.line}:`,
            `:${required.location.line - 1}:`,
          ),
        );
      },
    ],
    [
      "wrong matcher column",
      (value) => {
        primary(value).failureMessages[0] = primary(value).failureMessages[0].replace(
          targetFrame(value),
          targetFrame(value).replace(/:[0-9]+$/, ":" + (required.location.column + 1)),
        );
      },
    ],
    [
      "target frame exists only after an earlier project assertion",
      (value) => {
        primary(value).failureMessages = [
          required.failureHeader +
            "\n    at helper (" +
            path
              .join(value.negativeRecord.cwd, "tests/phase013/api-key-fixture.ts")
              .replaceAll("\\", "/") +
            ":1:1)\n    at " +
            targetFrame(value),
        ];
      },
    ],
    [
      "same relative path in a different mutation root",
      (value) => {
        primary(value).failureMessages[0] = primary(value).failureMessages[0].replace(
          value.negativeRecord.cwd.replaceAll("\\", "/") + "/",
          value.negativeRecord.cwd.replaceAll("\\", "/") + "-other/",
        );
      },
    ],
    [
      "missing stack",
      (value) => {
        primary(value).failureMessages = [required.failureHeader];
      },
    ],
    [
      "ambiguous multiple failure messages",
      (value) => {
        primary(value).failureMessages.push(primary(value).failureMessages[0]);
      },
    ],
    [
      "missing original assertion",
      (value) => {
        for (const suite of value.negativeRaw.testResults)
          suite.assertionResults = suite.assertionResults.filter(
            (entry) => entry.fullName !== required.fullName,
          );
        recountVitest(value.negativeRaw);
      },
    ],
    [
      "only an upstream or unrelated assertion failed",
      (value) => {
        for (const suite of value.negativeRaw.testResults)
          for (const entry of suite.assertionResults) {
            entry.status =
              entry.fullName === "isolated helper supplemental assertion" ? "failed" : "passed";
            entry.failureMessages =
              entry.status === "failed" ? ["AuthAuthorizationError: AUTH_FORBIDDEN"] : [];
          }
        recountVitest(value.negativeRaw);
      },
    ],
    [
      "baseline original assertion was skipped",
      (value) => {
        primary(value, "baselineRaw").status = "skipped";
        recountVitest(value.baselineRaw);
      },
    ],
    [
      "same renamed assertion in both executions",
      (value) => {
        for (const field of ["baselineRaw", "negativeRaw"])
          primary(value, field).fullName += " renamed";
      },
    ],
    [
      "duplicate original assertion",
      (value) => {
        const suite = value.negativeRaw.testResults.find((entry) =>
          entry.assertionResults.includes(primary(value)),
        );
        suite.assertionResults.push(structuredClone(primary(value)));
        recountVitest(value.negativeRaw);
      },
    ],
    [
      "inconsistent failed count",
      (value) => {
        value.negativeRaw.numFailedTests++;
      },
    ],
    [
      "inconsistent total count",
      (value) => {
        value.negativeRaw.numTotalTests++;
      },
    ],
    [
      "primary safety failure accompanied by database infrastructure failure",
      (value) => {
        const extra = value.negativeRaw.testResults
          .flatMap((suite) => suite.assertionResults)
          .find((entry) => entry.fullName === "isolated helper supplemental assertion");
        extra.status = "failed";
        extra.failureMessages = ["Error: P1001: Cannot reach database server"];
        recountVitest(value.negativeRaw);
      },
    ],
    [
      "timeout process flag",
      (value) => {
        value.negativeRecord.timedOut = true;
      },
    ],
    [
      "terminated process",
      (value) => {
        value.negativeRecord.signal = "SIGTERM";
      },
    ],
    [
      "successful mutation process",
      (value) => {
        value.negativeRecord.exitCode = 0;
      },
    ],
    [
      "stale or forged assertion source hash",
      (value) => {
        value.expectedContract.testSourceHashes[required.file] = "0".repeat(64);
      },
    ],
    [
      "forged matcher position",
      (value) => {
        value.expectedContract.requiredFailures[0].location.line++;
      },
    ],
  ])
    rejects(`${definition.id} rejects ${name}`, fixture, mutate, verify);
  check(`${definition.id} accepts exact Windows and encoded file URL frames`, () => {
    for (const replacement of [
      targetFrame(fixture).replaceAll("/", "\\"),
      "fn (" +
        pathToFileURL(path.join(fixture.negativeRecord.cwd, required.file)).href +
        `:${required.location.line}:${required.location.column})`,
    ]) {
      const value = structuredClone(fixture);
      primary(value).failureMessages[0] = primary(value).failureMessages[0].replace(
        targetFrame(value),
        replacement,
      );
      verify(value);
    }
  });
  check(
    `${definition.id} rejects changed or nonunique source anchors without editing tests`,
    () => {
      for (const replace of [
        (source) => source.replace(required.anchor, "/* isolated missing assertion fixture */"),
        (source) => source + "\n" + required.anchor,
        (source) => "// isolated changed-source fixture\n" + source,
      ])
        assert.throws(() =>
          verify(fixture, (file) =>
            file === required.file ? Buffer.from(replace(read(file).toString())) : read(file),
          ),
        );
    },
  );
}
check("results must bind exact plan command denominator hash and source inventory", () => {
  const item = plan.cases[0];
  const fixtureHash = "a".repeat(64);
  const report = {
    testCaseId: item.testCaseId,
    command: item.command,
    status: "PASS",
    exitCode: 0,
    numerator: 1,
    denominator: 1,
    inputPath: item.inputPath,
    inputHash: fixtureHash,
    planHash: fixtureHash,
    sourceHashes: { "fixture.ts": fixtureHash },
  };
  requireReportBinding(report, item, fixtureHash, ["fixture.ts"], () => fixtureHash);
  for (const field of [
    "planHash",
    "command",
    "inputHash",
    "denominator",
    "numerator",
    "exitCode",
  ]) {
    const changed = structuredClone(report);
    changed[field] = typeof changed[field] === "number" ? 999 : "tampered";
    assert.throws(() =>
      requireReportBinding(changed, item, fixtureHash, ["fixture.ts"], () => fixtureHash),
    );
  }
});
check("raw secret scan rejects the real generated master key before archival", () => {
  const value = dbConfig().encryptionKey;
  assert.throws(() => scanSensitiveText(value));
  assert(!safeDiagnostics(value).includes(value));
});
const observedRows = [
  { group: "create-read", createdRows: 1, secretHits: 0 },
  { group: "disable-enable", legalStateChanges: 3, matchingStateAudits: 3, revokedRestorations: 0 },
  {
    group: "rotate-revoke",
    referenceCount: 2,
    switchedReferences: 2,
    matchingStateAudits: 2,
    oldRevoked: true,
    newActive: true,
    partialSwitches: 0,
  },
  {
    group: "rotate-revoke",
    contenders: 2,
    winners: 1,
    disabledLoserCandidates: 1,
    orphanActiveKeys: 0,
  },
  {
    group: "authorization",
    rejectedPrincipals: 4,
    csrfFailures: 2,
    unauthorizedBusinessReads: 0,
    unauthorizedBusinessWrites: 0,
  },
  {
    group: "crypto-redaction",
    dtoRejectedSecretFields: 5,
    dbSafeProjection: true,
    httpBodyHits: 0,
    auditHits: 0,
    fullFingerprintHits: 0,
  },
  {
    group: "failure-atomicity",
    partialSwitches: 0,
    encryptedRowsChanged: 0,
    statusRowsChanged: 0,
    receiptsChanged: 0,
  },
].map((row) => ({ phase: 13, database: "REAL_POSTGRESQL17", ...row }));
function observedRecord(rows) {
  return {
    exitCode: 0,
    timedOut: false,
    stdout: "Synthetic helper fixture only\n" + rows.map((row) => JSON.stringify(row)).join("\n"),
    stderr: "",
  };
}
check(
  "business metrics are parsed from the actual command stream across both output channels",
  () => {
    assert.deepEqual(phase013BusinessObservations(observedRecord(observedRows)), observedRows);
    const record = observedRecord(observedRows);
    record.stderr = "\u001b[33m" + record.stdout + "\u001b[0m";
    record.stdout = "";
    assert.deepEqual(phase013BusinessObservations(record), observedRows);
  },
);
check(
  "business metrics reject absent groups false green state-audit mismatch partial switches and unauthorized access",
  () => {
    for (const mutate of [
      (rows) => {
        rows.pop();
      },
      (rows) => {
        rows[1].matchingStateAudits = 2;
      },
      (rows) => {
        rows[2].oldRevoked = false;
      },
      (rows) => {
        rows[3].winners = 2;
      },
      (rows) => {
        rows[4].unauthorizedBusinessReads = 1;
      },
      (rows) => {
        rows[5].dbSafeProjection = false;
      },
      (rows) => {
        rows[6].partialSwitches = 1;
      },
    ]) {
      const changed = structuredClone(observedRows);
      mutate(changed);
      assert.throws(() => phase013BusinessObservations(observedRecord(changed)));
    }
    assert.throws(() =>
      phase013BusinessObservations({ ...observedRecord(observedRows), exitCode: 1 }),
    );
    assert.throws(() =>
      phase013BusinessObservations({ ...observedRecord(observedRows), timedOut: true }),
    );
  },
);
check(
  "fixture hash covers the real registered synthetic fixtures and rejects missing current-card inputs",
  () => {
    const actual = phase013FixtureBinding(plan, hash);
    assert(Object.keys(actual.fixtureHashes).length >= 4);
    const changed = structuredClone(plan);
    changed.sourcePaths = changed.sourcePaths.filter(
      (file) => file !== "tests/phase013/api-key-fixture.ts",
    );
    assert.throws(() => phase013FixtureBinding(changed, hash));
  },
);
const browserFixture = {
  phase: 13,
  status: "PASS",
  simulation: true,
  productionTraffic: false,
  notGate: false,
  verificationScope: "AUTOMATED_BROWSER_A11Y",
  humanScreenReaderExperience: "NOT_EVALUATED",
  results: [
    "unauthorized-reads-and-login",
    "create-read",
    "disable-enable",
    "rotate-revoke",
    "audit-filters-pagination",
    "responsive-keyboard",
    "failed-read-retry",
    "logout-and-safe-pages",
  ].map((id) => ({ id, status: "PASS" })),
  caseCount: 8,
  externalRequestCount: 0,
  localRequestCount: 1,
  privacyFailures: 0,
  browserVersion: "149.0.0.0",
  serverOrigin: "http://127.0.0.1:10001",
  secretScans: {
    httpBodies: 1,
    html: 1,
    browserStorage: 1,
    logs: 1,
    audit: 1,
    dbSafeProjection: 1,
    trace: 1,
    evidence: 1,
    hits: 0,
  },
  responseEvidence: [{ sha256: "a".repeat(64) }],
  artifacts: [{ path: "isolated-helper-fixture.png", sha256: "a".repeat(64) }],
};
check(
  "browser evidence requires eight cases real scans privacy counters network isolation and observed response hashes",
  () => {
    requirePhase013BrowserReport(browserFixture);
    for (const mutate of [
      (value) => {
        value.results.pop();
      },
      (value) => {
        value.notGate = true;
      },
      (value) => {
        value.externalRequestCount = 1;
      },
      (value) => {
        value.privacyFailures = 1;
      },
      (value) => {
        value.localRequestCount = 0;
      },
      (value) => {
        value.secretScans.trace = 0;
      },
      (value) => {
        delete value.secretScans.audit;
      },
      (value) => {
        value.secretScans.hits = 1;
      },
      (value) => {
        value.responseEvidence = [];
      },
    ]) {
      const changed = structuredClone(browserFixture);
      mutate(changed);
      assert.throws(() => requirePhase013BrowserReport(changed));
    }
  },
);
check("retry requires the frozen plan and cannot fabricate a missing failure", () => {
  assert.throws(() =>
    createPhase013RetryPlan(plan, {
      readJson: (file) => {
        if (file.endsWith("/attempt.json")) throw new Error("missing actual failure");
        return json(file);
      },
      hashFile: hash,
      git,
    }),
  );
});
const failed = await command(
  "Phase013 evidence helper real nonzero subprocess",
  ["-e", "process.exit(7)"],
  { expected: null },
);
assert.equal(failed.exitCode, 7);
results.push({
  name: "negative wrapper preserves an actual nonzero subprocess result",
  status: "PASS",
  underlyingExitCode: failed.exitCode,
});
const output = process.argv[process.argv.indexOf("--output") + 1];
assert(output && process.argv.includes("--output"));
const absolute = path.resolve(output);
assert(absolute.startsWith(path.resolve(root, ".scaffold/phase013") + path.sep));
const sources = [
  "docs/phase-plans/phase013-evidence.mjs",
  "docs/phase-plans/phase013-runtime.mjs",
  "scripts/phase-evidence.mjs",
  "tests/phase013/evidence-guards.mjs",
];
const report = {
  phase: 13,
  status: "PASS",
  scope: "ISOLATED_EVIDENCE_HELPER_SELF_TEST_NOT_PRODUCT_ACCEPTANCE",
  planHash: hash(planPath),
  caseCount: results.length,
  results,
  testedSourceHashes: Object.fromEntries(sources.map((file) => [file, hash(file)])),
  simulation: true,
  productionTraffic: false,
  generatedAt: new Date().toISOString(),
};
scanSensitiveText(JSON.stringify(report));
fs.mkdirSync(path.dirname(absolute), { recursive: true });
fs.writeFileSync(absolute, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.warn(JSON.stringify({ status: "PASS", phase: 13, caseCount: results.length }));
