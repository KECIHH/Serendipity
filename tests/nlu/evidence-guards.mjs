import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  requireVitest,
  requireDiscovery,
  requireExecution,
  checkNegative,
  negatives,
  mutate,
} from "../../docs/phase-plans/phase019-evidence.mjs";
import {
  requireHashCoverage,
  requireReportBinding,
  requireReviewIdentity,
} from "../../scripts/phase-evidence.mjs";
const root = process.cwd(),
  results = [];
const reject = (id, run) => {
  assert.throws(run);
  results.push({ id, status: "PASS" });
};
const raw = {
  success: true,
  numTotalTests: 1,
  numPassedTests: 1,
  numFailedTests: 0,
  numPendingTests: 0,
  numRuntimeErrors: 0,
  testResults: [
    {
      name: path.join(root, "tests/nlu/origin.test.ts"),
      assertionResults: [
        {
          ancestorTitles: ["core origin extraction"],
          title: "识别从深圳出发",
          fullName: "core origin extraction 识别从深圳出发",
          status: "passed",
          failureMessages: [],
        },
      ],
    },
  ],
};
const rows = requireVitest(raw, { base: root });
reject("missing-report", () => requireVitest(null));
reject("counter-tamper", () => requireVitest({ ...raw, numTotalTests: 2 }));
reject("missing-assertion", () =>
  requireDiscovery(
    [{ file: path.join(root, "tests/nlu/origin.test.ts"), name: "missing" }],
    rows,
    root,
  ),
);
reject("skipped-test", () =>
  requireVitest({
    ...raw,
    numPassedTests: 0,
    numPendingTests: 1,
    testResults: [
      {
        ...raw.testResults[0],
        assertionResults: [{ ...raw.testResults[0].assertionResults[0], status: "skipped" }],
      },
    ],
  }),
);
reject("empty-test-run", () => requireVitest({ ...raw, testResults: [] }));
reject("runtime-failure", () => requireVitest({ ...raw, numRuntimeErrors: 1 }));
reject("missing-source", () => requireHashCoverage({}, ["source"], () => "a".repeat(64), "SOURCE"));
reject("source-tamper", () =>
  requireHashCoverage({ source: "b".repeat(64) }, ["source"], () => "a".repeat(64), "SOURCE"),
);
reject("missing-plan-binding", () =>
  requireReportBinding({}, { testCaseId: "case" }, "a".repeat(64), [], () => ""),
);
reject("author-self-review", () =>
  requireReviewIdentity(
    { runnerIdentity: { kind: "INDEPENDENT_CODEX_AGENT", implementationAuthored: true } },
    "root",
  ),
);
reject("green-mutation", () => checkNegative(raw, negatives[1], root));
for (const definition of negatives) {
  const original = fs.readFileSync(definition.file, "utf8");
  assert.notEqual(mutate(definition, original), original);
  reject("missing-anchor-" + definition.id, () => mutate(definition, ""));
}
const def = negatives[1];
const negative = {
  ...raw,
  success: false,
  numPassedTests: 0,
  numFailedTests: 1,
  testResults: [
    {
      name: path.join(root, def.test),
      assertionResults: [
        {
          ancestorTitles: ["core origin extraction"],
          title: def.pattern,
          fullName: "core origin extraction " + def.pattern,
          status: "failed",
          failureMessages: [def.witness],
        },
      ],
    },
  ],
};
assert.equal(checkNegative(negative, def, root).witness, def.witness);
reject("wrong-negative-cause", () =>
  checkNegative(
    {
      ...negative,
      testResults: [
        {
          ...negative.testResults[0],
          assertionResults: [
            {
              ...negative.testResults[0].assertionResults[0],
              failureMessages: ["MODULE_NOT_FOUND"],
            },
          ],
        },
      ],
    },
    def,
    root,
  ),
);
const execution = {
  logicalCommand: "npm run test",
  reportPath: "raw",
  reportHash: "hash",
  scratchPath: "scratch",
  result: {
    exitCode: 0,
    timedOut: false,
    cwd: root,
    executable: process.execPath,
    arguments: ["npm", "run", "test", "--", "--reporter=json", "--outputFile=scratch"],
  },
};
const ctx = { json: () => raw, hash: () => "hash", root, npmCli: "npm" };
requireExecution(execution, ctx);
reject("wrong-report-source", () => requireExecution({ ...execution, reportHash: "wrong" }, ctx));
reject("wrong-command", () =>
  requireExecution(
    { ...execution, result: { ...execution.result, arguments: ["npm", "run", "build"] } },
    ctx,
  ),
);
reject("wrong-command-root", () =>
  requireExecution({ ...execution, result: { ...execution.result, cwd: "elsewhere" } }, ctx),
);
console.log(JSON.stringify({ status: "PASS", checks: results.length, results }));
