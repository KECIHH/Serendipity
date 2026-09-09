import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkpointHistoryEnvironment } from "./checkpoint-history.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceEnvironment = checkpointHistoryEnvironment(sourceRoot).env;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const parseJson = (bytes) => JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
const options = { shell: "both", keep: false };
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg === "--shell") options.shell = process.argv[++index];
  else if (arg === "--keep") options.keep = true;
  else if (arg === "--case") options.case = process.argv[++index];
  else if (arg === "--output") options.output = path.resolve(process.argv[++index]);
  else throw new Error(`Unknown argument ${arg}`);
}
assert(
  ["both", "powershell", "pwsh", "node"].includes(options.shell),
  "shell must be both, powershell, pwsh, or node",
);
const shells = options.shell === "both" ? ["powershell", "pwsh"] : [options.shell];
const selectedCases = options.case ? options.case.split(",") : null;
const temporaryParent = fs.realpathSync(os.tmpdir());
const temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, "serendipity-phase-validator-"));
const observations = [];
const cases = [];
const started = performance.now();
const layout = parseJson(fs.readFileSync(path.join(sourceRoot, "docs/project-layout.json")));
const sourceReceipt = parseJson(
  fs.readFileSync(path.join(sourceRoot, "docs/phase-plans/Phase001-inputs.json")),
);
const baseline = sourceReceipt.executionBaselineCommit;
const roadmapRelative = layout.roadmapRoot;
const manifestRelative = `${roadmapRelative}/docs/roadmap-execution-manifest.json`;
const manifestBytes = fs.readFileSync(path.join(sourceRoot, manifestRelative));
const manifest = parseJson(manifestBytes);
const gatePath = "docs/evidence/Phase001-gate.json";
const runPath = "docs/roadmap-run.json";
const planPath = "docs/phase-plans/Phase001.json";
const receiptPath = "docs/phase-plans/Phase001-inputs.json";
const fixtureInput = "docs/evidence/attempts/Phase001/protocol-fixture/input.bin";
const fixtureOutput = "docs/evidence/attempts/Phase001/protocol-fixture/git-version.json";
const fixtureReview = "docs/evidence/attempts/Phase001/protocol-fixture/review.json";

function command(cwd, file, args, expectedZero = true) {
  const env = { ...sourceEnvironment };
  delete env.PSModulePath;
  const result = spawnSync(file, args, {
    cwd,
    env,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 90_000,
  });
  if (result.error) throw result.error;
  if (expectedZero)
    assert.equal(result.status, 0, `${file} ${args.join(" ")}: ${result.stderr?.toString("utf8")}`);
  return result;
}

function git(root, args) {
  return command(root, "git", ["-c", "core.quotepath=false", ...args])
    .stdout.toString("utf8")
    .trim();
}

function write(root, relative, bytes) {
  const file = path.join(root, relative);
  assert(
    path.resolve(file).startsWith(`${path.resolve(root)}${path.sep}`),
    "Fixture writes must stay within fixture root",
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

function writeJson(root, relative, value) {
  write(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

const read = (root, relative) => fs.readFileSync(path.join(root, relative));
const json = (root, relative) => parseJson(read(root, relative));
const hash = (root, relative) => sha256(read(root, relative));
const mutateJson = (root, relative, change) => {
  const value = json(root, relative);
  change(value);
  writeJson(root, relative, value);
};

function commit(root, subject) {
  git(root, ["add", "--all"]);
  git(root, ["diff", "--cached", "--check"]);
  git(root, ["commit", "-m", subject]);
  return git(root, ["rev-parse", "HEAD"]);
}

function newFixture(name) {
  const root = path.join(temporaryRoot, name);
  command(temporaryRoot, "git", [
    "clone",
    "--shared",
    "--no-hardlinks",
    "--no-checkout",
    sourceRoot,
    root,
  ]);
  // This fresh fixture has no user work; select the immutable pre-Phase001 baseline.
  git(root, ["checkout", "-B", "main", baseline]);
  for (const [key, value] of [
    ["user.name", "Serendipity Protocol Fixture"],
    ["user.email", "fixture@serendipity.invalid"],
    ["commit.gpgsign", "false"],
    ["core.autocrlf", "false"],
    ["core.safecrlf", "false"],
    ["core.hooksPath", ".git/hooks"],
  ])
    git(root, ["config", "--local", key, value]);
  git(root, ["remote", "set-url", "origin", manifest.gitPolicy.remoteUrl]);
  for (const input of sourceReceipt.pinnedInputs)
    write(root, input.path, read(sourceRoot, input.path));
  for (const file of [
    "scripts/validate-phase.mjs",
    "scripts/validate-phase.ps1",
    "scripts/phase-evidence.mjs",
    "scripts/checkpoint-history.mjs",
  ])
    write(root, file, read(sourceRoot, file));
  for (const contract of manifest.projectContracts.filter(
    (entry) => entry.required && entry.producerPhase === 1,
  )) {
    write(
      root,
      contract.path,
      `# Protocol fixture: ${contract.id}\n\nThis file tests contract presence only. Product semantics are evaluated separately.\n`,
    );
  }
  return root;
}

function writeArtifact(root, attempt = "protocol-fixture", change = () => {}) {
  const caseId = "Phase001:protocol-git-version";
  let previousAttempts = [];
  if (fs.existsSync(path.join(root, planPath))) {
    const priorBytes = read(root, planPath);
    const prior = parseJson(priorBytes);
    if (prior.attemptId !== attempt) {
      const archivedPlan = `docs/evidence/attempts/Phase001/${prior.attemptId}/plan.json`;
      write(root, archivedPlan, priorBytes);
      previousAttempts = [
        ...prior.previousAttempts,
        { attemptId: prior.attemptId, planPath: archivedPlan, planHash: sha256(priorBytes) },
      ];
    }
  }
  const plan = {
    phase: 1,
    attemptId: attempt,
    producer: "Phase001 protocol fixture",
    consumers: [2],
    scope: "Isolated checkpoint protocol regression, not product acceptance",
    modificationScope: ["docs/", "scripts/"],
    implementationContextId: "synthetic-implementation-fixture",
    sourcePaths: [planPath, fixtureInput],
    requiredCaseIds: [caseId],
    cases: [
      {
        testCaseId: caseId,
        command: "git --version",
        denominator: 1,
        inputPath: fixtureInput,
        outputPath: fixtureOutput,
        expected: "The installed Git executable exits 0 and produces its version",
      },
    ],
    threshold: { originalThreshold: 1, automatedThreshold: 1, waived: false },
    previousAttempts,
  };
  writeJson(root, planPath, plan);
  writeJson(root, receiptPath, sourceReceipt);
  write(root, fixtureInput, Buffer.from([0, 255, 13, 10, 228, 184, 173, 1]));
  const gitVersion = command(root, "git", ["--version"]);
  writeJson(root, fixtureOutput, {
    testCaseId: caseId,
    command: "git --version",
    status: "PASS",
    exitCode: gitVersion.status,
    numerator: 1,
    denominator: 1,
    inputPath: fixtureInput,
    inputHash: hash(root, fixtureInput),
    planHash: hash(root, planPath),
    sourceHashes: Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(root, file)])),
    details: { stdout: gitVersion.stdout.toString("utf8") },
  });
  writeJson(root, fixtureReview, {
    phase: 1,
    attemptId: attempt,
    reviewerRunId: "synthetic-protocol-review-fixture",
    contextId: "isolated-protocol-fixture",
    runnerIdentity: {
      kind: "SYNTHETIC_PROTOCOL_FIXTURE_NOT_AGENT_REVIEW",
      implementationAuthored: false,
    },
    implementationContextId: plan.implementationContextId,
    generatedBy: "Protocol fixture generator; no independent Agent review is claimed",
    generatedAt: new Date().toISOString(),
    planPath,
    planHash: hash(root, planPath),
    decision: "PASS",
    issues: [],
    dispositions: [],
    sourceHashes: { [planPath]: hash(root, planPath), [fixtureInput]: hash(root, fixtureInput) },
    reportHashes: { [fixtureOutput]: hash(root, fixtureOutput) },
    scope: "Synthetic JSON fixture for validating reviewer binding, not a real independent review",
  });
  change(root);
  const artifact = commit(root, "phase(001): artifact");
  return { artifact, attempt, caseId, testedTree: git(root, ["rev-parse", "HEAD^{tree}"]) };
}

function writeMetadata(
  root,
  artifactInfo,
  { recovery = [], changeGate = () => {}, changeState = () => {}, beforeCommit = () => {} } = {},
) {
  const { artifact, attempt, caseId, testedTree } = artifactInfo;
  const evidence = {
    schemaVersion: "agent-gate-v1",
    phase: 1,
    attemptId: attempt,
    status: "PASS",
    simulation: true,
    operatorMode: "AGENT_ONLY_AUTOMATED_NEW_BUILD",
    environment: {
      isolated: true,
      syntheticUsers: true,
      providerMode: "contract-replay",
      productionTraffic: false,
    },
    artifactCommit: artifact,
    requiredCaseIds: [caseId],
    results: [
      {
        testCaseId: caseId,
        command: "git --version",
        exitCode: 0,
        numerator: 1,
        denominator: 1,
        inputHash: `sha256:${hash(root, fixtureInput)}`,
        outputHash: `sha256:${hash(root, fixtureOutput)}`,
        status: "PASS",
        details: { inputPath: fixtureInput, outputPath: fixtureOutput },
      },
    ],
    commands: [{ command: "git --version", exitCode: 0 }],
    inputs: [planPath, receiptPath, fixtureInput].map((file) => ({
      path: file,
      sha256: hash(root, file),
    })),
    failures: [],
    generatedAt: new Date().toISOString(),
    details: {
      planPath,
      planHash: hash(root, planPath),
      testedTree,
      reviewerRunId: "synthetic-protocol-review-fixture",
      reviewReportPath: fixtureReview,
      reviewReportHash: hash(root, fixtureReview),
      recoveryCommits: recovery,
      originalThreshold: 1,
      automatedThreshold: 1,
      waived: false,
      scope:
        "Protocol fixture only; synthetic review identity is not independent acceptance evidence",
    },
  };
  changeGate(evidence);
  writeJson(root, gatePath, evidence);
  const initial = parseJson(command(root, "git", ["show", `${baseline}:${runPath}`]).stdout);
  const checkpoint = {
    phase: 1,
    artifactCommit: artifact,
    evidencePath: gatePath,
    evidenceHash: hash(root, gatePath),
  };
  const state = {
    ...initial,
    progressSource: "CURRENT_LAYOUT_CHECKPOINT",
    baselineCommit: baseline,
    executionBaselineCommit: baseline,
    manifestHash: sha256(manifestBytes),
    completedThrough: 1,
    currentPhase: 2,
    lastArtifactCommit: artifact,
    currentLayoutPhaseSeal: checkpoint,
    checkpoints: [checkpoint],
    contractHashes: Object.fromEntries(
      manifest.runStatePinnedInputs.map((input) => [
        input.id,
        hash(root, `${roadmapRelative}/${input.path}`),
      ]),
    ),
    nextRun: { ...initial.nextRun, baselineCommit: baseline },
  };
  changeState(state);
  writeJson(root, runPath, state);
  write(
    root,
    "docs/phase-completion-log.md",
    `${read(root, "docs/phase-completion-log.md").toString("utf8").trimEnd()}\n\nPhase001 ${attempt}: synthetic protocol candidate ${artifact}.\n`,
  );
  beforeCommit(root);
  const metadata = commit(root, "phase(001): metadata");
  return { ...artifactInfo, metadata, root };
}

function validate(root, label, diagnostic = "", completed = 1, protocolFixture = true) {
  for (const shell of shells) {
    const file =
      shell === "node" ? process.execPath : shell === "powershell" ? "powershell.exe" : "pwsh.exe";
    const args =
      shell === "node"
        ? [
            "scripts/validate-phase.mjs",
            "--completed-through",
            String(completed),
            "--strict",
            "--json",
          ]
        : [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            "scripts/validate-phase.ps1",
            "-CompletedThrough",
            String(completed),
            "-Strict",
            "-Json",
          ];
    if (protocolFixture) args.push(shell === "node" ? "--protocol-fixture" : "-ProtocolFixture");
    const result = command(root, file, args, false);
    const output = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`.trim();
    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new Error(`${label}/${shell}: validator did not emit JSON: ${output}`);
    }
    observations.push({
      case: label,
      shell,
      command: `${file} ${args.join(" ")}`,
      exitCode: result.status,
      expectedDiagnostic: diagnostic || null,
      result: parsed,
    });
    if (diagnostic) {
      assert.notEqual(result.status, 0, `${label}/${shell}: expected nonzero validator exit`);
      assert.equal(parsed.status, "FAIL", `${label}/${shell}: expected FAIL`);
      assert(
        output.includes(diagnostic),
        `${label}/${shell}: expected ${diagnostic}, got ${output}`,
      );
    } else {
      assert.equal(result.status, 0, `${label}/${shell}: ${output}`);
      assert.equal(parsed.status, "PASS");
      assert.equal(parsed.scope, "ISOLATED_PROTOCOL_FIXTURE_VALIDATION");
      assert.equal(parsed.protocolFixture, true);
      assert.equal(parsed.projectGitPrefix, "");
      assert.equal(parsed.repositoryRoot, parsed.projectRoot);
      assert.equal(parsed.historicalPhase, 0);
      assert.equal(parsed.preservedHistoricalFiles, 44);
      assert.equal(parsed.contractCoverage.denominator, 20);
    }
  }
}

function runCase(name, fn) {
  if (selectedCases && !selectedCases.includes(name)) return;
  const caseStart = performance.now();
  fn();
  cases.push({ name, status: "PASS", durationMs: Math.round(performance.now() - caseStart) });
}

function metadataMutation(
  name,
  diagnostic,
  changeGate = () => {},
  changeState = () => {},
  beforeCommit = () => {},
) {
  runCase(name, () => {
    const root = newFixture(name);
    const info = writeArtifact(root);
    writeMetadata(root, info, { changeGate, changeState, beforeCommit });
    validate(root, name, diagnostic);
  });
}

function restoredMutation(name, diagnostic, mutate, restore) {
  runCase(name, () => {
    const root = newFixture(name);
    writeMetadata(root, writeArtifact(root));
    mutate(root);
    validate(root, name, diagnostic);
    restore(root);
    validate(root, `${name}-restored`);
  });
}

let report;
try {
  runCase("root-equality-empty-prefix-local-inputs-history-pass", () => {
    const root = newFixture("positive");
    const pair = writeMetadata(root, writeArtifact(root));
    validate(root, "root-equality-empty-prefix-local-inputs-history-pass");
    assert.equal(git(root, ["status", "--porcelain=v1"]), "");
    assert.equal(git(root, ["ls-files", "--", `${roadmapRelative}/`]), "");
    const remote = path.join(temporaryRoot, "isolated-remote.git");
    command(temporaryRoot, "git", ["init", "--bare", remote]);
    git(root, ["push", remote, `${baseline}:refs/heads/main`]);
    git(root, ["push", remote, "main:refs/heads/main"]);
    assert.equal(
      git(root, ["ls-remote", "--heads", remote, "main"]).split(/\s+/)[0],
      pair.metadata,
    );
    observations.push({
      case: "local-fast-forward-sync",
      command: "git push <isolated local bare repository> main:refs/heads/main",
      exitCode: 0,
      metadataCommit: pair.metadata,
      network: "LOCAL_FILESYSTEM_ONLY",
    });
  });
  metadataMutation("evidence-input-hash", "INPUT_HASH", (gate) => {
    gate.inputs[0].sha256 = "0".repeat(64);
  });
  metadataMutation("evidence-output-hash", "OUTPUT_HASH", (gate) => {
    gate.results[0].outputHash = `sha256:${"0".repeat(64)}`;
  });
  metadataMutation("frozen-denominator", "DENOMINATOR", (gate) => {
    gate.results[0].numerator = 2;
    gate.results[0].denominator = 2;
  });
  metadataMutation("frozen-required-cases", "PLAN_CASES", (gate) => {
    gate.requiredCaseIds = ["invented"];
    gate.results[0].testCaseId = "invented";
  });
  metadataMutation("duplicate-result", "RESULT_CASES", (gate) => {
    gate.results.push(structuredClone(gate.results[0]));
  });
  metadataMutation("tested-tree", "TESTED_TREE", (gate) => {
    gate.details.testedTree = "0".repeat(40);
  });
  metadataMutation("schema-extra-property", "GATE_SCHEMA", (gate) => {
    gate.requiredTests = ["invented"];
  });
  metadataMutation("simulation-disabled", "GATE_SCHEMA", (gate) => {
    gate.simulation = false;
  });
  metadataMutation("production-traffic", "GATE_SCHEMA", (gate) => {
    gate.environment.productionTraffic = true;
  });
  metadataMutation("unsafe-input-path", "UNSAFE_PATH", (gate) => {
    gate.inputs[0].path = "../outside.bin";
  });
  metadataMutation("missing-review", "GIT_BLOB", (gate) => {
    gate.details.reviewReportPath = "docs/missing-review.json";
  });
  metadataMutation("review-hash", "REVIEW_HASH", (gate) => {
    gate.details.reviewReportHash = "0".repeat(64);
  });
  metadataMutation("gate-plan-hash", "PLAN_HASH", (gate) => {
    gate.details.planHash = "0".repeat(64);
  });
  metadataMutation("checkpoint-evidence-hash", "EVIDENCE_HASH", undefined, (state) => {
    state.checkpoints[0].evidenceHash = "0".repeat(64);
  });
  metadataMutation("missing-baseline", "COMMIT_ID", undefined, (state) => {
    delete state.executionBaselineCommit;
  });
  metadataMutation("baseline-after-start", "BASELINE", undefined, (state) => {
    state.baselineCommit = state.lastArtifactCommit;
    state.executionBaselineCommit = state.lastArtifactCommit;
  });
  metadataMutation("wrong-artifact-parent", "CHECKPOINT_ARTIFACT", undefined, (state) => {
    state.lastArtifactCommit = baseline;
  });
  metadataMutation("metadata-product-change", "METADATA_PATH", undefined, undefined, (root) => {
    write(root, "docs/code-style.md", "# Changed after artifact tests\n");
  });
  metadataMutation("wrong-progress", "RUN_PROGRESS", undefined, (state) => {
    state.currentPhase = 3;
  });
  metadataMutation("missing-checkpoint", "CHECKPOINTS", undefined, (state) => {
    state.checkpoints = [];
  });
  metadataMutation("waived-threshold", "THRESHOLD", (gate) => {
    gate.details.waived = true;
  });
  metadataMutation("failed-command", "COMMANDS", (gate) => {
    gate.commands[0].exitCode = 1;
  });

  for (const [name, diagnostic, mutate] of [
    [
      "review-blocked",
      "REVIEW_DECISION",
      (review) => {
        review.decision = "BLOCKED";
      },
    ],
    [
      "review-stale-plan",
      "REVIEW_BINDING",
      (review) => {
        review.planHash = "0".repeat(64);
      },
    ],
    [
      "review-not-independent",
      "REVIEW_IDENTITY",
      (review) => {
        review.runnerIdentity.implementationAuthored = true;
      },
    ],
    [
      "review-unresolved-issue",
      "REVIEW_ISSUES",
      (review) => {
        review.issues = [{ id: "open", status: "OPEN" }];
      },
    ],
    [
      "review-source-hash",
      "REVIEW_FILE_HASH",
      (review) => {
        review.sourceHashes[fixtureInput] = "0".repeat(64);
      },
    ],
    [
      "review-report-hash",
      "REVIEW_FILE_HASH",
      (review) => {
        review.reportHashes[fixtureOutput] = "0".repeat(64);
      },
    ],
    [
      "review-source-map-empty",
      "REVIEW_FILE_HASH",
      (review) => {
        review.sourceHashes = {};
      },
    ],
    [
      "review-source-entry-omitted",
      "REVIEW_FILE_HASH",
      (review) => {
        delete review.sourceHashes[fixtureInput];
      },
    ],
    [
      "review-report-map-empty",
      "REVIEW_FILE_HASH",
      (review) => {
        review.reportHashes = {};
      },
    ],
    [
      "review-source-map-missing",
      "REVIEW_FILE_HASH",
      (review) => {
        delete review.sourceHashes;
      },
    ],
    [
      "review-same-context",
      "REVIEW_IDENTITY",
      (review) => {
        review.contextId = review.implementationContextId;
      },
    ],
  ])
    runCase(name, () => {
      const root = newFixture(name);
      const info = writeArtifact(root, "protocol-fixture", (candidate) =>
        mutateJson(candidate, fixtureReview, mutate),
      );
      writeMetadata(root, info);
      validate(root, name, diagnostic);
    });

  for (const [name, mutate] of [
    [
      "report-source-map-empty",
      (report) => {
        report.sourceHashes = {};
      },
    ],
    [
      "report-source-entry-omitted",
      (report) => {
        delete report.sourceHashes[fixtureInput];
      },
    ],
    [
      "report-source-hash-stale",
      (report) => {
        report.sourceHashes[fixtureInput] = "0".repeat(64);
      },
    ],
  ])
    runCase(name, () => {
      const root = newFixture(name);
      const info = writeArtifact(root, "protocol-fixture", (candidate) => {
        mutateJson(candidate, fixtureOutput, mutate);
        mutateJson(candidate, fixtureReview, (review) => {
          review.reportHashes[fixtureOutput] = hash(candidate, fixtureOutput);
        });
      });
      writeMetadata(root, info);
      validate(root, name, "REPORT_SOURCE_HASH");
    });
  runCase("formal-seal-rejects-synthetic-review", () => {
    const root = newFixture("formal-seal-rejects-synthetic-review");
    writeMetadata(root, writeArtifact(root));
    validate(root, "formal-seal-rejects-synthetic-review", "REVIEW_IDENTITY", 1, false);
  });

  const sourceCard = `${roadmapRelative}/Phase001.md`;
  restoredMutation(
    "local-pinned-input-drift",
    "LOCAL_INPUT_HASH",
    (root) =>
      write(root, sourceCard, Buffer.concat([read(root, sourceCard), Buffer.from("\nmutation\n")])),
    (root) => write(root, sourceCard, read(sourceRoot, sourceCard)),
  );
  restoredMutation(
    "wrong-origin",
    "GIT_REMOTE",
    (root) => git(root, ["remote", "set-url", "origin", "https://example.invalid/wrong.git"]),
    (root) => git(root, ["remote", "set-url", "origin", manifest.gitPolicy.remoteUrl]),
  );
  restoredMutation(
    "dirty-root-worktree",
    "WORKTREE_DIRTY",
    (root) => write(root, "untracked.txt", "isolated mutation\n"),
    (root) => fs.unlinkSync(path.join(root, "untracked.txt")),
  );
  restoredMutation(
    "historical-archive-bytes",
    "HISTORY_BYTES",
    (root) =>
      write(
        root,
        "docs/history/Phase000/docs/project-constitution.md",
        "isolated archive mutation\n",
      ),
    (root) =>
      write(
        root,
        "docs/history/Phase000/docs/project-constitution.md",
        read(sourceRoot, "docs/history/Phase000/docs/project-constitution.md"),
      ),
  );
  restoredMutation(
    "project-root-not-equal",
    "ROOT_LAYOUT",
    (root) =>
      mutateJson(root, "docs/project-layout.json", (value) => {
        value.projectRoot = "project";
      }),
    (root) => write(root, "docs/project-layout.json", read(sourceRoot, "docs/project-layout.json")),
  );

  runCase("required-contract-removal", () => {
    const root = newFixture("required-contract-removal");
    const info = writeArtifact(root, "protocol-fixture", (candidate) =>
      fs.unlinkSync(path.join(candidate, "docs/database.md")),
    );
    writeMetadata(root, info);
    validate(root, "required-contract-removal", "CONTRACT_COVERAGE");
  });
  runCase("local-roadmap-tracked", () => {
    const root = newFixture("local-roadmap-tracked");
    git(root, ["add", "-f", "--", sourceCard]);
    writeMetadata(root, writeArtifact(root));
    validate(root, "local-roadmap-tracked", "ROADMAP_TRACKED");
  });
  runCase("artifact-contains-metadata", () => {
    const root = newFixture("artifact-contains-metadata");
    const info = writeArtifact(root, "protocol-fixture", (candidate) =>
      write(candidate, "docs/phase-completion-log.md", "# Premature metadata\n"),
    );
    writeMetadata(root, info);
    validate(root, "artifact-contains-metadata", "ARTIFACT_METADATA");
  });
  runCase("real-parent-interposition", () => {
    const root = newFixture("real-parent-interposition");
    const info = writeArtifact(root);
    write(
      root,
      "docs/evidence/attempts/Phase001/protocol-fixture/intermediate.txt",
      "Intermediate commit\n",
    );
    commit(root, "phase(001): recovery");
    writeMetadata(root, info);
    validate(root, "real-parent-interposition", "CHECKPOINT_PARENT");
  });
  runCase("recovery-history-pass", () => {
    const root = newFixture("recovery-history-pass");
    const first = writeMetadata(root, writeArtifact(root, "unsealed-fixture"));
    write(
      root,
      "docs/evidence/attempts/Phase001/protocol-fixture/recovery.txt",
      "Retained unsealed attempt diagnosis\n",
    );
    const recovery = commit(root, "phase(001): recovery");
    const second = writeArtifact(root, "recovered-fixture");
    writeMetadata(root, second, { recovery: [first.artifact, first.metadata, recovery] });
    validate(root, "recovery-history-pass");
  });
  runCase("omitted-recovery-history", () => {
    const root = newFixture("omitted-recovery-history");
    writeMetadata(root, writeArtifact(root, "unsealed-fixture"));
    writeMetadata(root, writeArtifact(root, "recovered-fixture"));
    validate(root, "omitted-recovery-history", "RECOVERY_COMMITS");
  });
  runCase("missing-previous-plan", () => {
    const root = newFixture("missing-previous-plan");
    const first = writeMetadata(root, writeArtifact(root, "unsealed-fixture"));
    const second = writeArtifact(root, "recovered-fixture", (candidate) => {
      mutateJson(candidate, planPath, (plan) => {
        plan.previousAttempts = [];
      });
      mutateJson(candidate, fixtureReview, (review) => {
        review.planHash = hash(candidate, planPath);
        review.sourceHashes[planPath] = review.planHash;
      });
      mutateJson(candidate, fixtureOutput, (report) => {
        report.planHash = hash(candidate, planPath);
        report.sourceHashes[planPath] = report.planHash;
      });
      mutateJson(candidate, fixtureReview, (review) => {
        review.reportHashes[fixtureOutput] = hash(candidate, fixtureOutput);
      });
    });
    writeMetadata(root, second, { recovery: [first.artifact, first.metadata] });
    validate(root, "missing-previous-plan", "RECOVERY_PLAN");
  });
  runCase("previous-required-case-removal", () => {
    const root = newFixture("previous-required-case-removal");
    const info = writeArtifact(root, "protocol-fixture", (candidate) => {
      const plan = json(candidate, planPath);
      const prior = structuredClone(plan);
      prior.attemptId = "previous-fixture";
      prior.requiredCaseIds.push("Phase001:original-required-case");
      prior.cases.push({ ...prior.cases[0], testCaseId: "Phase001:original-required-case" });
      const archivedPlan = "docs/evidence/attempts/Phase001/previous-fixture/plan.json";
      writeJson(candidate, archivedPlan, prior);
      plan.previousAttempts = [
        {
          attemptId: prior.attemptId,
          planPath: archivedPlan,
          planHash: hash(candidate, archivedPlan),
        },
      ];
      writeJson(candidate, planPath, plan);
      mutateJson(candidate, fixtureReview, (review) => {
        review.planHash = hash(candidate, planPath);
        review.sourceHashes[planPath] = review.planHash;
      });
    });
    writeMetadata(root, info);
    validate(root, "previous-required-case-removal", "PRIOR_PLAN_CASES");
  });
  runCase("future-phase-history", () => {
    const root = newFixture("future-phase-history");
    write(
      root,
      "docs/evidence/attempts/Phase001/protocol-fixture/future.txt",
      "Incorrect future-phase subject\n",
    );
    const wrong = commit(root, "phase(002): recovery");
    writeMetadata(root, writeArtifact(root), { recovery: [wrong] });
    validate(root, "future-phase-history", "COMMIT_SUBJECT");
  });
  assert(cases.length > 0, "No regression case matched");
  if (selectedCases)
    assert.deepEqual(
      cases.map((entry) => entry.name).sort(),
      [...selectedCases].sort(),
      "Some selected regression cases did not run",
    );
  report = {
    status: "PASS",
    scope: "ISOLATED_ROOT_LAYOUT_GIT_PROTOCOL_REGRESSION",
    simulation: true,
    sourceRepositoryIndexMutated: false,
    network: "LOCAL_FILESYSTEM_ONLY",
    independentReviewPerformed: false,
    reviewFixturePolicy:
      "Synthetic protocol JSON only; actual phase acceptance requires a separate independent Agent report",
    sourceBaselineCommit: baseline,
    testedSourceHashes: Object.fromEntries(
      [
        "scripts/validate-phase.mjs",
        "scripts/validate-phase.ps1",
        "scripts/phase-evidence.mjs",
        "scripts/test-validate-phase.mjs",
        receiptPath,
      ].map((file) => [file, hash(sourceRoot, file)]),
    ),
    shells,
    caseCount: cases.length,
    observationCount: observations.length,
    cases,
    observations,
    durationMs: Math.round(performance.now() - started),
    fixtureRoot: options.keep ? temporaryRoot : null,
  };
} catch (error) {
  report = {
    status: "FAIL",
    scope: "ISOLATED_ROOT_LAYOUT_GIT_PROTOCOL_REGRESSION",
    error: error.message,
    sourceBaselineCommit: baseline,
    shells,
    cases,
    observations,
    durationMs: Math.round(performance.now() - started),
    fixtureRoot: temporaryRoot,
  };
  process.exitCode = 1;
}
if (options.output) {
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
}
console.warn(
  JSON.stringify(
    options.output
      ? {
          status: report.status,
          scope: report.scope,
          error: report.error,
          caseCount: report.caseCount ?? report.cases.length,
          observationCount: report.observationCount ?? report.observations.length,
          durationMs: report.durationMs,
          output: options.output,
        }
      : report,
    null,
    2,
  ),
);
if (report.status === "PASS" && !options.keep) {
  const resolved = fs.realpathSync(temporaryRoot);
  assert(
    path.dirname(resolved) === temporaryParent &&
      path.basename(resolved).startsWith("serendipity-phase-validator-"),
    "Unsafe temporary cleanup target",
  );
  fs.rmSync(resolved, { recursive: true, force: true });
}
