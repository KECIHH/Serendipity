import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export const maintenanceReceiptPath = "docs/checkpoint-migrations/testing-policy-20260912.json";
export const maintenancePolicyPath = "docs/testing-execution-policy.md";
export const maintenanceBaseMetadata = "3fa20a8dca445859d94db8dfa1232d16f8a6e07f";
export const maintenanceBaseArtifact = "171025ef44f194b6417e9bf091c0d635d9741e2b";
export const maintenanceSubject = "docs: optimize subsequent phase verification workflow";
export const maintenancePolicyVersion = "phase-verification-v1";
export const maintenanceAllowedPaths = Object.freeze(
  [
    "AGENTS.md",
    "docs/agent-execution-contract.md",
    "docs/git-workflow.md",
    maintenancePolicyPath,
    "scripts/checkpoint-maintenance.mjs",
    "scripts/test-checkpoint-maintenance.mjs",
    "scripts/validate-phase.mjs",
    "scripts/test-validate-phase.mjs",
    maintenanceReceiptPath,
  ].sort(),
);
const contentPaths = maintenanceAllowedPaths.filter((file) => file !== maintenanceReceiptPath);
const guidePaths = ["Serendipity · 际遇/AGENTS.md", "Serendipity · 际遇/README.md"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const parseJson = (bytes) => JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
const check = (condition, code, message) => assert(condition, `${code}: ${message}`);
const same = (actual, expected, code) =>
  assert.deepEqual(actual, expected, `${code}: values differ`);
const hash = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
function closed(value, keys, code) {
  check(
    value !== null && typeof value === "object" && !Array.isArray(value),
    code,
    "Object required",
  );
  same(Object.keys(value).sort(), [...keys].sort(), code);
}
function localBytes(root, relative) {
  const file = path.join(root, relative);
  check(
    fs.lstatSync(file).isFile() && fs.realpathSync(file).startsWith(`${root}${path.sep}`),
    "MAINTENANCE_LOCAL_FILE",
    relative,
  );
  return fs.readFileSync(file);
}
function commandGit(root, args) {
  const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: root,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  check(
    !result.error && result.status === 0,
    "MAINTENANCE_GIT",
    result.error?.message || result.stderr?.toString("utf8"),
  );
  return result.stdout;
}

// This only reads the fixed base and current files. The receipt never hashes itself.
export function createMaintenanceReceipt(repositoryRoot) {
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const changes = contentPaths.map((file) => {
    const exists =
      commandGit(root, ["ls-tree", "--name-only", maintenanceBaseMetadata, "--", file]).length > 0;
    const beforeSha256 = exists
      ? sha256(commandGit(root, ["cat-file", "blob", `${maintenanceBaseMetadata}:${file}`]))
      : null;
    const afterSha256 = sha256(localBytes(root, file));
    check(beforeSha256 !== afterSha256, "MAINTENANCE_UNCHANGED", file);
    return { path: file, beforeSha256, afterSha256 };
  });
  return {
    schemaVersion: "phase-checkpoint-maintenance-v1",
    id: "testing-policy-20260912",
    scope: "DOCS_AND_PHASE_VALIDATOR_ONLY",
    afterPhase: 12,
    nextPhase: 13,
    baseMetadataCommit: maintenanceBaseMetadata,
    baseArtifactCommit: maintenanceBaseArtifact,
    subject: maintenanceSubject,
    allowedExactPaths: [...maintenanceAllowedPaths],
    policy: {
      path: maintenancePolicyPath,
      version: maintenancePolicyVersion,
      sha256: changes.find((entry) => entry.path === maintenancePolicyPath).afterSha256,
    },
    changes,
    localGuides: guidePaths.map((file) => ({ path: file, sha256: sha256(localBytes(root, file)) })),
  };
}

export function validateCheckpointMaintenance({ root, state, head, history, git, blob }) {
  const exists = fs.existsSync(path.join(root, maintenanceReceiptPath));
  if (state.completedThrough < 12) {
    check(!exists, "MAINTENANCE_PHASE", "Maintenance is only admitted after Phase012");
    return null;
  }
  const gitText = (args) => git(args).toString("utf8").trim();
  const receiptCommits = gitText([
    "log",
    "--format=%H",
    `${maintenanceBaseMetadata}..${head}`,
    "--",
    maintenanceReceiptPath,
  ])
    .split("\n")
    .filter(Boolean);
  if (!exists) {
    same(receiptCommits, [], "MAINTENANCE_RECEIPT_IMMUTABLE");
    check(
      state.completedThrough === 12,
      "MAINTENANCE_REQUIRED",
      "Phase013 and later require the maintenance receipt",
    );
    return null;
  }
  const bytes = localBytes(root, maintenanceReceiptPath);
  const receipt = parseJson(bytes);
  const receiptHash = sha256(bytes);
  closed(
    receipt,
    [
      "schemaVersion",
      "id",
      "scope",
      "afterPhase",
      "nextPhase",
      "baseMetadataCommit",
      "baseArtifactCommit",
      "subject",
      "allowedExactPaths",
      "policy",
      "changes",
      "localGuides",
    ],
    "MAINTENANCE_SCHEMA",
  );
  for (const [key, expected] of Object.entries({
    schemaVersion: "phase-checkpoint-maintenance-v1",
    id: "testing-policy-20260912",
    scope: "DOCS_AND_PHASE_VALIDATOR_ONLY",
    afterPhase: 12,
    nextPhase: 13,
    baseMetadataCommit: maintenanceBaseMetadata,
    baseArtifactCommit: maintenanceBaseArtifact,
    subject: maintenanceSubject,
  }))
    same(receipt[key], expected, "MAINTENANCE_ANCHOR");
  same(receipt.allowedExactPaths, maintenanceAllowedPaths, "MAINTENANCE_SCOPE");
  closed(receipt.policy, ["path", "version", "sha256"], "MAINTENANCE_POLICY");
  same(receipt.policy.path, maintenancePolicyPath, "MAINTENANCE_POLICY");
  same(receipt.policy.version, maintenancePolicyVersion, "MAINTENANCE_POLICY");
  check(hash(receipt.policy.sha256), "MAINTENANCE_POLICY", "Invalid policy hash");
  check(Array.isArray(receipt.changes), "MAINTENANCE_CHANGES", "Changes must be an array");
  same(
    receipt.changes.map((entry) => entry.path),
    contentPaths,
    "MAINTENANCE_CHANGES",
  );
  for (const change of receipt.changes) {
    closed(change, ["path", "beforeSha256", "afterSha256"], "MAINTENANCE_CHANGES");
    check(
      (change.beforeSha256 === null || hash(change.beforeSha256)) &&
        hash(change.afterSha256) &&
        change.beforeSha256 !== change.afterSha256,
      "MAINTENANCE_CHANGES",
      change.path,
    );
  }
  const baseIndex = history.findIndex((entry) => entry.id === maintenanceBaseMetadata);
  check(baseIndex >= 0, "MAINTENANCE_ANCHOR", "Phase012 metadata must be in the current history");
  same(history[baseIndex].parents, [maintenanceBaseArtifact], "MAINTENANCE_ANCHOR");
  same(state.checkpoints[11]?.artifactCommit, maintenanceBaseArtifact, "MAINTENANCE_ANCHOR");
  const index = baseIndex + 1;
  const entry = history[index];
  check(
    Boolean(entry),
    "MAINTENANCE_COMMIT",
    "The receipt needs its own committed maintenance change",
  );
  same(entry.parents, [maintenanceBaseMetadata], "MAINTENANCE_PARENT");
  same(entry.subject, maintenanceSubject, "MAINTENANCE_SUBJECT");
  same(receiptCommits, [entry.id], "MAINTENANCE_RECEIPT_IMMUTABLE");
  same(sha256(blob(entry.id, maintenanceReceiptPath)), receiptHash, "MAINTENANCE_RECEIPT_HASH");
  same(sha256(blob(head, maintenanceReceiptPath)), receiptHash, "MAINTENANCE_RECEIPT_HASH");
  const raw = git(["diff-tree", "--no-commit-id", "--raw", "--no-renames", "-r", "-z", entry.id])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  check(
    raw.length > 0 && raw.length % 2 === 0,
    "MAINTENANCE_SCOPE",
    "Nonempty file changes required",
  );
  const changed = [];
  const beforeModes = new Map();
  for (let offset = 0; offset < raw.length; offset += 2) {
    const file = raw[offset + 1];
    const match = /^:(000000|100644) (100644) [0-9a-f]{40,64} [0-9a-f]{40,64} ([AM])$/.exec(
      raw[offset],
    );
    check(
      Boolean(match),
      "MAINTENANCE_FILE_MODE",
      `Only regular file additions/modifications are allowed: ${file}`,
    );
    same(match[3], match[1] === "000000" ? "A" : "M", "MAINTENANCE_FILE_MODE");
    changed.push(file);
    beforeModes.set(file, match[1]);
  }
  same(changed.sort(), maintenanceAllowedPaths, "MAINTENANCE_SCOPE");
  same(beforeModes.get(maintenanceReceiptPath), "000000", "MAINTENANCE_RECEIPT_IMMUTABLE");
  for (const change of receipt.changes) {
    const before =
      beforeModes.get(change.path) === "000000"
        ? null
        : sha256(blob(maintenanceBaseMetadata, change.path));
    same(before, change.beforeSha256, "MAINTENANCE_BEFORE_HASH");
    same(sha256(blob(entry.id, change.path)), change.afterSha256, "MAINTENANCE_AFTER_HASH");
  }
  same(
    sha256(blob(entry.id, maintenancePolicyPath)),
    receipt.policy.sha256,
    "MAINTENANCE_POLICY_HASH",
  );
  same(
    gitText(["log", "--format=%H", `${entry.id}..${head}`, "--", maintenancePolicyPath]),
    "",
    "MAINTENANCE_POLICY_IMMUTABLE",
  );
  same(
    sha256(localBytes(root, maintenancePolicyPath)),
    receipt.policy.sha256,
    "MAINTENANCE_POLICY_HASH",
  );
  check(
    Array.isArray(receipt.localGuides),
    "MAINTENANCE_LOCAL_GUIDES",
    "Local guides must be an array",
  );
  same(
    receipt.localGuides.map((guide) => guide.path),
    guidePaths,
    "MAINTENANCE_LOCAL_GUIDES",
  );
  for (const guide of receipt.localGuides) {
    closed(guide, ["path", "sha256"], "MAINTENANCE_LOCAL_GUIDES");
    check(hash(guide.sha256), "MAINTENANCE_LOCAL_GUIDES", "Invalid guide hash");
    same(sha256(localBytes(root, guide.path)), guide.sha256, "MAINTENANCE_LOCAL_GUIDES");
  }
  same(
    gitText(["ls-tree", "--name-only", head, "--", ...guidePaths]),
    "",
    "MAINTENANCE_LOCAL_GUIDES",
  );
  same(
    git(["check-ignore", "--no-index", "-z", "--stdin"], `${guidePaths.join("\0")}\0`)
      .toString("utf8")
      .split("\0")
      .filter(Boolean),
    guidePaths,
    "MAINTENANCE_LOCAL_GUIDES",
  );
  if (state.completedThrough === 12) same(head, entry.id, "MAINTENANCE_TAIL");
  const binding = { path: maintenanceReceiptPath, sha256: receiptHash, commit: entry.id };
  return {
    ...binding,
    index,
    baseMetadataCommit: maintenanceBaseMetadata,
    policy: { ...receipt.policy },
    admissionOnly: state.completedThrough === 12,
    phaseStartIndex(phase, previousMetadataIndex) {
      if (phase !== 13) return previousMetadataIndex + 1;
      same(previousMetadataIndex, baseIndex, "MAINTENANCE_POSITION");
      return index + 1;
    },
    validatePhaseInputs({ phase, receipt: inputs, plan, evidence, previousMetadataCommit }) {
      if (phase < 13) return;
      same(inputs.checkpointMaintenance, binding, "MAINTENANCE_INPUT_BINDING");
      same(inputs.validationPolicy, receipt.policy, "MAINTENANCE_POLICY_BINDING");
      if (phase === 13) same(inputs.phaseStartCommit, entry.id, "MAINTENANCE_PHASE_START");
      else {
        check(
          typeof previousMetadataCommit === "string" &&
            /^[0-9a-f]{40,64}$/.test(previousMetadataCommit),
          "MAINTENANCE_PHASE_START",
          "The previous sealed metadata commit is required",
        );
        same(inputs.phaseStartCommit, previousMetadataCommit, "MAINTENANCE_PHASE_START");
      }
      check(
        plan.sourcePaths?.includes(maintenancePolicyPath),
        "MAINTENANCE_POLICY_SOURCE",
        "The plan must include the adopted policy source",
      );
      check(
        evidence.inputs.some(
          (input) => input.path === maintenancePolicyPath && input.sha256 === receipt.policy.sha256,
        ),
        "MAINTENANCE_POLICY_INPUT",
        "The Gate must bind the adopted policy bytes",
      );
    },
  };
}
