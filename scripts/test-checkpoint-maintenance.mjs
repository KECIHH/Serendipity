import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkpointHistoryEnvironment } from "./checkpoint-history.mjs";
import {
  createMaintenanceReceipt,
  validateCheckpointMaintenance,
  maintenanceAllowedPaths,
  maintenanceBaseArtifact,
  maintenanceBaseMetadata,
  maintenancePolicyPath,
  maintenanceReceiptPath,
  maintenanceSubject,
  executionMaintenanceId,
  executionMaintenanceReceiptPath,
  executionPolicyPath,
  executionBaseMetadata,
  executionBaseArtifact,
  executionMaintenanceSubject,
  executionAllowedPaths,
} from "./checkpoint-maintenance.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceEnvironment = checkpointHistoryEnvironment(sourceRoot).env;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const parseJson = (bytes) => JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
const read = (root, file) => fs.readFileSync(path.join(root, file));
const json = (root, file) => parseJson(read(root, file));
const hashFile = (root, file) => sha256(read(root, file));
const options = { shell: "node", keep: false };
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg === "--shell") options.shell = process.argv[++index];
  else if (arg === "--case") options.cases = process.argv[++index].split(",");
  else if (arg === "--keep") options.keep = true;
  else if (arg === "--output") options.output = path.resolve(process.argv[++index]);
  else throw new Error(`Unknown argument: ${arg}`);
}
assert(["node", "powershell", "pwsh", "both"].includes(options.shell), "Invalid shell");
const shells = options.shell === "both" ? ["powershell", "pwsh"] : [options.shell];
const temporaryParent = fs.realpathSync(os.tmpdir());
const temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, "serendipity-phase-validator-"));
const cases = [];
const observations = [];
const started = performance.now();
const sourceReceipt = json(sourceRoot, "docs/phase-plans/Phase012-inputs.json");
const sourceManifest = json(sourceRoot, "Serendipity · 际遇/docs/roadmap-execution-manifest.json");
const inputPaths = new Set();
for (let phase = 1; phase <= 13; phase += 1) {
  const receipt = json(
    sourceRoot,
    `docs/phase-plans/Phase${String(phase).padStart(3, "0")}-inputs.json`,
  );
  for (const input of receipt.pinnedInputs) inputPaths.add(input.path);
}
inputPaths.add("Serendipity · 际遇/Phase013.md");
const localGuides = ["Serendipity · 际遇/AGENTS.md", "Serendipity · 际遇/README.md"];

function command(root, executable, args, expectedZero = true, input) {
  const env = { ...sourceEnvironment };
  delete env.PSModulePath;
  const result = spawnSync(executable, args, {
    cwd: root,
    env,
    input,
    windowsHide: true,
    timeout: 90_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (expectedZero)
    assert.equal(
      result.status,
      0,
      `${executable} ${args.join(" ")}:\n${result.stdout?.toString("utf8")}${result.stderr?.toString("utf8")}`,
    );
  return result;
}
const git = (root, args, input) =>
  command(root, "git", ["-c", "core.quotepath=false", ...args], true, input).stdout;
const gitText = (root, args) => git(root, args).toString("utf8").trim();
function write(root, relative, bytes) {
  const file = path.resolve(root, relative);
  assert(
    file.startsWith(`${fs.realpathSync(root)}${path.sep}`),
    "Fixture path must remain within its root",
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
const writeJson = (root, file, value) => write(root, file, `${JSON.stringify(value, null, 2)}\n`);
function commit(root, subject) {
  assert(
    fs.realpathSync(root).startsWith(`${temporaryRoot}${path.sep}`),
    "Only isolated fixture indexes may be changed",
  );
  git(root, ["add", "--all"]);
  git(root, ["diff", "--cached", "--check"]);
  git(root, ["commit", "-m", subject]);
  return gitText(root, ["rev-parse", "HEAD"]);
}
function newFixture(name, full = false, base = maintenanceBaseMetadata) {
  const root = path.join(temporaryRoot, name);
  command(temporaryRoot, "git", [
    "clone",
    "--shared",
    "--no-hardlinks",
    "--no-checkout",
    sourceRoot,
    root,
  ]);
  for (const [key, value] of [
    ["user.name", "Serendipity Maintenance Fixture"],
    ["user.email", "fixture@serendipity.invalid"],
    ["commit.gpgsign", "false"],
    ["core.autocrlf", "false"],
    ["core.safecrlf", "false"],
    ["core.longpaths", "true"],
    ["core.hooksPath", ".git/hooks"],
  ])
    git(root, ["config", "--local", key, value]);
  git(root, ["checkout", "-B", "main", base]);
  // Preserve the four existing raw-evidence exceptions, without disabling whitespace checks.
  write(
    root,
    ".git/info/attributes",
    [
      "docs/evidence/attempts/Phase013/attempt-6/history-evidence-rejection/overlays/archived-failure-source/docs/evidence/attempts/Phase013/attempt-5/frame-origin-rejection/prior-evidence-sources/phase013-evidence.mjs",
      "docs/evidence/attempts/Phase013/attempt-6/history-evidence-rejection/overlays/original-evidence-raw/docs/evidence/attempts/Phase013/attempt-5/all-tests-vitest.json",
      "docs/evidence/attempts/Phase013/attempt-6/history-evidence-rejection/overlays/original-migration-diagnostic/docs/evidence/attempts/Phase013/attempt-1/migration-diagnostic.json",
      "docs/evidence/attempts/Phase013/setup/schema-diff.sql",
    ]
      .map((file) => `/${file} whitespace=-blank-at-eof\n`)
      .join(""),
  );
  git(root, ["remote", "set-url", "origin", sourceManifest.gitPolicy.remoteUrl]);
  for (const file of localGuides) write(root, file, read(sourceRoot, file));
  if (full) {
    for (const file of inputPaths) write(root, file, read(sourceRoot, file));
    const bundle = ".scaffold/checkpoint-import/original-history.bundle";
    write(root, bundle, read(sourceRoot, bundle));
  }
  return root;
}
function addMaintenance(
  root,
  mutateReceipt = () => {},
  mutateFiles = () => {},
  subject = maintenanceSubject,
  execution = false,
) {
  const receiptPath = execution ? executionMaintenanceReceiptPath : maintenanceReceiptPath;
  const paths = execution ? executionAllowedPaths : maintenanceAllowedPaths;
  for (const file of paths.filter((entry) => entry !== receiptPath)) {
    const sourceBytes = read(sourceRoot, file);
    const bytes =
      fs.existsSync(path.join(root, file)) && read(root, file).equals(sourceBytes)
        ? Buffer.concat([
            sourceBytes,
            Buffer.from(
              file.endsWith(".mjs")
                ? "\n// Isolated maintenance fixture.\n"
                : "\n<!-- Isolated maintenance fixture. -->\n",
            ),
          ])
        : sourceBytes;
    write(root, file, bytes);
  }
  const receipt = createMaintenanceReceipt(root, execution ? executionMaintenanceId : undefined);
  mutateReceipt(receipt);
  writeJson(root, receiptPath, receipt);
  mutateFiles(root);
  return commit(root, subject);
}
const addExecutionMaintenance = (root, mutateReceipt, mutateFiles) =>
  addMaintenance(root, mutateReceipt, mutateFiles, executionMaintenanceSubject, true);
function inspect(root) {
  const head = gitText(root, ["rev-parse", "HEAD"]);
  const history = gitText(root, [
    "log",
    "--reverse",
    "--format=%H%x09%P%x09%s",
    `${maintenanceBaseArtifact}..${head}`,
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, parents, subject] = line.split("\t");
      return { id, parents: parents.split(" "), subject };
    });
  return validateCheckpointMaintenance({
    root,
    state: json(root, "docs/roadmap-run.json"),
    head,
    history,
    git: (args, input) => git(root, args, input),
    blob: (id, file) => git(root, ["cat-file", "blob", `${id}:${file}`]),
  });
}
function validate(
  root,
  completedThrough,
  { fixture = false, diagnostic, metadataCommit, admissionOnly } = {},
) {
  for (const shell of shells) {
    const executable =
      shell === "node" ? process.execPath : shell === "powershell" ? "powershell.exe" : "pwsh.exe";
    const args =
      shell === "node"
        ? [
            path.join(sourceRoot, "scripts/validate-phase.mjs"),
            "--repository-root",
            root,
            "--completed-through",
            String(completedThrough),
            "--strict",
            "--json",
          ]
        : [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.join(sourceRoot, "scripts/validate-phase.ps1"),
            "-RepositoryRoot",
            root,
            "-CompletedThrough",
            String(completedThrough),
            "-Strict",
            "-Json",
          ];
    if (fixture) args.push(shell === "node" ? "--protocol-fixture" : "-ProtocolFixture");
    const result = command(root, executable, args, false);
    const output = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`.trim();
    const parsed = JSON.parse(output);
    observations.push({
      case: path.basename(root),
      shell,
      exitCode: result.status,
      expectedDiagnostic: diagnostic ?? null,
      result: parsed,
    });
    if (diagnostic) {
      assert.notEqual(result.status, 0, "Negative fixture must fail");
      assert.equal(parsed.status, "FAIL");
      assert(output.includes(diagnostic), `${diagnostic} expected, got: ${output}`);
    } else {
      assert.equal(result.status, 0, output);
      assert.equal(parsed.status, "PASS");
      assert.equal(parsed.metadataCommit, metadataCommit);
      if (admissionOnly !== undefined) assert.equal(parsed.admissionOnly, admissionOnly);
      if (fixture) assert.equal(parsed.scope, "ISOLATED_PROTOCOL_FIXTURE_VALIDATION");
      else
        assert.equal(
          parsed.scope,
          admissionOnly
            ? "ROOT_LAYOUT_PHASE_CHECKPOINT_ADMISSION"
            : "ROOT_LAYOUT_PHASE_CHECKPOINT_SEAL",
        );
    }
  }
}
function runCase(name, run) {
  if (options.cases && !options.cases.includes(name)) return;
  const start = performance.now();
  run();
  cases.push({ name, status: "PASS", durationMs: Math.round(performance.now() - start) });
}
function mutationCase(name, diagnostic, mutateReceipt, mutateFiles, subject) {
  runCase(name, () => {
    const root = newFixture(name);
    addMaintenance(root, mutateReceipt, mutateFiles, subject);
    assert.throws(() => inspect(root), new RegExp(diagnostic));
  });
}
function addPhase(root, maintenance, { phase = 13, interpose = false } = {}) {
  const name = `Phase${String(phase).padStart(3, "0")}`;
  const subject = `phase(${String(phase).padStart(3, "0")})`;
  const planPath = `docs/phase-plans/${name}.json`;
  const inputsPath = `docs/phase-plans/${name}-inputs.json`;
  const gatePath = `docs/evidence/${name}-gate.json`;
  const folder = `docs/evidence/attempts/${name}/maintenance-fixture`;
  const policyPaths = [maintenancePolicyPath, ...(phase >= 14 ? [executionPolicyPath] : [])];
  const inputPath = `${folder}/input.bin`;
  const outputPath = `${folder}/git-version.json`;
  const reviewPath = `${folder}/review.json`;
  const caseId = `${name}:maintenance-protocol-fixture`;
  const contractPaths = sourceManifest.projectContracts
    .filter((entry) => entry.required && entry.producerPhase === phase)
    .map((entry) => entry.path);
  write(
    root,
    `${folder}/recovery.txt`,
    `Synthetic ${name} recovery; the maintenance commit is a separate admission change.\n`,
  );
  const recovery = commit(root, `${subject}: recovery`);
  const inputs = structuredClone(sourceReceipt);
  Object.assign(inputs, {
    phase,
    phaseStartCommit: phase === 14 ? maintenance.executionMaintenance.commit : maintenance.commit,
    requestedThrough: phase,
    checkpointMaintenance: {
      path: maintenance.path,
      sha256: maintenance.sha256,
      commit: maintenance.commit,
    },
    validationPolicy: maintenance.policy,
    ...(phase >= 14
      ? {
          executionMaintenance: {
            path: maintenance.executionMaintenance.path,
            sha256: maintenance.executionMaintenance.sha256,
            commit: maintenance.executionMaintenance.commit,
          },
          executionPolicy: maintenance.executionMaintenance.policy,
        }
      : {}),
  });
  const phaseCard = `Serendipity · 际遇/${name}.md`;
  if (!inputs.pinnedInputs.some((entry) => entry.path === phaseCard))
    inputs.pinnedInputs.push({
      id: name,
      path: phaseCard,
      sha256: hashFile(root, phaseCard),
    });
  writeJson(root, inputsPath, inputs);
  for (const file of contractPaths)
    write(root, file, `# Synthetic protocol contract fixture; not ${name} product acceptance.\n`);
  write(root, inputPath, Buffer.from([0, 255, 13, 10, 1]));
  const plan = {
    phase,
    attemptId: "maintenance-fixture",
    producer: "Isolated maintenance protocol regression",
    consumers: [phase + 1],
    scope: `Synthetic Git protocol fixture only; no ${name} implementation or independent acceptance is claimed`,
    modificationScope: [planPath, inputsPath, `${folder}/`, ...contractPaths],
    implementationContextId: "synthetic-maintenance-implementation",
    sourcePaths: [planPath, inputPath, ...policyPaths, ...contractPaths],
    requiredCaseIds: [caseId],
    cases: [
      {
        testCaseId: caseId,
        command: "git --version",
        denominator: 1,
        inputPath,
        outputPath,
        expected: "Git exits zero and prints a version",
      },
    ],
    threshold: { originalThreshold: 1, automatedThreshold: 1, waived: false },
    previousAttempts: [],
  };
  writeJson(root, planPath, plan);
  const planHash = hashFile(root, planPath);
  const sourceHashes = Object.fromEntries(
    plan.sourcePaths.map((file) => [file, hashFile(root, file)]),
  );
  const version = command(root, "git", ["--version"]);
  writeJson(root, outputPath, {
    testCaseId: caseId,
    command: "git --version",
    status: "PASS",
    exitCode: version.status,
    numerator: 1,
    denominator: 1,
    inputPath,
    inputHash: hashFile(root, inputPath),
    planHash,
    sourceHashes,
    details: { stdout: version.stdout.toString("utf8") },
  });
  writeJson(root, reviewPath, {
    phase,
    attemptId: plan.attemptId,
    reviewerRunId: "synthetic-maintenance-protocol-review",
    contextId: "synthetic-maintenance-review-context",
    runnerIdentity: {
      kind: "SYNTHETIC_PROTOCOL_FIXTURE_NOT_AGENT_REVIEW",
      implementationAuthored: false,
    },
    implementationContextId: plan.implementationContextId,
    generatedBy: "Isolated protocol fixture generator; not an independent Agent review",
    generatedAt: new Date().toISOString(),
    planPath,
    planHash,
    decision: "PASS",
    issues: [],
    dispositions: [],
    sourceHashes,
    reportHashes: { [outputPath]: hashFile(root, outputPath) },
  });
  const artifact = commit(root, `${subject}: artifact`);
  const testedTree = gitText(root, ["rev-parse", "HEAD^{tree}"]);
  const evidence = {
    schemaVersion: "agent-gate-v1",
    phase,
    attemptId: plan.attemptId,
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
        inputHash: `sha256:${hashFile(root, inputPath)}`,
        outputHash: `sha256:${hashFile(root, outputPath)}`,
        status: "PASS",
        details: { inputPath, outputPath },
      },
    ],
    commands: [{ command: "git --version", exitCode: 0 }],
    inputs: [planPath, inputsPath, inputPath, ...policyPaths].map((file) => ({
      path: file,
      sha256: hashFile(root, file),
    })),
    failures: [],
    generatedAt: new Date().toISOString(),
    details: {
      planPath,
      planHash,
      testedTree,
      reviewerRunId: "synthetic-maintenance-protocol-review",
      reviewReportPath: reviewPath,
      reviewReportHash: hashFile(root, reviewPath),
      recoveryCommits: [recovery],
      originalThreshold: 1,
      automatedThreshold: 1,
      waived: false,
      scope: `Synthetic protocol fixture only; not ${name} acceptance`,
    },
  };
  if (interpose) {
    write(
      root,
      `${folder}/interposition.txt`,
      "Invalid maintenance between artifact and metadata.\n",
    );
    commit(root, maintenanceSubject);
  }
  writeJson(root, gatePath, evidence);
  const state = json(root, "docs/roadmap-run.json");
  const checkpoint = {
    phase,
    artifactCommit: artifact,
    evidencePath: gatePath,
    evidenceHash: hashFile(root, gatePath),
  };
  Object.assign(state, {
    completedThrough: phase,
    currentPhase: phase + 1,
    lastArtifactCommit: artifact,
    currentLayoutPhaseSeal: checkpoint,
    checkpoints: [...state.checkpoints, checkpoint],
  });
  writeJson(root, "docs/roadmap-run.json", state);
  write(
    root,
    "docs/phase-completion-log.md",
    `${read(root, "docs/phase-completion-log.md").toString("utf8").trimEnd()}\n\n${name}: isolated synthetic maintenance protocol fixture only.\n`,
  );
  const metadata = commit(root, `${subject}: metadata`);
  return { inputs, plan, evidence, artifact, metadata, recovery };
}

let report;
try {
  runCase("old-seal-unchanged", () => {
    const root = newFixture("old-seal-unchanged", true);
    assert.equal(inspect(root), null);
    validate(root, 12, { metadataCommit: maintenanceBaseMetadata });
  });
  runCase("maintenance-admission", () => {
    const root = newFixture("maintenance-admission", true);
    const id = addMaintenance(root);
    const maintenance = inspect(root);
    assert.equal(maintenance.commit, id);
    assert.equal(maintenance.admissionOnly, true);
    validate(root, 12, { metadataCommit: maintenanceBaseMetadata, admissionOnly: true });
    assert.equal(gitText(root, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  });
  mutationCase("wrong-anchor", "MAINTENANCE_ANCHOR", (receipt) => {
    receipt.baseMetadataCommit = maintenanceBaseArtifact;
  });
  mutationCase(
    "wrong-subject",
    "MAINTENANCE_SUBJECT",
    undefined,
    undefined,
    "docs: unrelated change",
  );
  mutationCase("scope-widening", "MAINTENANCE_SCOPE", (receipt) => {
    receipt.allowedExactPaths.push("src/");
  });
  mutationCase("before-hash", "MAINTENANCE_BEFORE_HASH", (receipt) => {
    receipt.changes[0].beforeSha256 = "0".repeat(64);
  });
  mutationCase("after-hash", "MAINTENANCE_AFTER_HASH", (receipt) => {
    receipt.changes[0].afterSha256 = "0".repeat(64);
  });
  mutationCase("local-guide-hash", "MAINTENANCE_LOCAL_GUIDES", (receipt) => {
    receipt.localGuides[0].sha256 = "0".repeat(64);
  });
  for (const [name, file] of [
    ["product-change", "src/maintenance-forbidden.ts"],
    ["dependency-change", "package-lock.json"],
    ["database-change", "prisma/schema.prisma"],
    ["old-gate-change", "docs/evidence/Phase012-gate.json"],
    ["old-state-change", "docs/roadmap-run.json"],
    ["history-change", "docs/history/Phase000/README.md"],
  ])
    mutationCase(name, "MAINTENANCE_SCOPE", undefined, (root) => {
      if (file.endsWith(".json") && fs.existsSync(path.join(root, file)))
        writeJson(root, file, { ...json(root, file), maintenanceFixtureUnauthorizedChange: true });
      else write(root, file, "Forbidden unrelated fixture change.\n");
    });
  mutationCase("deleted-allowed-file", "MAINTENANCE_FILE_MODE", undefined, (root) =>
    fs.unlinkSync(path.join(root, "AGENTS.md")),
  );
  mutationCase("renamed-allowed-file", "MAINTENANCE_FILE_MODE", undefined, (root) =>
    fs.renameSync(path.join(root, "AGENTS.md"), path.join(root, "AGENTS-renamed.md")),
  );
  for (const [name, file, diagnostic] of [
    ["receipt-rewritten", maintenanceReceiptPath, "MAINTENANCE_RECEIPT_IMMUTABLE"],
    ["policy-rewritten", maintenancePolicyPath, "MAINTENANCE_POLICY_IMMUTABLE"],
    ["unlisted-tail", "docs/unlisted-maintenance.md", "MAINTENANCE_TAIL"],
  ])
    runCase(name, () => {
      const root = newFixture(name);
      addMaintenance(root);
      if (file === maintenanceReceiptPath)
        write(root, file, `${JSON.stringify(json(root, file), null, 4)}\n`);
      else if (file === maintenancePolicyPath)
        write(
          root,
          file,
          `${read(root, file).toString("utf8").trimEnd()}\n\n<!-- Invalid policy rewrite fixture. -->\n`,
        );
      else write(root, file, "Unlisted maintenance tail.\n");
      commit(root, "docs: unlisted follow-up");
      assert.throws(() => inspect(root), new RegExp(diagnostic));
    });
  runCase("receipt-deleted", () => {
    const root = newFixture("receipt-deleted");
    addMaintenance(root);
    fs.unlinkSync(path.join(root, maintenanceReceiptPath));
    commit(root, "docs: remove maintenance receipt");
    assert.throws(() => inspect(root), /MAINTENANCE_RECEIPT_IMMUTABLE/);
  });
  runCase("empty-maintenance-commit", () => {
    const root = newFixture("empty-maintenance-commit");
    git(root, ["commit", "--allow-empty", "-m", maintenanceSubject]);
    addMaintenance(root);
    assert.throws(() => inspect(root), /MAINTENANCE_RECEIPT_IMMUTABLE/);
  });
  runCase("phase14-start-binding", () => {
    const root = newFixture("phase14-start-binding", true);
    addMaintenance(root);
    const maintenance = inspect(root);
    const next = addPhase(root, maintenance);
    const resumed = inspect(root);
    const inputs = { ...next.inputs, phase: 14, phaseStartCommit: next.metadata };
    const args = {
      phase: 14,
      receipt: inputs,
      plan: next.plan,
      evidence: next.evidence,
      previousMetadataCommit: next.metadata,
    };
    resumed.validatePhaseInputs(args);
    for (const wrongStart of [
      maintenance.commit,
      next.artifact,
      next.recovery,
      maintenanceBaseMetadata,
    ]) {
      assert.throws(
        () =>
          resumed.validatePhaseInputs({
            ...args,
            receipt: { ...inputs, phaseStartCommit: wrongStart },
          }),
        /MAINTENANCE_PHASE_START/,
      );
    }
    assert.throws(
      () => resumed.validatePhaseInputs({ ...args, previousMetadataCommit: undefined }),
      /MAINTENANCE_PHASE_START/,
    );
    observations.push({
      case: "phase14-start-binding",
      previousMetadataCommit: next.metadata,
      rejectedStarts: [maintenance.commit, next.artifact, next.recovery, maintenanceBaseMetadata],
      scope: "Real isolated Git objects; phase input validation only, not Phase014 acceptance",
    });
  });
  runCase("phase13-continuation", () => {
    const root = newFixture("phase13-continuation", true);
    addMaintenance(root);
    const maintenance = inspect(root);
    const next = addPhase(root, maintenance);
    const resumed = inspect(root);
    assert.equal(resumed.admissionOnly, false);
    assert.equal(resumed.phaseStartIndex(13, 0), 2);
    resumed.validatePhaseInputs({
      phase: 13,
      receipt: next.inputs,
      plan: next.plan,
      evidence: next.evidence,
    });
    for (const [name, mutate, diagnostic] of [
      [
        "missing-maintenance-binding",
        (value) => {
          delete value.inputs.checkpointMaintenance;
        },
        "MAINTENANCE_INPUT_BINDING",
      ],
      [
        "wrong-policy-binding",
        (value) => {
          value.inputs.validationPolicy.sha256 = "0".repeat(64);
        },
        "MAINTENANCE_POLICY_BINDING",
      ],
      [
        "wrong-phase-start",
        (value) => {
          value.inputs.phaseStartCommit = maintenanceBaseMetadata;
        },
        "MAINTENANCE_PHASE_START",
      ],
      [
        "missing-policy-source",
        (value) => {
          value.plan.sourcePaths = value.plan.sourcePaths.filter(
            (file) => file !== maintenancePolicyPath,
          );
        },
        "MAINTENANCE_POLICY_SOURCE",
      ],
      [
        "missing-policy-input",
        (value) => {
          value.evidence.inputs = value.evidence.inputs.filter(
            (input) => input.path !== maintenancePolicyPath,
          );
        },
        "MAINTENANCE_POLICY_INPUT",
      ],
    ]) {
      const altered = structuredClone(next);
      mutate(altered);
      assert.throws(
        () =>
          resumed.validatePhaseInputs({
            phase: 13,
            receipt: altered.inputs,
            plan: altered.plan,
            evidence: altered.evidence,
          }),
        new RegExp(diagnostic),
        name,
      );
      observations.push({ case: name, status: "EXPECTED_REJECTION" });
    }
    validate(root, 13, { fixture: true, metadataCommit: next.metadata, admissionOnly: false });
    // The same synthetic review must never be accepted as a real phase seal.
    validate(root, 13, { diagnostic: "REVIEW_IDENTITY" });
  });
  runCase("artifact-metadata-interposition", () => {
    const root = newFixture("artifact-metadata-interposition", true);
    addMaintenance(root);
    addPhase(root, inspect(root), { interpose: true });
    validate(root, 13, { fixture: true, diagnostic: "COMMIT_SUBJECT" });
  });
  runCase("phase13-seal-before-execution-maintenance", () => {
    const root = newFixture(
      "phase13-seal-before-execution-maintenance",
      true,
      executionBaseMetadata,
    );
    assert.equal(inspect(root).admissionOnly, false);
    validate(root, 13, { metadataCommit: executionBaseMetadata, admissionOnly: false });
  });
  runCase("execution-maintenance-admission", () => {
    const root = newFixture("execution-maintenance-admission", true, executionBaseMetadata);
    const id = addExecutionMaintenance(root);
    const maintenance = inspect(root);
    assert.equal(maintenance.maintenanceHead, id);
    assert.equal(maintenance.executionMaintenance.commit, id);
    assert.equal(maintenance.baseMetadataCommit, executionBaseMetadata);
    assert.deepEqual(json(root, executionMaintenanceReceiptPath).localGuides, []);
    assert.equal(
      gitText(root, [
        "diff",
        "--name-only",
        executionBaseMetadata,
        id,
        "--",
        "docs/evidence/",
        "docs/phase-plans/",
        "docs/roadmap-run.json",
        maintenanceReceiptPath,
        maintenancePolicyPath,
      ]),
      "",
    );
    validate(root, 13, { metadataCommit: executionBaseMetadata, admissionOnly: true });
  });
  runCase("execution-maintenance-wrong-anchor", () => {
    const root = newFixture("execution-maintenance-wrong-anchor", false, executionBaseMetadata);
    addExecutionMaintenance(root, (receipt) => {
      receipt.baseMetadataCommit = executionBaseArtifact;
    });
    assert.throws(() => inspect(root), /MAINTENANCE_ANCHOR/);
  });
  runCase("execution-maintenance-forbidden-files", () => {
    for (const [index, file] of [
      "src/forbidden-maintenance.ts",
      "docs/evidence/Phase013-gate.json",
      maintenancePolicyPath,
      maintenanceReceiptPath,
    ].entries()) {
      const root = newFixture(
        `execution-maintenance-forbidden-${index}`,
        false,
        executionBaseMetadata,
      );
      addExecutionMaintenance(root, undefined, () => {
        if (file.endsWith(".json"))
          write(root, file, `${JSON.stringify(json(root, file), null, 4)}\n`);
        else {
          const original = fs.existsSync(path.join(root, file))
            ? read(root, file).toString("utf8")
            : "";
          write(root, file, `${original.trimEnd()}\n/* Invalid maintenance fixture change. */\n`);
        }
      });
      assert.throws(() => inspect(root), /MAINTENANCE_(SCOPE|POLICY_IMMUTABLE|RECEIPT_IMMUTABLE)/);
    }
  });
  runCase("execution-maintenance-receipt-digests", () => {
    for (const field of ["beforeSha256", "afterSha256"]) {
      const root = newFixture(`execution-maintenance-${field}`, false, executionBaseMetadata);
      addExecutionMaintenance(root, (receipt) => {
        receipt.changes[0][field] = "0".repeat(64);
      });
      assert.throws(() => inspect(root), /MAINTENANCE_(BEFORE|AFTER)_HASH/);
    }
  });
  runCase("execution-maintenance-policy-rewritten", () => {
    const root = newFixture("execution-maintenance-policy-rewritten", false, executionBaseMetadata);
    addExecutionMaintenance(root);
    write(
      root,
      executionPolicyPath,
      Buffer.concat([
        read(root, executionPolicyPath),
        Buffer.from("\n<!-- Invalid policy rewrite fixture. -->\n"),
      ]),
    );
    commit(root, "docs: invalid policy rewrite fixture");
    assert.throws(() => inspect(root), /MAINTENANCE_POLICY_IMMUTABLE/);
  });
  runCase("execution-maintenance-tail-rejected", () => {
    const root = newFixture("execution-maintenance-tail-rejected", false, executionBaseMetadata);
    addExecutionMaintenance(root);
    write(root, "docs/unlisted-tail.md", "Unauthorized fixture tail.\n");
    commit(root, "docs: unlisted follow-up fixture");
    assert.throws(() => inspect(root), /MAINTENANCE_TAIL/);
  });
  runCase("execution-maintenance-phase14-continuation", () => {
    const root = newFixture(
      "execution-maintenance-phase14-continuation",
      true,
      executionBaseMetadata,
    );
    const maintenanceCommit = addExecutionMaintenance(root);
    const next = addPhase(root, inspect(root), { phase: 14 });
    const maintenance = inspect(root);
    const args = {
      phase: 14,
      receipt: next.inputs,
      plan: next.plan,
      evidence: next.evidence,
      previousMetadataCommit: executionBaseMetadata,
    };
    maintenance.validatePhaseInputs(args);
    const history = gitText(root, [
      "rev-list",
      "--reverse",
      `${maintenanceBaseArtifact}..HEAD`,
    ]).split("\n");
    assert.equal(
      maintenance.phaseStartIndex(14, history.indexOf(executionBaseMetadata)),
      history.indexOf(maintenanceCommit) + 1,
    );
    assert.equal(
      maintenance.phaseStartIndex(15, history.indexOf(next.metadata)),
      history.indexOf(next.metadata) + 1,
    );
    for (const mutate of [
      (value) => {
        delete value.receipt.executionMaintenance;
      },
      (value) => {
        value.receipt.executionMaintenance.sha256 = "0".repeat(64);
      },
      (value) => {
        value.receipt.executionPolicy.sha256 = "0".repeat(64);
      },
      (value) => {
        value.receipt.phaseStartCommit = executionBaseMetadata;
      },
      (value) => {
        value.receipt.phaseStartCommit = maintenance.commit;
      },
      (value) => {
        value.plan.sourcePaths = value.plan.sourcePaths.filter(
          (file) => file !== executionPolicyPath,
        );
      },
      (value) => {
        value.evidence.inputs = value.evidence.inputs.filter(
          (input) => input.path !== executionPolicyPath,
        );
      },
    ]) {
      const changed = structuredClone(args);
      mutate(changed);
      assert.throws(
        () => maintenance.validatePhaseInputs(changed),
        /MAINTENANCE_(INPUT_BINDING|POLICY_BINDING|PHASE_START|POLICY_SOURCE|POLICY_INPUT)/,
      );
    }
    const future = {
      ...args,
      phase: 15,
      previousMetadataCommit: next.metadata,
      receipt: { ...next.inputs, phaseStartCommit: next.metadata },
    };
    maintenance.validatePhaseInputs(future);
    assert.throws(
      () =>
        maintenance.validatePhaseInputs({
          ...future,
          receipt: { ...future.receipt, phaseStartCommit: maintenanceCommit },
        }),
      /MAINTENANCE_PHASE_START/,
    );
    validate(root, 14, { fixture: true, metadataCommit: next.metadata, admissionOnly: false });
    validate(root, 14, { diagnostic: "REVIEW_IDENTITY" });
  });
  assert(cases.length > 0, "No regression case matched");
  if (options.cases)
    assert.deepEqual(
      cases.map((entry) => entry.name).sort(),
      [...options.cases].sort(),
      "Some selected regression cases did not run",
    );
  report = {
    status: "PASS",
    scope: "ISOLATED_PHASE012_PHASE013_MAINTENANCE_PROTOCOL_REGRESSION",
    sourceRepositoryIndexMutated: false,
    network: "LOCAL_FILESYSTEM_ONLY",
    independentReviewPerformed: false,
    syntheticPhase13IsProductAcceptance: false,
    syntheticPhase14IsProductAcceptance: false,
    sourceHashes: Object.fromEntries(
      [
        "scripts/checkpoint-maintenance.mjs",
        "scripts/test-checkpoint-maintenance.mjs",
        "scripts/validate-phase.mjs",
        "scripts/test-validate-phase.mjs",
      ].map((file) => [file, hashFile(sourceRoot, file)]),
    ),
    shells,
    caseCount: cases.length,
    cases,
    observations,
    durationMs: Math.round(performance.now() - started),
    fixtureRoot: options.keep ? temporaryRoot : null,
  };
} catch (error) {
  report = {
    status: "FAIL",
    error: error.stack || String(error),
    cases,
    observations,
    fixtureRoot: temporaryRoot,
  };
  options.keep = true;
  process.exitCode = 1;
} finally {
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!options.keep) {
    const resolved = fs.realpathSync(temporaryRoot);
    assert(
      path.dirname(resolved) === temporaryParent &&
        path.basename(resolved).startsWith("serendipity-phase-validator-"),
      "Cleanup must remain inside the verified temporary directory",
    );
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
