import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  requireHashCoverage,
  requireReportBinding,
  requireReviewIdentity,
} from "../../scripts/phase-evidence.mjs";
import {
  requireInputs,
  requirePlan,
  requireVitest,
  requireDiscovery,
  requireMappings,
  negativeDefinitions,
  mutate,
  requireNegative,
  requireBusiness,
} from "../../docs/phase-plans/phase014-evidence.mjs";
import {
  root,
  plan,
  planPath,
  receiptPath,
  json,
  read,
  hash,
  git,
} from "../../docs/phase-plans/phase014-runtime.mjs";

const outputArg = process.argv.indexOf("--output");
assert(outputArg >= 0);
const output = path.resolve(process.argv[outputArg + 1]);
assert(output.startsWith(path.join(root, ".scaffold", "phase014") + path.sep));
assert(!fs.existsSync(output));
const results = [];
const reject = (id, operation) => {
  assert.throws(operation, undefined, `${id} must reject`);
  results.push({ id, status: "PASS", observation: "REJECTED" });
};
const deps = { hashFile: hash, readJson: json, readBytes: read, git };
const input = json(receiptPath);
requireInputs(input, deps);
requirePlan(plan, { readJson: json, hashFile: hash });
results.push({ id: "valid-current-input-chain", status: "PASS", observation: "ACCEPTED" });
reject("missing-input", () =>
  requireInputs(input, {
    ...deps,
    hashFile: () => {
      throw new Error("ENOENT");
    },
  }),
);
reject("tampered-input", () => requireInputs(input, { ...deps, hashFile: () => "0".repeat(64) }));
reject("wrong-parent-commit", () => requireInputs(input, { ...deps, git: () => "0".repeat(40) }));
reject("missing-case", () => requirePlan({ ...plan, cases: plan.cases.slice(1) }, deps));
reject("changed-denominator", () =>
  requirePlan(
    { ...plan, cases: plan.cases.map((row, i) => (i ? row : { ...row, denominator: 2 })) },
    deps,
  ),
);
reject("wrong-source-coverage", () => requireHashCoverage({}, plan.sourcePaths, hash, "SELF_TEST"));
const item = plan.cases[0],
  sources = Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(file)]));
const bound = {
  testCaseId: item.testCaseId,
  command: item.command,
  status: "PASS",
  exitCode: 0,
  numerator: 1,
  denominator: 1,
  inputPath: item.inputPath,
  inputHash: hash(item.inputPath),
  planHash: hash(planPath),
  sourceHashes: sources,
};
requireReportBinding(bound, item, hash(planPath), plan.sourcePaths, hash);
reject("tampered-report-input", () =>
  requireReportBinding(
    { ...bound, inputHash: "0".repeat(64) },
    item,
    hash(planPath),
    plan.sourcePaths,
    hash,
  ),
);
reject("wrong-report-case", () =>
  requireReportBinding(
    { ...bound, testCaseId: "wrong" },
    item,
    hash(planPath),
    plan.sourcePaths,
    hash,
  ),
);
reject("stale-report-source", () =>
  requireReportBinding(
    { ...bound, sourceHashes: { ...sources, [item.inputPath]: "0".repeat(64) } },
    item,
    hash(planPath),
    plan.sourcePaths,
    hash,
  ),
);
reject("self-review", () =>
  requireReviewIdentity(
    {
      implementationContextId: plan.implementationContextId,
      contextId: plan.implementationContextId,
      reviewerRunId: "synthetic-only",
      generatedBy: "self-test",
      runnerIdentity: { kind: "INDEPENDENT_CODEX_AGENT", implementationAuthored: false },
    },
    plan.implementationContextId,
  ),
);

const raw = {
  success: true,
  numTotalTests: 1,
  numPassedTests: 1,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  testResults: [
    {
      name: path.join(root, item.inputPath),
      assertionResults: [
        {
          title: "synthetic",
          fullName: "synthetic",
          ancestorTitles: [],
          status: "passed",
          failureMessages: [],
        },
      ],
    },
  ],
};
const rows = requireVitest(raw, { base: root });
requireDiscovery([{ file: path.join(root, item.inputPath), name: "synthetic" }], rows, root);
reject("zero-tests", () => requireVitest({ ...raw, testResults: [] }, { base: root }));
reject("unhandled-error", () =>
  requireVitest({ ...raw, unhandledErrors: ["synthetic"] }, { base: root }),
);
reject("counter-forgery", () => requireVitest({ ...raw, numPassedTests: 999 }, { base: root }));
const skipped = structuredClone(raw);
skipped.numPassedTests = 0;
skipped.numPendingTests = 1;
skipped.testResults[0].assertionResults[0].status = "skipped";
reject("skipped-required-test", () => requireVitest(skipped, { base: root }));
reject("discovery-omission", () => requireDiscovery([], rows, root));
reject("discovery-wrong-file", () =>
  requireDiscovery([{ file: path.join(root, "wrong.test.ts"), name: "synthetic" }], rows, root),
);
reject("missing-case-assertions", () => requireMappings(plan, rows));
for (const definition of negativeDefinitions) {
  const original = read(definition.file).toString();
  assert.notEqual(mutate(definition.id, original), original);
  reject(`missing-mutation-anchor-${definition.id}`, () => mutate(definition.id, ""));
}
const negative = structuredClone(raw);
negative.success = false;
negative.numPassedTests = 0;
negative.numFailedTests = 1;
negative.testResults[0].name = path.join(root, negativeDefinitions[0].testFile);
Object.assign(negative.testResults[0].assertionResults[0], {
  status: "failed",
  fullName: negativeDefinitions[0].pattern,
  failureMessages: ["Test timed out in 10000ms"],
});
reject("infrastructure-is-not-negative-control", () =>
  requireNegative(negative, negativeDefinitions[0], root, (file) => read(file).toString()),
);
negative.testResults[0].assertionResults[0].failureMessages = [
  "AssertionError: expected 503 to be 200",
];
reject("wrong-negative-signal", () =>
  requireNegative(negative, negativeDefinitions[0], root, (file) => read(file).toString()),
);
reject("missing-business-measurements", () => requireBusiness([]));

const testedPaths = [
  "docs/phase-plans/phase014-evidence.mjs",
  "docs/phase-plans/phase014-runtime.mjs",
  "scripts/phase-evidence.mjs",
  "tests/phase014/evidence-guards.mjs",
];
const report = {
  phase: 14,
  status: "PASS",
  simulation: true,
  verificationScope: "EVIDENCE_COLLECTOR_ISOLATED_SELF_TEST",
  productGate: false,
  caseCount: results.length,
  results,
  testedSourceHashes: Object.fromEntries(testedPaths.map((file) => [file, hash(file)])),
};
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ status: "PASS", selfTests: results.length, productGate: false }));
