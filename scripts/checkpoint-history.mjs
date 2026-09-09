import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export const checkpointImportPath = "docs/checkpoint-migrations/history-20260909.json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (bytes) => JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
const check = (condition, code, message) => assert(condition, `${code}: ${message}`);
function same(actual, expected, code) {
  assert.deepEqual(actual, expected, `${code}: values differ`);
}
function inside(root, relative) {
  check(
    typeof relative === "string" &&
      !/[\\:\x00-\x1f]/.test(relative) &&
      !relative.startsWith("/") &&
      !relative.split("/").some((part) => ["", ".", ".."].includes(part)),
    "IMPORT_PATH",
    relative,
  );
  const result = path.resolve(root, relative);
  check(result.startsWith(`${root}${path.sep}`), "IMPORT_PATH", relative);
  return result;
}

export function checkpointHistoryEnvironment(root) {
  const receiptFile = path.join(root, checkpointImportPath);
  if (!fs.existsSync(receiptFile))
    return { env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" }, receipt: null };
  const receiptBytes = fs.readFileSync(receiptFile);
  const receipt = json(receiptBytes);
  same(receipt.schemaVersion, "checkpoint-history-import-v1", "IMPORT_SCHEMA");
  const source = receipt.localHistory;
  check(
    source?.bundlePath === ".scaffold/checkpoint-import/original-history.bundle" &&
      source.objectRepository === ".scaffold/checkpoint-import/original-history.git",
    "IMPORT_LOCAL_SOURCE",
    "Only the ignored local history source is supported",
  );
  const bundle = inside(root, source.bundlePath);
  check(
    fs.existsSync(bundle),
    "IMPORT_LOCAL_SOURCE",
    `Provide the local-only Git bundle ${source.bundlePath} with SHA-256 ${source.bundleSha256}`,
  );
  same(sha256(fs.readFileSync(bundle)), source.bundleSha256, "IMPORT_BUNDLE_HASH");
  const objectRepository = inside(root, source.objectRepository);
  if (!fs.existsSync(objectRepository)) {
    const clone = spawnSync(
      "git",
      ["clone", "--bare", "--branch", "checkpoint-original", bundle, objectRepository],
      { cwd: root, windowsHide: true, encoding: "utf8" },
    );
    check(
      !clone.error && clone.status === 0,
      "IMPORT_LOCAL_SOURCE",
      clone.stderr || clone.error?.message,
    );
  }
  check(
    !fs.lstatSync(objectRepository).isSymbolicLink(),
    "IMPORT_LOCAL_SOURCE",
    "History source cannot be a symlink",
  );
  const objectDirectory = fs.realpathSync(path.join(objectRepository, "objects"));
  check(
    objectDirectory.startsWith(`${fs.realpathSync(root)}${path.sep}`),
    "IMPORT_LOCAL_SOURCE",
    "History objects must remain within the workspace",
  );
  return {
    env: {
      ...process.env,
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objectDirectory,
    },
    receipt,
    receiptHash: sha256(receiptBytes),
  };
}

export function validateCheckpointImport({
  root,
  state,
  head,
  git,
  blob,
  prefetch,
  receipt,
  receiptHash,
}) {
  if (!receipt) return null;
  const gitText = (args) => git(args).toString("utf8").trim();
  const parents = (id) => gitText(["rev-list", "--parents", "-n", "1", id]).split(" ").slice(1);
  const tree = (id) => gitText(["rev-parse", `${id}^{tree}`]);
  const read = (file) => fs.readFileSync(inside(root, file));
  const roles = [
    "foundation",
    "Phase000-artifact",
    "Phase000-metadata",
    "new-layout-baseline",
    "Phase001-artifact",
    "Phase001-metadata",
    "Phase002-artifact",
    "Phase002-metadata",
  ];
  same(
    receipt.pairs.map((pair) => pair.role),
    roles,
    "IMPORT_ROLES",
  );
  same(new Set(receipt.pairs.map((pair) => pair.original)).size, roles.length, "IMPORT_DUPLICATE");
  same(new Set(receipt.pairs.map((pair) => pair.current)).size, roles.length, "IMPORT_DUPLICATE");
  same(receipt.importedThrough, 2, "IMPORT_PHASE");
  same(receipt.startPhase, 3, "IMPORT_PHASE");
  same(receipt.originalBaselineCommit, state.executionBaselineCommit, "IMPORT_BASELINE");
  same(receipt.originalHistoricalCheckpoint, state.historicalCheckpoint, "IMPORT_HISTORY");
  same(receipt.originalCheckpoints, state.checkpoints.slice(0, 2), "IMPORT_CHECKPOINTS");
  same(receipt.manifestHash, state.manifestHash, "IMPORT_MANIFEST");
  same(receipt.contractHashes, state.contractHashes, "IMPORT_INPUTS");
  same(sha256(read(receipt.planPath)), receipt.planHash, "IMPORT_PLAN_HASH");
  const plan = json(read(receipt.planPath));
  same(plan.baselineCommit, receipt.continuationBaselineCommit, "IMPORT_CONTINUATION");
  same(
    receipt.preflight,
    {
      head: receipt.continuationBaselineCommit,
      originMain: receipt.continuationBaselineCommit,
      branch: "main",
      remote: "https://github.com/KECIHH/Serendipity.git",
    },
    "IMPORT_PREFLIGHT",
  );
  const byRole = Object.fromEntries(receipt.pairs.map((pair) => [pair.role, pair]));
  same(byRole.foundation.current, byRole.foundation.original, "IMPORT_FOUNDATION");
  same(
    byRole["new-layout-baseline"].current,
    receipt.currentHistoryBaselineCommit,
    "IMPORT_BASELINE",
  );
  same(byRole["new-layout-baseline"].original, receipt.originalBaselineCommit, "IMPORT_BASELINE");
  same(byRole["Phase002-metadata"].current, receipt.currentMetadataCommit, "IMPORT_METADATA");
  same(byRole["Phase002-metadata"].original, receipt.originalMetadataCommit, "IMPORT_METADATA");
  same(
    byRole["Phase000-artifact"].original,
    state.historicalCheckpoint.artifactCommit,
    "IMPORT_HISTORY",
  );
  same(
    byRole["Phase000-metadata"].original,
    state.historicalCheckpoint.metadataCommit,
    "IMPORT_HISTORY",
  );
  for (const checkpoint of receipt.originalCheckpoints)
    same(
      byRole[`Phase00${checkpoint.phase}-artifact`].original,
      checkpoint.artifactCommit,
      "IMPORT_ARTIFACT",
    );
  same(
    receipt.droppedOriginalCommit.commit,
    state.historicalCheckpoint.baselineCommit,
    "IMPORT_DROPPED_COMMIT",
  );
  same(receipt.droppedOriginalCommit.parent, byRole.foundation.original, "IMPORT_DROPPED_COMMIT");
  same(
    parents(receipt.droppedOriginalCommit.commit),
    [byRole.foundation.original],
    "IMPORT_ORIGINAL_PARENT",
  );
  const prefix = `${state.roadmapRoot}/`;
  const removedMap = new Map(receipt.removedLocalDocuments.map((file) => [file.path, file.sha256]));
  same(removedMap.size, 153, "IMPORT_REMOVED_DOCUMENTS");
  same(receipt.removedLocalDocuments.length, removedMap.size, "IMPORT_REMOVED_DOCUMENTS");
  for (const role of ["Phase000-artifact", "Phase000-metadata"])
    prefetch(byRole[role].original, [...removedMap.keys()]);
  for (const [file, hash] of removedMap) {
    check(
      file.startsWith(prefix) && !file.startsWith(`${prefix}project/`),
      "IMPORT_REMOVED_DOCUMENTS",
      file,
    );
    same(sha256(blob(byRole["Phase000-artifact"].original, file)), hash, "IMPORT_REMOVED_HASH");
  }
  for (const [index, pair] of receipt.pairs.entries()) {
    same(parents(pair.original), pair.originalParents, "IMPORT_ORIGINAL_PARENT");
    same(parents(pair.current), pair.currentParents, "IMPORT_CURRENT_PARENT");
    const expectedOriginalParent =
      index === 0
        ? []
        : [index === 1 ? receipt.droppedOriginalCommit.commit : receipt.pairs[index - 1].original];
    const expectedCurrentParent = index === 0 ? [] : [receipt.pairs[index - 1].current];
    same(pair.originalParents, expectedOriginalParent, "IMPORT_ORIGINAL_PARENT");
    same(pair.currentParents, expectedCurrentParent, "IMPORT_CURRENT_PARENT");
    same(tree(pair.original), pair.originalTree, "IMPORT_ORIGINAL_TREE");
    same(tree(pair.current), pair.currentTree, "IMPORT_CURRENT_TREE");
    git(["merge-base", "--is-ancestor", pair.current, head]);
    const differences = git([
      "diff",
      "--name-status",
      "--no-renames",
      "-z",
      pair.original,
      pair.current,
    ])
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    if (index === 1 || index === 2) {
      const removed = [];
      for (let offset = 0; offset < differences.length; offset += 2) {
        same(differences[offset], "D", "IMPORT_TREE_CHANGE");
        const file = differences[offset + 1];
        check(removedMap.has(file), "IMPORT_TREE_CHANGE", `Unapproved removed file: ${file}`);
        same(sha256(blob(pair.original, file)), removedMap.get(file), "IMPORT_REMOVED_HASH");
        removed.push(file);
      }
      same(removed.sort(), [...removedMap.keys()].sort(), "IMPORT_TREE_CHANGE");
    } else {
      same(pair.originalTree, pair.currentTree, "IMPORT_TREE_CHANGE");
      same(differences, [], "IMPORT_TREE_CHANGE");
    }
  }
  same(
    sha256(blob(receipt.originalMetadataCommit, "docs/roadmap-run.json")),
    receipt.originalStateHash,
    "IMPORT_STATE_HASH",
  );
  same(
    sha256(blob(receipt.currentMetadataCommit, "docs/roadmap-run.json")),
    receipt.originalStateHash,
    "IMPORT_STATE_HASH",
  );
  same(receipt.localHistory.sourceCommit, receipt.originalMetadataCommit, "IMPORT_LOCAL_SOURCE");
  for (const checkpoint of receipt.originalCheckpoints) {
    same(
      sha256(blob(receipt.currentMetadataCommit, checkpoint.evidencePath)),
      checkpoint.evidenceHash,
      "IMPORT_EVIDENCE_HASH",
    );
    same(sha256(read(checkpoint.evidencePath)), checkpoint.evidenceHash, "IMPORT_EVIDENCE_HASH");
  }
  git([
    "merge-base",
    "--is-ancestor",
    receipt.currentMetadataCommit,
    receipt.continuationBaselineCommit,
  ]);
  git(["merge-base", "--is-ancestor", receipt.continuationBaselineCommit, head]);
  const declared = state.checkpointMigration;
  if (declared)
    same(
      declared,
      {
        path: checkpointImportPath,
        sha256: receiptHash,
        continuationBaselineCommit: receipt.continuationBaselineCommit,
        importedThrough: 2,
      },
      "IMPORT_RUN_BINDING",
    );
  if (state.completedThrough >= 3)
    check(
      Boolean(declared),
      "IMPORT_RUN_BINDING",
      "New checkpoints must bind the historical import",
    );
  const mapping = new Map(receipt.pairs.map((pair) => [pair.original, pair.current]));
  return {
    ...receipt,
    receiptHash,
    currentCommit: (original) => mapping.get(original) ?? original,
    validateAdmissionTail(history, previousMetadataIndex) {
      const expectedPolicy = {
        subject: "phase(003): recovery",
        allowedExactPaths: [
          "docs/agent-execution-contract.md",
          checkpointImportPath,
          "docs/phase-plans/Phase003-checkpoint-recovery.json",
        ],
        allowedPathPrefixes: ["scripts/", "docs/evidence/attempts/Phase003/"],
      };
      same(receipt.admissionTail, expectedPolicy, "IMPORT_ADMISSION_POLICY");
      for (const entry of history.slice(previousMetadataIndex + 1)) {
        same(entry.subject, expectedPolicy.subject, "IMPORT_ADMISSION_SUBJECT");
        const changed = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", entry.id])
          .toString("utf8")
          .split("\0")
          .filter(Boolean);
        check(
          changed.length > 0,
          "IMPORT_ADMISSION_SCOPE",
          "Empty recovery commits are not accepted",
        );
        for (const file of changed)
          check(
            expectedPolicy.allowedExactPaths.includes(file) ||
              expectedPolicy.allowedPathPrefixes.some((scope) => file.startsWith(scope)),
            "IMPORT_ADMISSION_SCOPE",
            file,
          );
      }
      same(sha256(blob(head, checkpointImportPath)), receiptHash, "IMPORT_COMMITTED_RECEIPT");
    },
  };
}
