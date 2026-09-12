import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  requirePhase013Preflight,
  requirePhase013Inputs,
  requirePhase013Generation,
  requirePhase013FailureChain,
  requirePhase013FailureEvidence,
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
  sha,
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
const historyRecords = plan.previousAttempts.map((previous) => ({
  previous,
  failure: json(previous.failurePath),
  frozenPlan: json(previous.planPath),
}));
const historicalError = /PHASE013_EVIDENCE: HISTORICAL_EVIDENCE/;
function historyReaders(files = new Map(), accessed = new Set()) {
  const bytes = (file) => {
    accessed.add(file);
    if (!files.has(file)) return read(file);
    const value = files.get(file);
    if (value === null) throw new Error("isolated missing historical file");
    return value;
  };
  return {
    readJson: (file) => JSON.parse(bytes(file)),
    hashFile: (file) => sha(bytes(file)),
    git: () => assert.fail("Git is prohibited in historical evidence overlays"),
  };
}
function historyFailureFixture(record) {
  const index = plan.previousAttempts.findIndex(
    (entry) => entry.attemptId === record.previous.attemptId,
  );
  const changedPlan = {
    ...structuredClone(plan),
    attemptId: `attempt-${index + 2}`,
    previousAttempts: structuredClone(plan.previousAttempts.slice(0, index + 1)),
  };
  const previous = changedPlan.previousAttempts.at(-1);
  const failure = structuredClone(record.failure);
  const files = new Map(),
    accessed = new Set();
  const readers = historyReaders(files, accessed);
  return {
    plan: changedPlan,
    previous,
    failure,
    files,
    accessed,
    readers,
    bind() {
      files.set(previous.failurePath, Buffer.from(JSON.stringify(failure)));
      previous.failureHash = readers.hashFile(previous.failurePath);
    },
  };
}
function rejectHistoricalFixture(fixture) {
  fixture.bind();
  assert.throws(() => requirePhase013FailureChain(fixture.plan, fixture.readers), historicalError);
  assert(fixture.accessed.has(fixture.previous.failurePath));
}
check("all actual historical receipt kinds pass without accessing Git", () => {
  requirePhase013FailureChain(plan, historyReaders());
  assert(historyRecords.some(({ failure }) => failure.kind === "SOURCE_REPAIR"));
  assert(historyRecords.some(({ failure }) => failure.kind === "INDEPENDENT_REVIEW_FINDINGS"));
  assert(historyRecords.some(({ failure }) => failure.kind === "EVIDENCE_GUARD_REPAIR"));
  assert(historyRecords.some(({ failure }) => failure.artifacts?.length === 0));
});
const historicalTargets = new Map();
for (const { failure } of historyRecords) {
  for (const field of [
    "diagnostic",
    "commandReceipt",
    "review",
    "reviewerRun",
    "failedMigration",
    "failedProtection",
    "originalReceipt",
  ])
    if (failure[field + "Path"])
      historicalTargets.set(failure[field + "Path"], failure[field + "Hash"]);
  for (const [file, expected] of Object.entries(failure.originalEvidenceHashes ?? {}))
    if (file.endsWith("/all-tests-vitest.json")) historicalTargets.set(file, expected);
  for (const entry of failure.archivedFiles ?? [])
    if (entry.sourcePath === "docs/phase-plans/phase013-evidence.mjs")
      historicalTargets.set(entry.path, entry.sha256);
}
for (const [file, expected] of historicalTargets) {
  for (const mutation of ["changed", "missing"]) {
    check(`reject ${mutation} historical bytes at ${file}`, () => {
      assert.equal(hash(file), expected);
      const files = new Map([
        [file, mutation === "missing" ? null : Buffer.concat([read(file), Buffer.from("\n")])],
      ]);
      const accessed = new Set();
      assert.throws(
        () => requirePhase013FailureChain(plan, historyReaders(files, accessed)),
        (error) => {
          assert.match(error.message, historicalError);
          assert(error.message.includes(file));
          return true;
        },
      );
      assert(accessed.has(file), "The inner validator must read the mutated historical target");
      assert.equal(hash(file), expected, "Real historical files remain unchanged");
    });
  }
}
const guardHistory = historyRecords.findLast(
  ({ failure }) => failure.kind === "EVIDENCE_GUARD_REPAIR",
);
assert(guardHistory, "Historical guard probes require an actual guard-repair receipt");
const guardDirectory = `docs/evidence/attempts/Phase013/${guardHistory.previous.attemptId}/`;
const historicalRaw = guardDirectory + "all-tests-vitest.json";
for (const [name, mutate] of [
  [
    "missing original map",
    (failure) => {
      delete failure.originalEvidenceHashes;
    },
  ],
  [
    "missing completed verification",
    (failure) => {
      delete failure.completedVerification;
    },
  ],
  [
    "both original containers omitted",
    (failure) => {
      delete failure.completedVerification;
      delete failure.originalEvidenceHashes;
    },
  ],
  [
    "empty original map",
    (failure) => {
      failure.originalEvidenceHashes = {};
    },
  ],
  [
    "omitted raw map entry",
    (failure) => {
      delete failure.originalEvidenceHashes[historicalRaw];
    },
  ],
  [
    "omitted frozen-plan map entry",
    (failure) => {
      delete failure.originalEvidenceHashes[guardHistory.previous.planPath];
    },
  ],
  [
    "omitted case map entry",
    (failure) => {
      delete failure.originalEvidenceHashes[guardHistory.frozenPlan.cases[0].outputPath];
    },
  ],
  [
    "omitted quality map entry",
    (failure) => {
      delete failure.originalEvidenceHashes[failure.completedVerification.qualityPath];
    },
  ],
  [
    "missing archive container",
    (failure) => {
      delete failure.archivedFiles;
    },
  ],
  [
    "empty archive container",
    (failure) => {
      failure.archivedFiles = [];
    },
  ],
  [
    "missing required diagnostic archive",
    (failure) => {
      failure.archivedFiles = failure.archivedFiles.filter(
        (entry) => entry.path !== failure.diagnosticPath,
      );
    },
  ],
  [
    "duplicate archive path",
    (failure) => {
      failure.archivedFiles.push(structuredClone(failure.archivedFiles[0]));
    },
  ],
  [
    "duplicate artifact path",
    (failure) => {
      const artifact = {
        path: historicalRaw,
        sha256: failure.originalEvidenceHashes[historicalRaw],
      };
      failure.artifacts = [artifact, structuredClone(artifact)];
    },
  ],
  [
    "conflicting cross-container hash",
    (failure) => {
      failure.artifacts = [{ path: historicalRaw, sha256: "0".repeat(64) }];
    },
  ],
  [
    "conflicting pair and map hash",
    (failure) => {
      failure.originalEvidenceHashes[failure.diagnosticPath] = "0".repeat(64);
    },
  ],
  [
    "missing archive path",
    (failure) => {
      delete failure.archivedFiles[0].path;
    },
  ],
  [
    "missing archive hash",
    (failure) => {
      delete failure.archivedFiles[0].sha256;
    },
  ],
  [
    "missing archive source identity",
    (failure) => {
      delete failure.archivedFiles[0].sourcePath;
    },
  ],
  [
    "unknown archive source identity",
    (failure) => {
      failure.archivedFiles[0].sourcePath = "unregistered-source.ts";
    },
  ],
  [
    "missing artifact commit marker",
    (failure) => {
      delete failure.artifactCommit;
    },
  ],
  [
    "wrong artifact commit marker",
    (failure) => {
      failure.artifactCommit = true;
    },
  ],
  [
    "original path case alias",
    (failure) => {
      failure.originalEvidenceHashes[historicalRaw.replace("all-tests", "ALL-TESTS")] =
        failure.originalEvidenceHashes[historicalRaw];
    },
  ],
  [
    "archive path case alias",
    (failure) => {
      const alias = structuredClone(failure.archivedFiles[0]);
      alias.path = alias.path.replace("command.json", "COMMAND.json");
      failure.archivedFiles.push(alias);
    },
  ],
]) {
  check("reject rebound historical receipt " + name, () => {
    const fixture = historyFailureFixture(guardHistory);
    mutate(fixture.failure);
    rejectHistoricalFixture(fixture);
  });
}
for (const field of [
  "originalEvidenceHashes",
  "completedVerification",
  "archivedFiles",
  "artifacts",
]) {
  for (const value of [
    null,
    false,
    7,
    "invalid",
    field === "originalEvidenceHashes" || field === "completedVerification" ? [] : {},
  ]) {
    check(`reject malformed historical ${field} container ${JSON.stringify(value)}`, () => {
      const fixture = historyFailureFixture(guardHistory);
      fixture.failure[field] = value;
      rejectHistoricalFixture(fixture);
    });
  }
}
for (const field of ["archivedFiles", "artifacts"]) {
  for (const value of [null, false, 7, "invalid", []]) {
    check(`reject malformed historical ${field} entry ${JSON.stringify(value)}`, () => {
      const fixture = historyFailureFixture(guardHistory);
      fixture.failure[field] = [value];
      rejectHistoricalFixture(fixture);
    });
  }
}
for (const value of [null, 1, {}, "invalid", "0".repeat(63)]) {
  check(`reject malformed original hash ${JSON.stringify(value)}`, () => {
    const fixture = historyFailureFixture(guardHistory);
    fixture.failure.originalEvidenceHashes[historicalRaw] = value;
    rejectHistoricalFixture(fixture);
  });
}
for (const [name, field, record] of [
  ["guard diagnostic", "diagnostic", guardHistory],
  ["guard command", "commandReceipt", guardHistory],
  [
    "review",
    "review",
    historyRecords.find(({ failure }) => failure.kind === "INDEPENDENT_REVIEW_FINDINGS"),
  ],
  [
    "reviewer run",
    "reviewerRun",
    historyRecords.find(({ failure }) => failure.kind === "INDEPENDENT_REVIEW_FINDINGS"),
  ],
  ...["diagnostic", "failedMigration", "failedProtection", "originalReceipt"].map((field) => [
    "migration " + field,
    field,
    historyRecords.find(({ failure }) => failure.kind === "SOURCE_REPAIR"),
  ]),
]) {
  assert(record);
  for (const suffixes of [["Path"], ["Hash"], ["Path", "Hash"]]) {
    check(`reject omitted historical ${name} ${suffixes.join(" and ")}`, () => {
      const fixture = historyFailureFixture(record);
      for (const suffix of suffixes) delete fixture.failure[field + suffix];
      rejectHistoricalFixture(fixture);
    });
  }
}
for (const suffixes of [["Path"], ["Hash"], ["Path", "Hash"]]) {
  check(`reject omitted historical quality ${suffixes.join(" and ")}`, () => {
    const fixture = historyFailureFixture(guardHistory);
    for (const suffix of suffixes) delete fixture.failure.completedVerification["quality" + suffix];
    rejectHistoricalFixture(fixture);
  });
}
for (const invalidPath of [
  "../outside.json",
  "/outside.json",
  "C:/outside.json",
  "C:outside.json",
  "\\\\host\\share\\outside.json",
  "//host/share/outside.json",
  "https://example.invalid/evidence.json",
  guardDirectory + "../attempt-999/outside.json",
  guardDirectory + "./alias.json",
  guardDirectory + "folder//alias.json",
  guardDirectory + "folder\\alias.json",
  guardDirectory + "trailing.json.",
  guardDirectory + "trailing.json ",
  guardDirectory + "bad:stream",
  guardDirectory + "control\u0000.json",
  guardDirectory + "decomposed-e\u0301.json",
  "docs/evidence/attempts/Phase013/attempt-999/outside.json",
  guardDirectory.replace("Phase013", "phase013") + "alias.json",
]) {
  check("reject historical path before file access " + JSON.stringify(invalidPath), () => {
    const fixture = historyFailureFixture(guardHistory);
    fixture.failure.originalEvidenceHashes[invalidPath] =
      fixture.failure.originalEvidenceHashes[historicalRaw];
    rejectHistoricalFixture(fixture);
    assert(!fixture.accessed.has(invalidPath), "An invalid reference must not reach file readers");
  });
}
check("the same historical path and hash may be bound by several containers", () => {
  const fixture = historyFailureFixture(guardHistory);
  const expected = fixture.failure.originalEvidenceHashes[historicalRaw];
  fixture.failure.artifacts = [{ path: historicalRaw, sha256: expected }];
  fixture.failure.archivedFiles.push({
    sourcePath: ".scaffold/phase013/diagnostics/original-raw.json",
    path: historicalRaw,
    sha256: expected,
  });
  fixture.bind();
  requirePhase013FailureChain(fixture.plan, fixture.readers);
});
check("historical source archives are verified independently of repaired live sources", () => {
  const archive = guardHistory.failure.archivedFiles.find(
    (entry) => entry.sourcePath === "docs/phase-plans/phase013-evidence.mjs",
  );
  assert(archive);
  assert.notEqual(hash(archive.sourcePath), archive.sha256);
  const accessed = new Set();
  const files = new Map([
    [archive.sourcePath, Buffer.from("independently repaired live source\n")],
  ]);
  requirePhase013FailureChain(plan, historyReaders(files, accessed));
  assert(accessed.has(archive.path));
  assert(!accessed.has(archive.sourcePath));
  files.set(archive.sourcePath, read(archive.path));
  files.set(archive.path, Buffer.concat([read(archive.path), Buffer.from("\n")]));
  assert.throws(() => requirePhase013FailureChain(plan, historyReaders(files)), historicalError);
});
check("rehashing an archive cannot replace the source recorded by historical quality", () => {
  const fixture = historyFailureFixture(guardHistory);
  const archive = fixture.failure.archivedFiles.find(
    (entry) => entry.sourcePath === "docs/phase-plans/phase013-evidence.mjs",
  );
  fixture.files.set(archive.path, read(archive.sourcePath));
  archive.sha256 = sha(fixture.files.get(archive.path));
  fixture.bind();
  assert.throws(
    () => requirePhase013FailureChain(fixture.plan, fixture.readers),
    /HISTORICAL_EVIDENCE: archive differs from the historical source snapshot/,
  );
});
check(
  "recorded migration repair retains the old SQL rather than comparing it with current SQL",
  () => {
    const migrationHistory = historyRecords.find(
      ({ failure }) => failure.kind === "SOURCE_REPAIR" && failure.artifactCommit === null,
    );
    assert(migrationHistory);
    const { failure, previous, frozenPlan } = migrationHistory;
    assert.notEqual(hash(migrationPath), failure.failedMigrationHash);
    const historicalRunner = {
      phase: 13,
      attemptId: previous.attemptId,
      artifactCommit: null,
      command: "node docs/phase-plans/verify-phase013.mjs --all",
      observations: [],
      artifacts: [
        { path: migrationPath, sha256: failure.failedMigrationHash },
        { path: failure.originalReceiptPath, sha256: failure.originalReceiptHash },
      ],
    };
    const accessed = new Set();
    const readers = historyReaders(new Map(), accessed);
    const bindings = requirePhase013FailureEvidence(historicalRunner, {
      previous,
      frozenPlan,
      currentPlan: plan,
      ...readers,
    });
    assert.equal(
      bindings.archivedReferenceHashes[failure.failedMigrationPath],
      failure.failedMigrationHash,
    );
    assert(accessed.has(failure.failedMigrationPath));
    assert(!accessed.has(migrationPath));
    const withoutAmendment = structuredClone(plan);
    delete withoutAmendment.migrationPolicy.preparedReceiptPath;
    assert.throws(
      () =>
        requirePhase013FailureEvidence(historicalRunner, {
          previous,
          frozenPlan,
          currentPlan: withoutAmendment,
          ...readers,
        }),
      /HISTORICAL_EVIDENCE: changed migration lacks/,
    );
    const artifactCommit = "a".repeat(40);
    let blobCalls = 0;
    requirePhase013FailureEvidence(
      {
        ...historicalRunner,
        artifactCommit,
        diagnosticPath: failure.diagnosticPath,
        diagnosticHash: failure.diagnosticHash,
      },
      {
        previous,
        frozenPlan,
        currentPlan: plan,
        ...readers,
        git: (args, encoding) => {
          assert.deepEqual(args, ["show", `${artifactCommit}:${migrationPath}`]);
          assert.equal(encoding, null);
          blobCalls++;
          return read(failure.failedMigrationPath);
        },
      },
    );
    assert.equal(blobCalls, 1);
  },
);
check("a post-artifact failure still requires the metadata recovery contract", () => {
  const fixture = historyFailureFixture(guardHistory);
  Object.assign(fixture.failure, {
    artifactCommit: "a".repeat(40),
    kind: "SOURCE_REPAIR",
    stage: "METADATA_GENERATION",
    metadataCommit: null,
    gateCreated: false,
    command: "node docs/phase-plans/complete-phase013.mjs --metadata",
    exitCode: 1,
  });
  delete fixture.failure.completedVerification;
  delete fixture.failure.originalEvidenceHashes;
  fixture.bind();
  assert.throws(
    () => requirePhase013FailureChain(fixture.plan, fixture.readers),
    /metadata-diagnostic\.json/,
  );
});
// No Phase013 artifact has failed yet. These mock Git objects exercise the
// existing metadata branch without creating commits or claiming real recovery.
function syntheticMetadataHistory() {
  const { previous: first, frozenPlan } = historyRecords[0];
  const previous = structuredClone(first);
  const changedPlan = {
    ...structuredClone(plan),
    attemptId: "attempt-2",
    previousAttempts: [previous],
  };
  const directory = "docs/evidence/attempts/Phase013/attempt-1/";
  const artifactCommit = "a".repeat(40),
    artifactTree = "b".repeat(40);
  const files = new Map(),
    blobs = new Map();
  const frozenBytes = read(previous.planPath);
  files.set(previous.planPath, frozenBytes);
  blobs.set(previous.planPath, frozenBytes);
  blobs.set("docs/phase-plans/Phase013.json", frozenBytes);
  blobs.set(
    "docs/phase-plans/Phase013-inputs.json",
    Buffer.from(JSON.stringify({ phaseStartCommit: receipt.phaseStartCommit })),
  );
  const originalPaths = [previous.planPath, ...frozenPlan.cases.map((item) => item.outputPath)];
  for (const file of originalPaths.slice(1)) {
    const bytes = Buffer.from(JSON.stringify({ simulation: true, fixture: file }));
    files.set(file, bytes);
    blobs.set(file, bytes);
  }
  for (const name of ["quality", "review"]) {
    const file = directory + name + ".json";
    const bytes = Buffer.from(JSON.stringify({ simulation: true, fixture: name }));
    files.set(file, bytes);
    blobs.set(file, bytes);
    originalPaths.push(file);
  }
  const sourcePath = "docs/phase-plans/phase013-evidence.mjs";
  const archivePath = directory + "artifact-phase013-evidence.mjs";
  files.set(archivePath, read(sourcePath));
  blobs.set(sourcePath, read(sourcePath));
  const failure = {
    phase: 13,
    attemptId: "attempt-1",
    status: "FAIL",
    kind: "SOURCE_REPAIR",
    stage: "METADATA_GENERATION",
    artifactCommit,
    metadataCommit: null,
    gateCreated: false,
    planHash: previous.planHash,
    command: "node docs/phase-plans/complete-phase013.mjs --metadata",
    exitCode: 1,
    diagnosticPath: directory + "metadata-diagnostic.json",
  };
  const diagnostic = {
    ...failure,
    artifactTree,
    phaseStartCommit: receipt.phaseStartCommit,
    workingTreeBefore: "",
    workingTreeAfter: "",
    observation: { command: failure.command, exitCode: 1, timedOut: false },
    qualityReportPath: directory + "quality.json",
    qualityReportHash: sha(files.get(directory + "quality.json")),
    reviewReportPath: directory + "review.json",
    reviewReportHash: sha(files.get(directory + "review.json")),
    archivedSources: [{ sourcePath, path: archivePath, sha256: sha(files.get(archivePath)) }],
  };
  const gitCalls = [];
  const readers = {
    ...historyReaders(files),
    git: (args, encoding = "utf8") => {
      gitCalls.push(args);
      if (args[0] === "show" && args[1] === "-s") return "phase(013): artifact\n";
      if (args[0] === "rev-parse") return artifactTree;
      if (args[0] === "merge-base") return "";
      if (args[0] === "ls-tree" && args[1] === "--name-only") return "";
      if (args[0] === "ls-tree" && args[1] === "-r") return originalPaths.join("\0") + "\0";
      assert.equal(args[0], "show");
      assert(args[1].startsWith(artifactCommit + ":"));
      const file = args[1].slice(artifactCommit.length + 1);
      assert(blobs.has(file), "Unknown synthetic Git blob");
      return encoding === null ? blobs.get(file) : blobs.get(file).toString();
    },
  };
  return {
    plan: changedPlan,
    previous,
    failure,
    diagnostic,
    files,
    blobs,
    readers,
    gitCalls,
    originalPaths,
    bind() {
      files.set(failure.diagnosticPath, Buffer.from(JSON.stringify(diagnostic)));
      failure.diagnosticHash = sha(files.get(failure.diagnosticPath));
      files.set(previous.failurePath, Buffer.from(JSON.stringify(failure)));
      previous.failureHash = sha(files.get(previous.failurePath));
    },
  };
}
check(
  "synthetic metadata recovery still checks the artifact tree reports archives and ancestry",
  () => {
    const fixture = syntheticMetadataHistory();
    fixture.bind();
    requirePhase013FailureChain(fixture.plan, fixture.readers);
    assert(fixture.gitCalls.some((args) => args[0] === "rev-parse"));
    assert.equal(fixture.gitCalls.filter((args) => args[0] === "merge-base").length, 2);
    assert(fixture.gitCalls.some((args) => args[0] === "ls-tree" && args[1] === "-r"));
  },
);
for (const [name, mutate] of [
  [
    "missing Git",
    (fixture) => {
      delete fixture.readers.git;
    },
  ],
  [
    "omitted artifact commit",
    (fixture) => {
      fixture.failure.artifactCommit = null;
    },
  ],
  [
    "wrong artifact tree",
    (fixture) => {
      fixture.diagnostic.artifactTree = "c".repeat(40);
    },
  ],
  [
    "dirty diagnostic",
    (fixture) => {
      fixture.diagnostic.workingTreeAfter = " M unrelated";
    },
  ],
  [
    "missing original case",
    (fixture) => {
      fixture.originalPaths.splice(1, 1);
    },
  ],
  [
    "rehash quality unlike committed blob",
    (fixture) => {
      const file = fixture.diagnostic.qualityReportPath;
      fixture.files.set(file, Buffer.concat([fixture.files.get(file), Buffer.from("\n")]));
      fixture.diagnostic.qualityReportHash = sha(fixture.files.get(file));
    },
  ],
  [
    "rehash source archive unlike committed blob",
    (fixture) => {
      const archive = fixture.diagnostic.archivedSources[0];
      fixture.files.set(
        archive.path,
        Buffer.concat([fixture.files.get(archive.path), Buffer.from("\n")]),
      );
      archive.sha256 = sha(fixture.files.get(archive.path));
    },
  ],
]) {
  check("reject synthetic metadata recovery " + name, () => {
    const fixture = syntheticMetadataHistory();
    mutate(fixture);
    fixture.bind();
    assert.throws(() => requirePhase013FailureChain(fixture.plan, fixture.readers));
  });
}
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
  const earlierProject = path
    .join(fixture.negativeRecord.cwd, "tests/phase013/api-key-fixture.ts")
    .replaceAll("\\", "/");
  for (const [name, frame] of [
    ["relative project path", "helper (tests/phase013/api-key-fixture.ts:1:1)"],
    ["Windows drive-relative project path", "helper (C:tests\\phase013\\api-key-fixture.ts:1:1)"],
    ["project frame without column", `helper (${earlierProject}:1)`],
    ["project frame with zero column", `helper (${earlierProject}:1:0)`],
    ["project frame with zero line", `helper (${earlierProject}:0:1)`],
    ["project frame with negative line", `helper (${earlierProject}:-1:1)`],
    ["project frame with fractional line", `helper (${earlierProject}:1.5:1)`],
    ["project frame with nonnumeric column", `helper (${earlierProject}:1:unknown)`],
    ["project frame with unsafe integer column", `helper (${earlierProject}:1:9007199254740992)`],
    ["target wrapper missing closing parenthesis", "helper (" + targetFrame(fixture)],
    ["target wrapper with extra closing parenthesis", "helper (" + targetFrame(fixture) + "))"],
    ["unknown anonymous wrapper", "untrusted (<anonymous>)"],
  ])
    rejects(
      `${definition.id} rejects ${name} before a later exact target`,
      fixture,
      (value) => {
        primary(value).failureMessages = [
          required.failureHeader + "\n    at " + frame + "\n    at " + targetFrame(value),
        ];
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
    `${definition.id} permits only explicit native frames before the original assertion`,
    () => {
      for (const frame of [
        "processTicksAndRejections (node:internal/process/task_queues:104:5)",
        "new Promise (<anonymous>)",
        "Array.map (<anonymous>)",
        "Array.forEach (<anonymous>)",
        "async Promise.all (index 0)",
        "async Promise.allSettled (index 0)",
        "async Promise.any (index 0)",
      ]) {
        const value = structuredClone(fixture);
        primary(value).failureMessages = [
          required.failureHeader + "\n    at " + frame + "\n    at " + targetFrame(value),
        ];
        verify(value);
      }
    },
  );
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
