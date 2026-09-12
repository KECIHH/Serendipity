import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  requireEvidenceSources,
  requireHashCoverage,
  requireReviewIdentity,
  requireReportBinding,
  requirePriorCaseBinding,
} from "./phase-evidence.mjs";
import { checkpointHistoryEnvironment, validateCheckpointImport } from "./checkpoint-history.mjs";
import { validateCheckpointMaintenance } from "./checkpoint-maintenance.mjs";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const parseJson = (bytes) => JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
const phaseName = (phase) => `Phase${String(phase).padStart(3, "0")}`;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const pinnedIds = [
  "product-requirements",
  "canonical-contract",
  "terminology",
  "state-machines",
  "testing-strategy",
  "personal-project-waivers",
  "agent-only-execution",
  "phase-gate-schema",
];
const gateFields = [
  "schemaVersion",
  "phase",
  "attemptId",
  "status",
  "simulation",
  "operatorMode",
  "environment",
  "artifactCommit",
  "requiredCaseIds",
  "results",
  "commands",
  "inputs",
  "failures",
  "generatedAt",
  "details",
];
const metadataPaths = ["docs/roadmap-run.json", "docs/phase-completion-log.md"];

function ensure(condition, code, message) {
  if (!condition) throw new Error(`${code}: ${message}`);
}

function same(actual, expected, code, message) {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    throw new Error(`${code}: ${message}`);
  }
}

function nonempty(value, code, label) {
  ensure(typeof value === "string" && value.trim().length > 0, code, label);
}

function relativeFile(value) {
  ensure(
    typeof value === "string" &&
      value.length > 0 &&
      !/[\\:"\x00-\x1f]/.test(value) &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.split("/").some((part) => ["", ".", "..", ".git"].includes(part)),
    "UNSAFE_PATH",
    `Unsafe repository file path: ${value}`,
  );
  return value;
}

function uniqueStrings(values, code, label) {
  ensure(Array.isArray(values) && values.length > 0, code, `${label} must be a nonempty array`);
  for (const value of values) nonempty(value, code, label);
  ensure(new Set(values).size === values.length, code, `${label} contains duplicates`);
  return [...values].sort();
}

function validateSchemaDefinition(schema, location = "schema") {
  ensure(object(schema), "SCHEMA_DEFINITION", `${location} must be an object`);
  const supported = [
    "$schema",
    "$id",
    "title",
    "description",
    "type",
    "additionalProperties",
    "required",
    "properties",
    "const",
    "enum",
    "minimum",
    "maximum",
    "minLength",
    "pattern",
    "items",
    "minItems",
    "maxItems",
    "uniqueItems",
    "format",
  ];
  for (const key of Object.keys(schema))
    ensure(supported.includes(key), "SCHEMA_KEYWORD", `${location}: unsupported keyword ${key}`);
  if ("type" in schema)
    ensure(
      ["object", "array", "string", "integer", "boolean"].includes(schema.type),
      "SCHEMA_DEFINITION",
      `${location}.type`,
    );
  for (const key of ["additionalProperties", "uniqueItems"]) {
    if (key in schema)
      ensure(typeof schema[key] === "boolean", "SCHEMA_DEFINITION", `${location}.${key}`);
  }
  for (const key of ["minimum", "maximum", "minLength", "minItems", "maxItems"]) {
    if (key in schema)
      ensure(Number.isInteger(schema[key]), "SCHEMA_DEFINITION", `${location}.${key}`);
  }
  for (const key of ["required", "enum"]) {
    if (key in schema)
      ensure(Array.isArray(schema[key]), "SCHEMA_DEFINITION", `${location}.${key}`);
  }
  if ("pattern" in schema) {
    ensure(typeof schema.pattern === "string", "SCHEMA_DEFINITION", `${location}.pattern`);
    new RegExp(schema.pattern);
  }
  if ("format" in schema)
    ensure(schema.format === "date-time", "SCHEMA_DEFINITION", `${location}.format`);
  if ("properties" in schema) {
    ensure(object(schema.properties), "SCHEMA_DEFINITION", `${location}.properties`);
    for (const [key, value] of Object.entries(schema.properties))
      validateSchemaDefinition(value, `${location}.${key}`);
  }
  if ("items" in schema) validateSchemaDefinition(schema.items, `${location}[]`);
}

// The pinned offline schema uses this closed keyword subset; unknown keywords fail closed.
function validateSchema(value, schema, location = "gate") {
  const types = {
    object: object(value),
    array: Array.isArray(value),
    string: typeof value === "string",
    integer: Number.isInteger(value),
    boolean: typeof value === "boolean",
  };
  if (schema.type)
    ensure(types[schema.type], "GATE_SCHEMA", `${location} must have type ${schema.type}`);
  if ("const" in schema)
    same(value, schema.const, "GATE_SCHEMA", `${location} differs from schema constant`);
  if (schema.enum)
    ensure(
      schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value)),
      "GATE_SCHEMA",
      `${location} outside enum`,
    );
  if (schema.type === "object") {
    for (const key of schema.required ?? [])
      ensure(Object.hasOwn(value, key), "GATE_SCHEMA", `${location} missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key))
        validateSchema(item, schema.properties[key], `${location}.${key}`);
      else
        ensure(
          schema.additionalProperties !== false,
          "GATE_SCHEMA",
          `${location} unknown property ${key}`,
        );
    }
  } else if (schema.type === "array") {
    if ("minItems" in schema)
      ensure(value.length >= schema.minItems, "GATE_SCHEMA", `${location} too few items`);
    if ("maxItems" in schema)
      ensure(value.length <= schema.maxItems, "GATE_SCHEMA", `${location} too many items`);
    if (schema.uniqueItems)
      ensure(
        new Set(value.map((item) => JSON.stringify(item))).size === value.length,
        "GATE_SCHEMA",
        `${location} duplicate item`,
      );
    if (schema.items)
      value.forEach((item, index) => validateSchema(item, schema.items, `${location}[${index}]`));
  } else if (schema.type === "string") {
    if ("minLength" in schema)
      ensure(value.length >= schema.minLength, "GATE_SCHEMA", `${location} too short`);
    if (schema.pattern)
      ensure(new RegExp(schema.pattern).test(value), "GATE_SCHEMA", `${location} invalid pattern`);
    if (schema.format === "date-time")
      ensure(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
          Number.isFinite(Date.parse(value)),
        "GATE_SCHEMA",
        `${location} invalid RFC3339 timestamp`,
      );
  } else if (schema.type === "integer") {
    if ("minimum" in schema)
      ensure(value >= schema.minimum, "GATE_SCHEMA", `${location} below minimum`);
    if ("maximum" in schema)
      ensure(value <= schema.maximum, "GATE_SCHEMA", `${location} above maximum`);
  }
}

export function validatePhase({
  repositoryRoot = defaultRoot,
  manifestPath,
  completedThrough = 1,
  protocolFixture = false,
} = {}) {
  ensure(
    Number.isInteger(completedThrough) && completedThrough >= 1 && completedThrough <= 137,
    "COMPLETED_THROUGH",
    "CompletedThrough must be an integer from 1 through 137",
  );
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const importedHistory = checkpointHistoryEnvironment(root);
  if (protocolFixture) {
    const fixtureParent = path.dirname(root);
    ensure(
      path.dirname(fixtureParent) === fs.realpathSync(os.tmpdir()) &&
        path.basename(fixtureParent).startsWith("serendipity-phase-validator-"),
      "PROTOCOL_FIXTURE_ROOT",
      "Protocol fixture mode is restricted to isolated temporary test repositories",
    );
  }
  const local = (relative) => path.join(root, relativeFile(relative));
  const read = (relative) => fs.readFileSync(local(relative));
  const json = (relative) => parseJson(read(relative));
  function git(args, input) {
    const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
      cwd: root,
      input,
      env: importedHistory.env,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    ensure(
      result.status === 0,
      "GIT",
      `git ${args[0]} failed: ${result.stderr?.toString("utf8").trim()}`,
    );
    return result.stdout;
  }
  const gitText = (args) => git(args).toString("utf8").trim();
  const blobCache = new Map();
  const blob = (commit, relative) => {
    const key = `${commit}:${relativeFile(relative)}`;
    if (!blobCache.has(key)) blobCache.set(key, git(["cat-file", "blob", key]));
    return blobCache.get(key);
  };
  function prefetch(commit, files) {
    const keys = [...new Set(files.map((file) => `${commit}:${relativeFile(file)}`))].filter(
      (key) => !blobCache.has(key),
    );
    if (keys.length === 0) return;
    const bytes = git(["cat-file", "--batch"], `${keys.join("\n")}\n`);
    let offset = 0;
    for (const key of keys) {
      const newline = bytes.indexOf(10, offset);
      ensure(newline >= offset, "GIT_BLOB", `Missing batch header: ${key}`);
      const header = bytes.subarray(offset, newline).toString("utf8").split(" ");
      ensure(
        header.length === 3 && header[1] === "blob",
        "GIT_BLOB",
        `Artifact file is missing: ${key}`,
      );
      const size = Number(header[2]);
      ensure(Number.isSafeInteger(size) && size >= 0, "GIT_BLOB", `Invalid blob length: ${key}`);
      offset = newline + 1;
      blobCache.set(key, bytes.subarray(offset, offset + size));
      offset += size + 1;
    }
    ensure(offset === bytes.length, "GIT_BLOB", "Unexpected trailing batch data");
  }
  const blobJson = (commit, relative) => parseJson(blob(commit, relative));
  const commitId = (value, label) => {
    ensure(
      typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value),
      "COMMIT_ID",
      `${label} must be a full Git commit id`,
    );
    ensure(
      gitText(["rev-parse", `${value}^{commit}`]) === value,
      "COMMIT_ID",
      `${label} is not a commit`,
    );
    return value;
  };
  const listTree = (commit, prefix = "") =>
    git(["ls-tree", "-rz", "--name-only", commit, ...(prefix ? ["--", prefix] : [])])
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  const changes = (commit) =>
    git([
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--name-only",
      "--no-renames",
      "-r",
      "-z",
      commit,
    ])
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  const parents = (commit) =>
    gitText(["rev-list", "--parents", "-n", "1", commit]).split(" ").slice(1);
  const layout = json("docs/project-layout.json");
  const state = json("docs/roadmap-run.json");
  const head = commitId(gitText(["rev-parse", "HEAD"]), "HEAD");
  same(
    fs.realpathSync(gitText(["rev-parse", "--show-toplevel"])),
    root,
    "ROOT_LAYOUT",
    "projectRoot must use the repositoryRoot Git history",
  );
  same(layout.layoutVersion, 2, "ROOT_LAYOUT", "Only layoutVersion 2 is supported");
  same(layout.repositoryRoot, ".", "ROOT_LAYOUT", "repositoryRoot must equal the repository root");
  same(layout.projectRoot, ".", "ROOT_LAYOUT", "projectRoot must equal repositoryRoot");
  same(
    layout.pathsRelativeTo,
    "repositoryRoot",
    "ROOT_LAYOUT",
    "Layout paths must be relative to repositoryRoot",
  );
  same(
    layout.roadmapVersionControl,
    "LOCAL_ONLY_IGNORED",
    "ROOT_LAYOUT",
    "Local roadmap must remain ignored",
  );
  const roadmapRelative = relativeFile(layout.roadmapRoot);
  const roadmap = local(roadmapRelative);
  ensure(
    path.dirname(roadmap) === root,
    "ROOT_LAYOUT",
    "roadmapRoot must be an immediate child of repositoryRoot",
  );
  for (const entry of [
    ".git",
    "project",
    "node_modules",
    ".next",
    ".scaffold",
    ...(layout.sourceDirectories ?? []),
    ...(layout.packageFiles ?? []),
  ]) {
    ensure(
      !fs.existsSync(path.join(roadmap, entry)),
      "ROADMAP_CONTENT",
      `Project entry inside roadmapRoot: ${entry}`,
    );
  }
  ensure(
    !fs.existsSync(path.join(root, "project")),
    "ROOT_LAYOUT",
    "An extra project/ wrapper is forbidden",
  );
  const trackedRoadmap = git(["ls-files", "-z", "--", `${roadmapRelative}/`]);
  ensure(
    trackedRoadmap.length === 0 && listTree(head, `${roadmapRelative}/`).length === 0,
    "ROADMAP_TRACKED",
    "Local roadmap inputs must not be tracked",
  );
  const probe = `${roadmapRelative}/Phase001.md`;
  same(
    git(["check-ignore", "--no-index", "--stdin"], `${probe}\n`).toString("utf8").trim(),
    probe,
    "ROADMAP_IGNORED",
    "roadmapRoot must be ignored",
  );
  for (const key of [
    "layoutVersion",
    "repositoryRoot",
    "projectRoot",
    "roadmapRoot",
    "pathsRelativeTo",
  ])
    same(state[key], layout[key], "RUN_LAYOUT", `Run state layout mismatch: ${key}`);
  same(state.stateVersion, 2, "RUN_LAYOUT", "stateVersion must be 2");
  const manifestFile = manifestPath
    ? path.resolve(root, manifestPath)
    : path.join(roadmap, "docs", "roadmap-execution-manifest.json");
  same(
    fs.realpathSync(manifestFile),
    fs.realpathSync(path.join(roadmap, "docs", "roadmap-execution-manifest.json")),
    "MANIFEST_ROOT",
    "Manifest must belong to this local roadmap",
  );
  const manifestBytes = fs.readFileSync(manifestFile);
  const manifest = parseJson(manifestBytes);
  const manifestHash = sha256(manifestBytes);
  for (const [key, expected] of Object.entries({
    repositoryRoot: root,
    projectRoot: root,
    roadmapRoot: roadmap,
  })) {
    nonempty(manifest[key], "MANIFEST_ROOT", `Manifest ${key} missing`);
    same(
      fs.realpathSync(
        path.resolve(path.dirname(manifestFile), manifest[key].replaceAll("\\", "/")),
      ),
      expected,
      "MANIFEST_ROOT",
      `Manifest ${key} must resolve to current layout`,
    );
  }
  same(manifest.layoutVersion, 2, "MANIFEST_ROOT", "Manifest must use layoutVersion 2");
  same(
    manifest.pathPolicy?.projectMustEqualRepositoryRoot,
    true,
    "MANIFEST_ROOT",
    "Manifest must require equal project/repository roots",
  );
  same(
    manifest.gitPolicy?.commitProtocol,
    "ARTIFACT_THEN_METADATA",
    "GIT_POLICY",
    "Commit protocol must be artifact then metadata",
  );
  same(
    manifest.gitPolicy?.repositoryMode,
    "EXISTING_REPOSITORY",
    "GIT_POLICY",
    "Existing Git repository must be reused",
  );
  same(manifest.gitPolicy?.initialBranch, "main", "GIT_POLICY", "Initial branch must be main");
  same(manifest.gitPolicy?.remoteName, "origin", "GIT_POLICY", "Remote must be origin");
  same(
    manifest.gitPolicy?.remoteUrl,
    "https://github.com/KECIHH/Serendipity.git",
    "GIT_POLICY",
    "Wrong project remote URL",
  );
  same(
    manifest.gitPolicy?.pushAfterSeal,
    true,
    "GIT_POLICY",
    "Push after seal must remain required",
  );
  same(
    manifest.gitPolicy?.metadataCommit?.allowedExactPaths?.slice().sort(),
    metadataPaths.slice().sort(),
    "GIT_POLICY",
    "Metadata exact paths changed",
  );
  same(
    manifest.gitPolicy?.metadataCommit?.allowedPathPrefixes,
    ["docs/evidence/"],
    "GIT_POLICY",
    "Metadata prefixes changed",
  );
  same(gitText(["branch", "--show-current"]), "main", "GIT_BRANCH", "Phase001 remains on main");
  for (const args of [
    ["remote", "get-url", "--all", "origin"],
    ["remote", "get-url", "--push", "--all", "origin"],
  ])
    same(
      gitText(args),
      manifest.gitPolicy.remoteUrl,
      "GIT_REMOTE",
      "Origin fetch/push URL must match manifest",
    );
  for (const [key, expected] of Object.entries({
    roadmapId: "traceme-roadmap-v2-new-build",
    executionMode: "NEW_BUILD",
    operatorMode: "AGENT_ONLY_AUTOMATED_NEW_BUILD",
  })) {
    same(manifest[key], expected, "RUN_MODE", `Manifest ${key} mismatch`);
    same(state[key], expected, "RUN_MODE", `Run state ${key} mismatch`);
  }
  same(
    state.manifestHash,
    manifestHash,
    "MANIFEST_HASH",
    "Run state manifestHash differs from local frozen manifest",
  );
  same(
    uniqueStrings(
      manifest.runStatePinnedInputs?.map((input) => input.id),
      "PINNED_INPUTS",
      "runStatePinnedInputs",
    ),
    [...pinnedIds].sort(),
    "PINNED_INPUTS",
    "All eight run-state pinned inputs are required",
  );
  same(
    Object.keys(state.contractHashes ?? {}).sort(),
    [...pinnedIds].sort(),
    "PINNED_INPUTS",
    "Run state contractHashes must cover exactly eight inputs",
  );
  for (const input of manifest.runStatePinnedInputs)
    same(
      state.contractHashes[input.id],
      sha256(fs.readFileSync(path.join(roadmap, relativeFile(input.path)))),
      "PINNED_HASH",
      `Run state contract hash mismatch: ${input.id}`,
    );
  const schema = parseJson(fs.readFileSync(path.join(roadmap, "docs", "phase-gate.schema.json")));
  validateSchemaDefinition(schema);
  same(schema.additionalProperties, false, "SCHEMA_DEFINITION", "Gate top level must be closed");
  same(
    [...schema.required].sort(),
    [...gateFields].sort(),
    "SCHEMA_DEFINITION",
    "Gate schema required fields changed",
  );
  const baseline = commitId(state.executionBaselineCommit, "executionBaselineCommit");
  same(
    state.baselineCommit,
    baseline,
    "BASELINE",
    "baselineCommit must equal executionBaselineCommit",
  );
  const checkpointImport = validateCheckpointImport({
    root,
    state,
    head,
    git,
    blob,
    prefetch,
    receipt: importedHistory.receipt,
    receiptHash: importedHistory.receiptHash,
  });
  const currentHistoryBaseline = checkpointImport?.currentHistoryBaselineCommit ?? baseline;
  const currentCommit = checkpointImport?.currentCommit ?? ((value) => value);
  git(["merge-base", "--is-ancestor", currentHistoryBaseline, head]);
  const initialState = blobJson(baseline, "docs/roadmap-run.json");
  const initialLayout = blobJson(baseline, "docs/project-layout.json");
  same(
    initialState.completedThrough,
    0,
    "BASELINE",
    "Execution baseline must precede new-layout Phase001",
  );
  same(
    initialState.currentPhase,
    1,
    "BASELINE",
    "Execution baseline must import completed Phase000",
  );
  same(
    initialState.currentLayoutPhaseSeal,
    null,
    "BASELINE",
    "Execution baseline must have no current-layout seal",
  );
  same(
    initialState.historicalCheckpoint,
    state.historicalCheckpoint,
    "HISTORY_REFERENCE",
    "Imported historical checkpoint changed",
  );
  same(initialLayout, layout, "ROOT_LAYOUT", "Root layout changed after execution baseline");
  ensure(
    listTree(baseline, `${roadmapRelative}/`).length === 0,
    "ROADMAP_TRACKED",
    "New-layout baseline must not track local roadmap inputs",
  );

  function validateGate(evidence, checkpoint, gateSchema, prefix = "", historical = false) {
    validateSchema(evidence, gateSchema);
    same(evidence.phase, checkpoint.phase, "GATE_PHASE", "Gate phase differs from checkpoint");
    same(
      evidence.artifactCommit,
      checkpoint.artifactCommit,
      "GATE_ARTIFACT",
      "Gate artifact differs from checkpoint",
    );
    const artifact = commitId(checkpoint.artifactCommit, "checkpoint artifact");
    prefetch(
      artifact,
      [
        evidence.details.planPath,
        evidence.details.reviewReportPath,
        ...evidence.inputs.map((input) => input.path),
        ...evidence.results.flatMap((result) => [
          result.details.inputPath,
          result.details.outputPath,
        ]),
      ].map((file) => `${prefix}${relativeFile(file)}`),
    );
    const artifactBlob = (file) => blob(artifact, `${prefix}${relativeFile(file)}`);
    const artifactJson = (file) => parseJson(artifactBlob(file));
    const ids = uniqueStrings(evidence.requiredCaseIds, "REQUIRED_CASES", "Gate requiredCaseIds");
    same(
      uniqueStrings(
        evidence.results.map((result) => result.testCaseId),
        "RESULT_CASES",
        "Gate results",
      ),
      ids,
      "RESULT_CASES",
      "Results must exactly match requiredCaseIds",
    );
    same(
      evidence.details.testedTree,
      gitText(["rev-parse", `${artifact}^{tree}`]),
      "TESTED_TREE",
      "Evidence testedTree differs from artifact tree",
    );
    const planPath = `docs/phase-plans/${phaseName(checkpoint.phase)}.json`;
    same(
      evidence.details.planPath,
      planPath,
      "PLAN_PATH",
      "Gate must reference the canonical phase plan",
    );
    same(
      sha256(artifactBlob(planPath)),
      evidence.details.planHash,
      "PLAN_HASH",
      "Plan hash differs from artifact bytes",
    );
    const plan = artifactJson(planPath);
    same(plan.phase, checkpoint.phase, "PLAN_PHASE", "Plan phase mismatch");
    same(plan.attemptId, evidence.attemptId, "PLAN_ATTEMPT", "Plan attempt mismatch");
    same(
      uniqueStrings(plan.requiredCaseIds, "PLAN_CASES", "Plan requiredCaseIds"),
      ids,
      "PLAN_CASES",
      "Gate requiredCaseIds differs from frozen plan",
    );
    same(
      uniqueStrings(
        plan.cases?.map((item) => item.testCaseId),
        "PLAN_CASES",
        "Plan cases",
      ),
      ids,
      "PLAN_CASES",
      "Plan cases must exactly cover requiredCaseIds",
    );
    if (!historical) {
      nonempty(plan.producer, "PLAN_SCOPE", "Plan producer missing");
      ensure(
        Array.isArray(plan.consumers) &&
          plan.consumers.length > 0 &&
          new Set(plan.consumers).size === plan.consumers.length &&
          plan.consumers.every(
            (consumer) =>
              (typeof consumer === "string" && consumer.trim()) ||
              (Number.isInteger(consumer) && consumer >= 0 && consumer <= 137),
          ),
        "PLAN_SCOPE",
        "Plan consumers must contain unique phase numbers or names",
      );
      nonempty(plan.scope, "PLAN_SCOPE", "Plan scope missing");
      uniqueStrings(plan.modificationScope, "PLAN_SCOPE", "Plan modificationScope");
      same(plan.threshold?.waived, false, "THRESHOLD", "Plan cannot waive thresholds");
      same(
        plan.threshold?.automatedThreshold,
        plan.threshold?.originalThreshold,
        "THRESHOLD",
        "Plan automatic threshold differs from original",
      );
      ensure(
        Number.isFinite(plan.threshold?.originalThreshold) && plan.threshold.originalThreshold > 0,
        "THRESHOLD",
        "Plan original threshold must be positive",
      );
      same(evidence.details.waived, false, "THRESHOLD", "Gate cannot waive thresholds");
      same(
        evidence.details.originalThreshold,
        plan.threshold.originalThreshold,
        "THRESHOLD",
        "Gate original threshold differs from plan",
      );
      same(
        evidence.details.automatedThreshold,
        plan.threshold.automatedThreshold,
        "THRESHOLD",
        "Gate automatic threshold differs from plan",
      );
    }
    for (const previous of plan.previousAttempts ?? []) {
      same(
        sha256(artifactBlob(previous.planPath)),
        previous.planHash,
        "PRIOR_PLAN_HASH",
        "Previous plan hash changed",
      );
      const old = artifactJson(previous.planPath);
      same(old.phase, plan.phase, "PRIOR_PLAN_PHASE", "Previous plan belongs to another phase");
      same(
        old.attemptId,
        previous.attemptId,
        "PRIOR_PLAN_ATTEMPT",
        "Previous plan attempt mismatch",
      );
      ensure(
        old.attemptId !== plan.attemptId,
        "PRIOR_PLAN_ATTEMPT",
        "Current attempt cannot be its own previous attempt",
      );
      requirePriorCaseBinding(plan, old, {
        readJson: artifactJson,
        hashFile: (file) => sha256(artifactBlob(file)),
      });
      ensure(
        plan.threshold?.originalThreshold >= old.threshold?.originalThreshold,
        "PRIOR_PLAN_THRESHOLD",
        "Previous threshold was reduced",
      );
    }
    const inputMap = new Map();
    for (const input of evidence.inputs) {
      ensure(!inputMap.has(input.path), "INPUT_PATHS", "Evidence input paths must be unique");
      same(
        sha256(artifactBlob(input.path)),
        input.sha256,
        "INPUT_HASH",
        `Evidence input hash differs from artifact file: ${input.path}`,
      );
      inputMap.set(input.path, input.sha256);
    }
    if (!historical)
      ensure(inputMap.has(planPath), "INPUT_PATHS", "Gate inputs must include the frozen plan");
    for (const result of evidence.results) {
      const item = plan.cases.find((candidate) => candidate.testCaseId === result.testCaseId);
      ensure(
        Number.isInteger(item.denominator) && item.denominator > 0,
        "DENOMINATOR",
        "Frozen denominator must be a positive integer",
      );
      same(
        result.command,
        item.command,
        "CASE_COMMAND",
        "Evidence command differs from frozen plan",
      );
      same(
        result.denominator,
        item.denominator,
        "DENOMINATOR",
        "Evidence denominator differs from frozen plan",
      );
      same(
        result.numerator,
        result.denominator,
        "COVERAGE",
        "Required case has incomplete coverage",
      );
      ensure(
        result.status === "PASS" && result.exitCode === 0,
        "CASE_FAILED",
        "Every required result must pass with exit 0",
      );
      ensure(
        evidence.commands.some(
          (command) => command.command === result.command && command.exitCode === 0,
        ),
        "COMMANDS",
        "Result command missing from commands",
      );
      if (!historical)
        nonempty(item.expected, "PLAN_EXPECTED", "Every frozen case needs expected assertions");
      for (const kind of ["input", "output"]) {
        const file = item[`${kind}Path`];
        same(result.details[`${kind}Path`], file, "CASE_PATH", "Result path differs from plan");
        same(
          result[`${kind}Hash`],
          `sha256:${sha256(artifactBlob(file))}`,
          `${kind.toUpperCase()}_HASH`,
          `Evidence ${kind} hash differs from artifact file: ${file}`,
        );
      }
      ensure(
        inputMap.has(item.inputPath),
        "INPUT_PATHS",
        `Case input absent from Gate inputs: ${item.inputPath}`,
      );
    }
    ensure(
      evidence.commands.every((command) => command.exitCode === 0),
      "COMMANDS",
      "Gate contains a failed command",
    );
    const review = artifactJson(evidence.details.reviewReportPath);
    same(
      sha256(artifactBlob(evidence.details.reviewReportPath)),
      evidence.details.reviewReportHash,
      "REVIEW_HASH",
      "Review hash differs from artifact bytes",
    );
    same(
      review.reviewerRunId,
      evidence.details.reviewerRunId,
      "REVIEW_BINDING",
      "Review reviewerRunId mismatch",
    );
    same(
      review.planHash,
      evidence.details.planHash,
      "REVIEW_BINDING",
      "Review does not bind frozen plan",
    );
    same(review.decision, "PASS", "REVIEW_DECISION", "Independent review decision must be PASS");
    nonempty(review.contextId, "REVIEW_IDENTITY", "Review contextId is required");
    for (const field of historical ? ["sourceHashes", "reportHashes"] : []) {
      if (!Object.hasOwn(review, field)) continue;
      ensure(
        object(review[field]),
        "REVIEW_FILE_HASH",
        `Review ${field} must be a path/hash object`,
      );
      prefetch(
        artifact,
        Object.keys(review[field]).map((file) => `${prefix}${relativeFile(file)}`),
      );
      for (const [file, expected] of Object.entries(review[field])) {
        ensure(
          typeof expected === "string" && /^[0-9a-f]{64}$/.test(expected),
          "REVIEW_FILE_HASH",
          `Invalid declared review hash: ${file}`,
        );
        same(
          sha256(artifactBlob(file)),
          expected,
          "REVIEW_FILE_HASH",
          `Review ${field} differs from artifact bytes: ${file}`,
        );
      }
    }
    if (!historical) {
      same(review.phase, checkpoint.phase, "REVIEW_BINDING", "Review phase mismatch");
      same(review.attemptId, evidence.attemptId, "REVIEW_BINDING", "Review attempt mismatch");
      same(review.planPath, planPath, "REVIEW_BINDING", "Review planPath mismatch");
      nonempty(review.generatedBy, "REVIEW_IDENTITY", "Review generatedBy is required");
      // A temporary fixture may extend genuine sealed history with a synthetic next phase.
      // Genuine historical reviews still receive the normal identity/source checks.
      const syntheticFixture =
        protocolFixture &&
        review.runnerIdentity?.kind === "SYNTHETIC_PROTOCOL_FIXTURE_NOT_AGENT_REVIEW";
      requireReviewIdentity(review, plan.implementationContextId, {
        protocolFixture: syntheticFixture,
      });
      const sources = requireEvidenceSources(plan, { protocolFixture: syntheticFixture });
      prefetch(
        artifact,
        sources.map((file) => `${prefix}${relativeFile(file)}`),
      );
      const hashFile = (file) => sha256(artifactBlob(file));
      requireHashCoverage(review.sourceHashes, sources, hashFile, "REVIEW_FILE_HASH");
      requireHashCoverage(
        review.reportHashes,
        plan.cases.map((item) => item.outputPath),
        hashFile,
        "REVIEW_FILE_HASH",
      );
      for (const item of plan.cases)
        requireReportBinding(
          artifactJson(item.outputPath),
          item,
          evidence.details.planHash,
          sources,
          hashFile,
        );
      ensure(
        Array.isArray(review.issues) && Array.isArray(review.dispositions),
        "REVIEW_ISSUES",
        "Review issues and dispositions must be arrays",
      );
      for (const issue of review.issues)
        ensure(
          issue.status === "RESOLVED" ||
            review.dispositions.some(
              (entry) => entry.issueId === issue.id && entry.status === "RESOLVED",
            ),
          "REVIEW_ISSUES",
          "Review has an unresolved issue",
        );
    }
    return { plan, artifactBlob, artifactJson };
  }

  const historical = state.historicalCheckpoint;
  same(historical.phase, 0, "HISTORY_REFERENCE", "Imported history must be Phase000");
  same(
    historical.appliesToLayoutVersion,
    1,
    "HISTORY_REFERENCE",
    "Old seal only applies to historical layout",
  );
  same(
    historical.metadataCommit,
    layout.history.sourceCommit,
    "HISTORY_REFERENCE",
    "Historical metadata differs from layout source",
  );
  same(
    historical.archiveRoot,
    layout.history.archiveProjectRoot,
    "HISTORY_REFERENCE",
    "Historical archive root mismatch",
  );
  same(
    historical.projectGitPrefix,
    `${layout.history.sourceProjectRoot}/`,
    "HISTORY_REFERENCE",
    "Historical Git prefix mismatch",
  );
  const oldArtifact = commitId(historical.artifactCommit, "historical artifact");
  const oldMetadata = commitId(historical.metadataCommit, "historical metadata");
  same(
    parents(oldMetadata),
    [oldArtifact],
    "HISTORY_PARENT",
    "Historical metadata must directly follow its artifact",
  );
  git(["merge-base", "--is-ancestor", historical.baselineCommit, oldArtifact]);
  git(["merge-base", "--is-ancestor", oldMetadata, baseline]);
  const oldFiles = listTree(oldMetadata, historical.projectGitPrefix);
  same(
    oldFiles.length,
    layout.history.trackedFileCount,
    "HISTORY_FILES",
    "Historical file count changed",
  );
  const archiveFiles = listTree(head, `${historical.archiveRoot}/docs/`);
  same(
    archiveFiles.sort(),
    oldFiles
      .map((file) => `${historical.archiveRoot}/${file.slice(historical.projectGitPrefix.length)}`)
      .sort(),
    "HISTORY_FILES",
    "Historical archive file set changed",
  );
  prefetch(oldMetadata, oldFiles);
  prefetch(head, archiveFiles);
  for (const file of oldFiles) {
    const archived = `${historical.archiveRoot}/${file.slice(historical.projectGitPrefix.length)}`;
    const expected = sha256(blob(oldMetadata, file));
    same(
      sha256(read(archived)),
      expected,
      "HISTORY_BYTES",
      `Historical archive bytes changed: ${archived}`,
    );
    same(
      sha256(blob(head, archived)),
      expected,
      "HISTORY_BYTES",
      `Committed archive bytes changed: ${archived}`,
    );
  }
  const oldState = json(historical.runStatePath);
  same(
    oldState.lastArtifactCommit,
    oldArtifact,
    "HISTORY_REFERENCE",
    "Archived run artifact mismatch",
  );
  same(
    oldState.baselineCommit,
    historical.baselineCommit,
    "HISTORY_REFERENCE",
    "Archived run baseline mismatch",
  );
  same(
    oldState.checkpoints.length,
    1,
    "HISTORY_REFERENCE",
    "Archived run must contain original Phase000 checkpoint",
  );
  same(
    oldState.checkpoints[0].evidenceHash,
    historical.evidenceHash,
    "HISTORY_HASH",
    "Historical checkpoint evidence hash mismatch",
  );
  same(
    sha256(read(historical.evidencePath)),
    historical.evidenceHash,
    "HISTORY_HASH",
    "Historical Gate bytes differ",
  );
  const oldRoadmapPrefix = `${path.posix.dirname(layout.history.sourceProjectRoot)}/`;
  const oldManifestBytes = blob(
    historical.baselineCommit,
    `${oldRoadmapPrefix}docs/roadmap-execution-manifest.json`,
  );
  const oldManifest = parseJson(oldManifestBytes);
  same(
    sha256(oldManifestBytes),
    oldState.manifestHash,
    "HISTORY_PINNED",
    "Historical manifest hash changed",
  );
  prefetch(
    historical.baselineCommit,
    oldManifest.runStatePinnedInputs.map((input) => `${oldRoadmapPrefix}${input.path}`),
  );
  for (const input of oldManifest.runStatePinnedInputs)
    same(
      sha256(blob(historical.baselineCommit, `${oldRoadmapPrefix}${input.path}`)),
      oldState.contractHashes[input.id],
      "HISTORY_PINNED",
      `Historical input mismatch: ${input.id}`,
    );
  const oldSchema = blobJson(
    historical.baselineCommit,
    `${oldRoadmapPrefix}docs/phase-gate.schema.json`,
  );
  validateSchemaDefinition(oldSchema);
  validateGate(
    json(historical.evidencePath),
    oldState.checkpoints[0],
    oldSchema,
    historical.projectGitPrefix,
    true,
  );
  ensure(
    gitText([
      "log",
      "--format=%H",
      `${currentHistoryBaseline}..HEAD`,
      "--",
      `${historical.archiveRoot}/`,
    ]) === "",
    "HISTORY_IMMUTABLE",
    "Historical archive was modified after execution baseline",
  );

  same(
    state.completedThrough,
    completedThrough,
    "RUN_PROGRESS",
    "Run completedThrough differs from requested seal",
  );
  same(
    state.currentPhase,
    completedThrough + 1,
    "RUN_PROGRESS",
    "Run currentPhase must follow completedThrough",
  );
  same(
    state.progressSource,
    "CURRENT_LAYOUT_CHECKPOINT",
    "RUN_PROGRESS",
    "Run must use current-layout checkpoint progress",
  );
  ensure(Array.isArray(state.checkpoints), "CHECKPOINTS", "Run checkpoints must be an array");
  same(
    state.checkpoints.map((entry) => entry.phase),
    Array.from({ length: completedThrough }, (_, index) => index + 1),
    "CHECKPOINTS",
    "New-layout checkpoints must cover phases 1..completedThrough exactly",
  );
  same(
    state.lastArtifactCommit,
    state.checkpoints.at(-1).artifactCommit,
    "CHECKPOINT_ARTIFACT",
    "lastArtifactCommit must reference the final checkpoint",
  );
  same(
    state.currentLayoutPhaseSeal,
    state.checkpoints.at(-1),
    "CHECKPOINTS",
    "currentLayoutPhaseSeal must match final checkpoint",
  );
  const history = gitText([
    "log",
    "--reverse",
    "--topo-order",
    "--format=%H%x09%P%x09%s",
    `${currentHistoryBaseline}..HEAD`,
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, parentText, subject] = line.split("\t");
      return { id, parents: parentText.split(" "), subject };
    });
  let priorCommit = currentHistoryBaseline;
  for (const entry of history) {
    same(
      entry.parents,
      [priorCommit],
      "HISTORY_LINEAR",
      "Phase history must be linear without merge commits",
    );
    priorCommit = entry.id;
  }
  const checkpointMaintenance = validateCheckpointMaintenance({
    root,
    state,
    head,
    history,
    git,
    blob,
  });
  let previousMetadataIndex = -1;
  let firstReceipt;
  for (const checkpoint of state.checkpoints) {
    const n = checkpoint.phase;
    const name = phaseName(n);
    const gatePath = `docs/evidence/${name}-gate.json`;
    same(
      checkpoint.evidencePath,
      gatePath,
      "GATE_PATH",
      "Checkpoint must reference canonical Gate path",
    );
    ensure(
      typeof checkpoint.evidenceHash === "string" && /^[0-9a-f]{64}$/.test(checkpoint.evidenceHash),
      "EVIDENCE_HASH",
      "Checkpoint evidenceHash invalid",
    );
    same(
      sha256(read(gatePath)),
      checkpoint.evidenceHash,
      "EVIDENCE_HASH",
      "Checkpoint evidenceHash mismatch",
    );
    same(
      sha256(blob(head, gatePath)),
      checkpoint.evidenceHash,
      "EVIDENCE_HASH",
      "Committed Gate hash mismatch",
    );
    const evidence = json(gatePath);
    const { plan, artifactBlob, artifactJson } = validateGate(evidence, checkpoint, schema);
    const receiptPath = `docs/phase-plans/${name}-inputs.json`;
    const receipt = artifactJson(receiptPath);
    checkpointMaintenance?.validatePhaseInputs({
      phase: n,
      receipt,
      plan,
      evidence,
      previousMetadataCommit: history[previousMetadataIndex]?.id,
    });
    ensure(
      evidence.inputs.some(
        (input) => input.path === receiptPath && input.sha256 === sha256(artifactBlob(receiptPath)),
      ),
      "RECEIPT_HASH",
      "Gate must bind the committed input receipt",
    );
    same(receipt.layoutVersion, 2, "RECEIPT_BASELINE", "Input receipt must use layoutVersion 2");
    same(
      receipt.executionBaselineCommit,
      baseline,
      "RECEIPT_BASELINE",
      "Input receipt execution baseline mismatch",
    );
    same(receipt.baselineCommit, baseline, "RECEIPT_BASELINE", "Input receipt baseline mismatch");
    same(
      receipt.manifestHash,
      manifestHash,
      "RECEIPT_HASH",
      "Input receipt manifest hash mismatch",
    );
    if (checkpointImport && n >= checkpointImport.startPhase) {
      same(
        receipt.checkpointMigration,
        {
          path: "docs/checkpoint-migrations/history-20260909.json",
          sha256: checkpointImport.receiptHash,
          continuationBaselineCommit: checkpointImport.continuationBaselineCommit,
          importedThrough: 2,
        },
        "IMPORT_RECEIPT_BINDING",
        "Current phase receipt must bind the history import",
      );
      git([
        "merge-base",
        "--is-ancestor",
        checkpointImport.continuationBaselineCommit,
        receipt.phaseStartCommit,
      ]);
    }
    if (n === 1) {
      for (const key of ["head", "originMain"])
        same(
          receipt.preflight?.[key],
          baseline,
          "PREFLIGHT",
          `Preflight ${key} must prove synchronized baseline`,
        );
      same(
        receipt.preflight?.porcelain,
        "",
        "PREFLIGHT",
        "Preflight worktree must have been clean",
      );
      same(receipt.preflight?.branch, "main", "PREFLIGHT", "Preflight branch must be main");
      same(
        receipt.preflight?.remote,
        manifest.gitPolicy.remoteUrl,
        "PREFLIGHT",
        "Preflight remote mismatch",
      );
    }
    uniqueStrings(
      receipt.pinnedInputs?.map((input) => input.id),
      "RECEIPT_INPUTS",
      "Receipt pinned input ids",
    );
    uniqueStrings(
      receipt.pinnedInputs.map((input) => input.path),
      "RECEIPT_INPUTS",
      "Receipt pinned input paths",
    );
    const pinnedPaths = receipt.pinnedInputs.map((input) => relativeFile(input.path));
    same(
      git(["check-ignore", "--no-index", "-z", "--stdin"], `${pinnedPaths.join("\0")}\0`)
        .toString("utf8")
        .split("\0")
        .filter(Boolean),
      pinnedPaths,
      "ROADMAP_IGNORED",
      "Frozen local inputs must remain ignored",
    );
    for (const input of receipt.pinnedInputs) {
      const file = local(input.path);
      ensure(
        input.path.startsWith(`${roadmapRelative}/`),
        "RECEIPT_INPUTS",
        "Frozen local input must be inside roadmapRoot",
      );
      ensure(
        fs.realpathSync(file).startsWith(`${fs.realpathSync(roadmap)}${path.sep}`),
        "RECEIPT_INPUTS",
        "Local input must not escape through a symlink",
      );
      same(
        sha256(fs.readFileSync(file)),
        input.sha256,
        "LOCAL_INPUT_HASH",
        `Local frozen input hash mismatch: ${input.id}`,
      );
    }
    const expectedInputs = [
      {
        id: "manifest",
        path: `${roadmapRelative}/docs/roadmap-execution-manifest.json`,
        sha256: manifestHash,
      },
      ...manifest.runStatePinnedInputs.map((input) => ({
        id: input.id,
        path: `${roadmapRelative}/${input.path}`,
        sha256: state.contractHashes[input.id],
      })),
    ];
    for (const input of expectedInputs) {
      const recorded = receipt.pinnedInputs.find((item) => item.id === input.id);
      ensure(
        recorded && recorded.path === input.path && recorded.sha256 === input.sha256,
        "RECEIPT_INPUTS",
        `Frozen receipt missing input ${input.id}`,
      );
    }
    ensure(
      receipt.pinnedInputs.some((input) => input.path === `${roadmapRelative}/${name}.md`),
      "RECEIPT_INPUTS",
      "Receipt must pin the current phase card",
    );
    for (const contract of manifest.localContracts) {
      if (contract.required)
        ensure(
          receipt.pinnedInputs.some(
            (input) =>
              input.id === contract.id &&
              input.path === `${roadmapRelative}/${relativeFile(contract.path)}`,
          ),
          "CONTRACT_COVERAGE",
          `Required local contract absent from receipt: ${contract.id}`,
        );
    }
    if (!firstReceipt) firstReceipt = receipt;
    else
      for (const input of expectedInputs)
        same(
          receipt.pinnedInputs.find((item) => item.id === input.id),
          firstReceipt.pinnedInputs.find((item) => item.id === input.id),
          "FROZEN_INPUTS",
          `Pinned input changed within execution run: ${input.id}`,
        );
    const currentArtifactCommit = currentCommit(checkpoint.artifactCommit);
    const artifactIndex = history.findIndex((entry) => entry.id === currentArtifactCommit);
    const metadataIndex = artifactIndex + 1;
    ensure(
      artifactIndex > previousMetadataIndex && metadataIndex < history.length,
      "CHECKPOINT_PARENT",
      "Checkpoint artifact must have a direct metadata child in phase history",
    );
    const metadata = history[metadataIndex];
    same(
      metadata.parents,
      [currentArtifactCommit],
      "CHECKPOINT_PARENT",
      "Metadata parent must equal current checkpoint artifact",
    );
    const phaseStartIndex =
      checkpointMaintenance?.phaseStartIndex(n, previousMetadataIndex) ?? previousMetadataIndex + 1;
    const recovery = history.slice(phaseStartIndex, artifactIndex).map((entry) => entry.id);
    same(
      evidence.details.recoveryCommits,
      recovery,
      "RECOVERY_COMMITS",
      "recoveryCommits must enumerate every intermediate commit in order",
    );
    for (const entry of history.slice(phaseStartIndex, artifactIndex)) {
      if (entry.subject !== `phase(${String(n).padStart(3, "0")}): artifact`) continue;
      const priorPlanBytes = blob(entry.id, `docs/phase-plans/${name}.json`);
      const priorPlan = parseJson(priorPlanBytes);
      if (priorPlan.attemptId === plan.attemptId) {
        same(
          sha256(priorPlanBytes),
          evidence.details.planHash,
          "PLAN_ATTEMPT_IMMUTABLE",
          "The same attempt changed its frozen plan",
        );
      } else {
        ensure(
          plan.previousAttempts?.some(
            (previous) =>
              previous.attemptId === priorPlan.attemptId &&
              previous.planHash === sha256(priorPlanBytes),
          ),
          "RECOVERY_PLAN",
          "Recovery history must preserve each previous artifact plan and its hash",
        );
      }
    }
    for (let index = phaseStartIndex; index <= metadataIndex; index += 1) {
      const entry = history[index];
      const match = new RegExp(
        `^phase\\(${String(n).padStart(3, "0")}\\): (artifact|metadata|recovery)$`,
      ).exec(entry.subject);
      ensure(match, "COMMIT_SUBJECT", `Unexpected phase commit subject: ${entry.subject}`);
      const kind = match[1];
      if (index === artifactIndex)
        same(kind, "artifact", "CHECKPOINT_PARENT", "Final artifact subject must be artifact");
      if (index === metadataIndex)
        same(kind, "metadata", "CHECKPOINT_PARENT", "Final metadata subject must be metadata");
      const changed = changes(entry.id);
      for (const file of changed) {
        ensure(
          !file.startsWith(`${roadmapRelative}/`),
          "ROADMAP_TRACKED",
          "Phase commits must exclude local roadmap files",
        );
        ensure(
          !file.startsWith(`${historical.archiveRoot}/`),
          "HISTORY_IMMUTABLE",
          "Phase commits must preserve historical archive",
        );
      }
      if (kind === "metadata") {
        ensure(
          index > 0 &&
            history[index - 1].subject === `phase(${String(n).padStart(3, "0")}): artifact`,
          "CHECKPOINT_PARENT",
          "Every metadata commit must directly follow its artifact",
        );
        for (const file of [...metadataPaths, gatePath])
          ensure(changed.includes(file), "METADATA_REQUIRED", `Metadata must write ${file}`);
        for (const file of changed)
          ensure(
            metadataPaths.includes(file) || file.startsWith("docs/evidence/"),
            "METADATA_PATH",
            `Metadata changes non-metadata path: ${file}`,
          );
      } else {
        for (const file of [...metadataPaths, gatePath])
          ensure(
            !changed.includes(file),
            "ARTIFACT_METADATA",
            `Artifact/recovery changes current metadata path: ${file}`,
          );
        for (const file of changed)
          ensure(
            plan.modificationScope.some((scope) => {
              const normalized = scope.replace(/^projectRoot\//, "");
              return normalized.endsWith("/") ? file.startsWith(normalized) : file === normalized;
            }),
            "ARTIFACT_SCOPE",
            `Artifact/recovery path outside frozen plan modificationScope: ${file}`,
          );
      }
    }
    same(
      sha256(blob(metadata.id, gatePath)),
      checkpoint.evidenceHash,
      "GATE_IMMUTABLE",
      "Gate differs from its final metadata commit",
    );
    same(
      gitText(["log", "--format=%H", `${currentArtifactCommit}..HEAD`, "--", gatePath]).split("\n"),
      [metadata.id],
      "GATE_IMMUTABLE",
      "Gate was changed after its final metadata commit",
    );
    const metadataState = blobJson(metadata.id, "docs/roadmap-run.json");
    same(
      metadataState.completedThrough,
      n,
      "HISTORICAL_STATE",
      "Metadata completedThrough mismatch",
    );
    same(metadataState.currentPhase, n + 1, "HISTORICAL_STATE", "Metadata currentPhase mismatch");
    same(
      metadataState.lastArtifactCommit,
      checkpoint.artifactCommit,
      "HISTORICAL_STATE",
      "Metadata lastArtifactCommit mismatch",
    );
    same(
      metadataState.checkpoints,
      state.checkpoints.slice(0, n),
      "HISTORICAL_STATE",
      "Historical checkpoint list was rewritten",
    );
    for (const key of [
      "stateVersion",
      "layoutVersion",
      "pathsRelativeTo",
      "repositoryRoot",
      "projectRoot",
      "roadmapRoot",
      "roadmapId",
      "executionMode",
      "operatorMode",
      "manifestHash",
      "contractHashes",
      "baselineCommit",
      "executionBaselineCommit",
      "historicalCheckpoint",
    ])
      same(
        metadataState[key],
        state[key],
        "HISTORICAL_STATE",
        `Historical run-state ${key} changed`,
      );
    previousMetadataIndex = metadataIndex;
  }
  const importedAdmission =
    checkpointImport && completedThrough === checkpointImport.importedThrough;
  const maintenanceAdmission = checkpointMaintenance?.admissionOnly ?? false;
  if (importedAdmission) checkpointImport.validateAdmissionTail(history, previousMetadataIndex);
  else if (maintenanceAdmission) {
    same(
      history[previousMetadataIndex].id,
      checkpointMaintenance.baseMetadataCommit,
      "MAINTENANCE_ANCHOR",
      "Maintenance admission must preserve the final Phase012 metadata checkpoint",
    );
  } else {
    ensure(
      previousMetadataIndex === history.length - 1,
      "HEAD_METADATA",
      "HEAD must be the final completed phase metadata commit",
    );
    same(
      parents(head),
      [currentCommit(state.lastArtifactCommit)],
      "CHECKPOINT_PARENT",
      "Metadata HEAD parent must equal lastArtifactCommit",
    );
  }
  const localContracts = manifest.localContracts.filter((contract) => contract.required);
  for (const contract of localContracts)
    ensure(
      fs.statSync(path.join(roadmap, relativeFile(contract.path))).isFile(),
      "CONTRACT_COVERAGE",
      `Required local contract missing: ${contract.id}`,
    );
  const currentContracts = manifest.projectContracts.filter(
    (contract) => contract.required && contract.producerPhase <= completedThrough,
  );
  const currentFiles = new Set(listTree(head));
  for (const contract of currentContracts) {
    ensure(
      currentFiles.has(contract.path),
      "CONTRACT_COVERAGE",
      `Required project contract missing: ${contract.path}`,
    );
    const expected = blob(head, contract.path);
    ensure(
      expected.length > 0,
      "CONTRACT_COVERAGE",
      `Required project contract empty: ${contract.id}`,
    );
    same(
      sha256(read(contract.path)),
      sha256(expected),
      "CONTRACT_BYTES",
      `Required project contract bytes differ from HEAD: ${contract.path}`,
    );
  }
  ensure(
    gitText(["status", "--porcelain=v1", "--untracked-files=all"]) === "",
    "WORKTREE_DIRTY",
    "Entire repository worktree must be clean after metadata commit",
  );
  git(["diff", "--check", currentHistoryBaseline, head]);
  return {
    status: "PASS",
    scope: protocolFixture
      ? "ISOLATED_PROTOCOL_FIXTURE_VALIDATION"
      : maintenanceAdmission
        ? "ROOT_LAYOUT_PHASE_CHECKPOINT_ADMISSION"
        : "ROOT_LAYOUT_PHASE_CHECKPOINT_SEAL",
    protocolFixture,
    layoutVersion: 2,
    repositoryRoot: root,
    projectRoot: root,
    projectGitPrefix: "",
    executionBaselineCommit: baseline,
    completedThrough,
    currentPhase: completedThrough + 1,
    artifactCommit: state.lastArtifactCommit,
    metadataCommit: importedAdmission
      ? checkpointImport.currentMetadataCommit
      : history[previousMetadataIndex].id,
    ...(checkpointMaintenance
      ? {
          maintenanceHead: checkpointMaintenance.commit,
          admissionOnly: maintenanceAdmission,
          checkpointMaintenance: {
            path: checkpointMaintenance.path,
            sha256: checkpointMaintenance.sha256,
            commit: checkpointMaintenance.commit,
            policy: checkpointMaintenance.policy,
          },
        }
      : {}),
    historicalPhase: 0,
    preservedHistoricalFiles: oldFiles.length,
    ...(checkpointImport
      ? {
          checkpointImport: {
            path: "docs/checkpoint-migrations/history-20260909.json",
            sha256: checkpointImport.receiptHash,
            importedThrough: checkpointImport.importedThrough,
            continuationBaselineCommit: checkpointImport.continuationBaselineCommit,
            currentHead: head,
            admissionOnly: Boolean(importedAdmission),
          },
        }
      : {}),
    localIgnoredInputsVerified: firstReceipt.pinnedInputs.length,
    contractCoverage: {
      numerator: localContracts.length + currentContracts.length,
      denominator: localContracts.length + currentContracts.length,
    },
    networkPushEvaluated: false,
  };
}

function cli() {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === "--repository-root") options.repositoryRoot = process.argv[++index];
    else if (arg === "--manifest") options.manifestPath = process.argv[++index];
    else if (arg === "--completed-through")
      options.completedThrough = Number(process.argv[++index]);
    else if (arg === "--protocol-fixture") options.protocolFixture = true;
    else if (!["--strict", "--json"].includes(arg))
      throw new Error(`ARGUMENT: Unknown option ${arg}`);
  }
  return validatePhase(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.warn(JSON.stringify(cli(), null, 2));
  } catch (error) {
    console.error(
      JSON.stringify(
        { status: "FAIL", error: error.message, networkPushEvaluated: false },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}
