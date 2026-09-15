import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const phase016RecoveryPath = "docs/phase-plans/Phase016-recovery.json";
export const phase016StartCommit = "cbd1c983d88d705be9e087694faaef4d6610abd6";
export const phase016RecoveredCommits = Object.freeze([
  "ad3079dae3fd0f26f1b028584dfc79547d1155af",
  "c8cea8af11d121432e94e5af53dc01348e2c9547",
  "5e5e303d87efd4424181c332c51067486f5bfb34",
]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Narrow recovery of the three pre-existing Phase016 commits; no other subject is exempt. */
export function validatePhase016Recovery({
  plan,
  inputReceipt,
  recoveryBytes,
  recoveryCommits,
  git,
}) {
  assert.equal(plan.phase, 16, "RECOVERY_PHASE");
  assert.equal(inputReceipt.phaseStartCommit, phase016StartCommit, "RECOVERY_BASE");
  const binding = { path: phase016RecoveryPath, sha256: digest(recoveryBytes) };
  assert.deepEqual(plan.recoveryReceipt, binding, "RECOVERY_PLAN_BINDING");
  assert.deepEqual(inputReceipt.recoveryReceipt, binding, "RECOVERY_INPUT_BINDING");
  assert(plan.sourcePaths.includes(phase016RecoveryPath), "RECOVERY_SOURCE");
  const receipt = JSON.parse(recoveryBytes);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.phase, 16);
  assert.equal(receipt.phaseStartCommit, phase016StartCommit, "RECOVERY_BASE");
  assert.equal(receipt.observedHead, phase016RecoveredCommits.at(-1));
  assert.deepEqual(
    receipt.commits.map((row) => row.commit),
    phase016RecoveredCommits,
    "RECOVERY_EXACT_COMMITS",
  );
  assert.deepEqual(recoveryCommits.slice(0, 3), phase016RecoveredCommits, "RECOVERY_ANCESTRY");
  let parent = phase016StartCommit;
  for (const row of receipt.commits) {
    const text = (args) => git(args).toString("utf8").trim();
    const actual = text(["show", "-s", "--format=%H%n%P%n%T%n%s", row.commit]).split("\n");
    assert.deepEqual(actual, [row.commit, parent, row.tree, row.subject], "RECOVERY_COMMIT_OBJECT");
    assert.equal(row.parent, parent, "RECOVERY_LINEAR_PARENT");
    const names = git([
      "diff-tree",
      "--no-commit-id",
      "--no-renames",
      "--name-only",
      "-r",
      "-z",
      row.commit,
    ])
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();
    assert.deepEqual(row.files.map((f) => f.path).sort(), names, "RECOVERY_COMPLETE_DIFF");
    assert.equal(new Set(names).size, row.files.length, "RECOVERY_DUPLICATE_PATH");
    for (const file of row.files)
      assert.equal(
        digest(git(["show", `${row.commit}:${file.path}`])),
        file.sha256,
        "RECOVERY_BLOB",
      );
    parent = row.commit;
  }
  return new Set(phase016RecoveredCommits);
}
