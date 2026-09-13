import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  requireInputs,
  requirePlan,
  requireMappings,
  caseTags,
  negativeDefinitions,
  startCommit,
} from "./phase015-evidence.mjs";
import {
  root,
  planPath,
  receiptPath,
  plan as previous,
  directory,
  json,
  read,
  hash,
  sha,
  write,
  git,
  command,
  ensureFullDatabaseConfig,
  testEnvironment,
} from "./phase015-runtime.mjs";

assert(
  process.argv.includes("--from-failure"),
  "Use --from-failure after preserving a genuine failed attempt.",
);
const startedAt = new Date().toISOString();
const dependencies = { readJson: json, readBytes: read, hashFile: hash, git };
assert.equal(git(["rev-parse", "HEAD"]).trim(), startCommit, "RETRY_BASELINE_CHANGED");
assert.equal(git(["diff", "--cached", "--name-only"]).trim(), "", "SHARED_INDEX_NOT_EMPTY");
assert(
  !fs.existsSync(path.join(root, "docs/evidence/Phase015-gate.json")),
  "SEALED_PHASE_CANNOT_RETRY",
);
requireInputs(json(receiptPath), dependencies);
const priorPlanPath = directory + "/frozen-plan.json",
  failurePath = directory + "/attempt.json";
assert.equal(hash(priorPlanPath), hash(planPath), "FAILED_PLAN_CHANGED");
const failure = json(failurePath);
assert.equal(failure.phase, 15);
assert.equal(failure.attemptId, previous.attemptId);
assert(["FAIL", "BLOCKED"].includes(failure.status), "RECORDED_FAILURE_REQUIRED");
assert.equal(failure.planHash, hash(priorPlanPath));
for (const artifact of failure.artifacts ?? []) assert.equal(hash(artifact.path), artifact.sha256);
// Preserve earlier input-binding receipts, even when the repaired current receipt differs.
if (!fs.existsSync(path.join(root, directory, "input-receipt.json")))
  write(directory + "/input-receipt.json", read(receiptPath));

const attemptId = "attempt-" + (Number(previous.attemptId.split("-")[1]) + 1);
const nextDirectory = "docs/evidence/attempts/Phase015/" + attemptId;
assert(!fs.existsSync(path.join(root, nextDirectory)), "ATTEMPT_ALREADY_EXISTS");
const database = ensureFullDatabaseConfig();
const discoveryFile = path.join(
  root,
  ".scaffold/phase015",
  "freeze-" + attemptId + "-" + Date.now() + ".json",
);
const collection = command(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "list", "--json=" + discoveryFile],
  { env: testEnvironment(database.path), timeoutMs: 120000 },
);
assert.equal(collection.exitCode, 0, collection.stderr);
const discoveryBytes = fs.readFileSync(discoveryFile);
const discovery = JSON.parse(discoveryBytes);
assert(Array.isArray(discovery) && discovery.length > 0);
const rows = discovery.map((x) => ({
  file: path.relative(root, x.file).replaceAll("\\", "/"),
  fullName: x.name.replaceAll(" > ", " "),
}));
assert.equal(new Set(rows.map((x) => x.file + "::" + x.fullName)).size, rows.length);
const files = [
  ...new Set(
    git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter(Boolean),
  ),
];
const sources = files.filter(
  (file) =>
    /^(?:src|tests|scripts|prisma|vitest|public)\//.test(file) ||
    (!file.includes("/") && file !== "next-env.d.ts") ||
    /^docs\/[^/]+\.(?:md|json)$/.test(file),
);
const sourcePaths = [
  ...new Set([
    ...previous.sourcePaths,
    ...previous.previousAttempts.flatMap((entry) => json(entry.planPath).sourcePaths),
    ...sources,
    json(receiptPath).recoveryAdmission.path,
    "docs/evidence/attempts/Phase015/independent-review-initial.json",
    "docs/evidence/attempts/Phase015/independent-review-repro-results.json",
    "docs/evidence/attempts/Phase015/independent-review-guarded-results.json",
    "docs/evidence/attempts/Phase015/archive-redactions.json",
    ...json("docs/evidence/attempts/Phase015/archive-redactions.json").mappings.map(
      (row) => row.publicPath,
    ),
    ...(fs.existsSync(path.join(root, directory, "review.json"))
      ? [directory + "/review.json"]
      : []),
  ]),
].sort();
const assertionBindings = Object.fromEntries(
  Object.entries(caseTags).map(([id, tag]) => [
    id,
    rows
      .filter((x) => x.file.startsWith("tests/phase015/") && x.fullName.includes(tag))
      .sort((a, b) => (a.file + ":" + a.fullName).localeCompare(b.file + ":" + b.fullName, "en")),
  ]),
);
const plan = {
  ...previous,
  attemptId,
  archiveRedactions: {
    path: "docs/evidence/attempts/Phase015/archive-redactions.json",
    sha256: hash("docs/evidence/attempts/Phase015/archive-redactions.json"),
  },
  engineeringRegression: { ...previous.engineeringRegression, baseCommit: startCommit },
  sourcePaths,
  assertionBindings,
  modificationScope: [
    ...new Set([
      ...previous.modificationScope,
      "src/server/admin/key-candidate-client.ts",
      "src/server/admin/key-rotation.ts",
      "docs/planning-policy.json",
      ".gitignore",
    ]),
  ],
  supportingChecks: [...new Set([...previous.supportingChecks, "evidence-guards"])],
  negativeControls: negativeDefinitions.map((x) => x.id),
  cases: previous.cases.map((item) => ({
    ...item,
    outputPath: item.outputPath.replace("/" + previous.attemptId + "/", "/" + attemptId + "/"),
  })),
  previousAttempts: [
    ...previous.previousAttempts,
    {
      attemptId: previous.attemptId,
      planPath: priorPlanPath,
      planHash: hash(priorPlanPath),
      failurePath,
      failureHash: hash(failurePath),
    },
  ],
  discoverySnapshot: {
    path: nextDirectory + "/frozen-discovery.json",
    sha256: sha(discoveryBytes),
    discovered: rows.length,
  },
};
requirePlan(plan, { ...dependencies, allowUnwrittenDiscovery: true });
requireMappings(plan, rows);
for (const file of sourcePaths)
  assert(fs.existsSync(path.join(root, file)), "MISSING_SOURCE:" + file);
// Only replace the active plan pointer. Old plans, receipts and failures remain immutable.
write(nextDirectory + "/frozen-discovery.json", discoveryBytes);
write(nextDirectory + "/input-receipt.json", read(receiptPath));
write(nextDirectory + "/freeze-command.json", {
  startedAt,
  finishedAt: new Date().toISOString(),
  collection,
});
write(nextDirectory + "/frozen-plan.json", plan);
write(planPath, plan, false);
console.log(
  JSON.stringify({
    status: "ATTEMPT_FROZEN",
    attemptId,
    planHash: hash(planPath),
    sources: sourcePaths.length,
    discovered: rows.length,
    dedicated: rows.filter((x) => x.file.startsWith("tests/phase015/")).length,
  }),
);
