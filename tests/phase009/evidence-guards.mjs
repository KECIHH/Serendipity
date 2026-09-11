import { requirePriorCaseBinding } from "../../scripts/phase-evidence.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  requirePhase009Preflight,
  requirePhase009Generation,
  requirePhase009FailureChain,
  requirePhase009ImplementationBinding,
  createPhase009RetryPlan,
} from "../../docs/phase-plans/phase009-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readText = (file) => fs.readFileSync(path.join(root, file), "utf8");
const readJson = (file) => JSON.parse(readText(file));
const hashFile = (file) => hash(fs.readFileSync(path.join(root, file)));
const plan = readJson("docs/phase-plans/Phase009.json");
const receipt = readJson("docs/phase-plans/Phase009-inputs.json");
const generation = readJson("docs/evidence/attempts/Phase009/setup/migration-generation.json");
const dependencies = {
  receipt,
  hashFile,
  readText,
  migrationPath: generation.generatedMigrationPath,
};
const results = [];
function check(name, operation) {
  operation();
  results.push({ name, status: "PASS" });
}

check("actual preflight requires both successful distinct shells", () =>
  requirePhase009Preflight(receipt.preflight),
);
for (const [name, change] of [
  [
    "duplicate-shell",
    (value) => {
      value.shells[1] = value.shells[0];
    },
  ],
  [
    "wrong-phase",
    (value) => {
      value.phase = 8;
    },
  ],
  [
    "dirty-worktree",
    (value) => {
      value.workingTree = " M source";
    },
  ],
  [
    "wrong-parent",
    (value) => {
      value.shells[0].result.metadataCommit = "0".repeat(40);
    },
  ],
  [
    "unsynced-remote",
    (value) => {
      value.originMain = "0".repeat(40);
    },
  ],
])
  check(`reject preflight ${name}`, () => {
    const value = structuredClone(receipt.preflight);
    change(value);
    assert.throws(() => requirePhase009Preflight(value));
  });
check("actual generated migration has immutable SQL and schema bindings", () =>
  requirePhase009Generation(generation, dependencies),
);
for (const [name, change] of [
  [
    "altered-sql-hash",
    (value) => {
      value.migrationHash = "0".repeat(64);
    },
  ],
  [
    "missing-generation-command",
    (value) => {
      value.records = [];
    },
  ],
  [
    "failed-generation",
    (value) => {
      value.records.find((record) => record.arguments?.includes("--create-only")).exitCode = 1;
    },
  ],
  [
    "missing-old-migration",
    (value) => {
      value.previousMigrations.pop();
    },
  ],
])
  check(`reject migration ${name}`, () => {
    const value = structuredClone(generation);
    change(value);
    assert.throws(() => requirePhase009Generation(value, dependencies));
  });
check("actual failure history is complete and frozen", () =>
  requirePhase009FailureChain(plan, { readJson, hashFile }),
);
check("retry preserves prior plan and failure hashes", () => {
  const old = { ...structuredClone(plan), attemptId: "attempt-1", previousAttempts: [] };
  const frozenPath = "docs/evidence/attempts/Phase009/attempt-1/frozen-plan.json";
  const failurePath = "docs/evidence/attempts/Phase009/attempt-1/attempt.json";
  const bytes = (value) => JSON.stringify(value);
  const files = new Map([[frozenPath, bytes(old)]]);
  files.set(
    failurePath,
    bytes({
      phase: 9,
      attemptId: "attempt-1",
      status: "FAIL",
      planHash: hash(files.get(frozenPath)),
      artifactCommit: null,
    }),
  );
  const readers = {
    readJson: (file) => JSON.parse(files.get(file)),
    hashFile: (file) => hash(files.get(file)),
  };
  const next = createPhase009RetryPlan(old, readers);
  assert.equal(next.attemptId, "attempt-2");
  assert.equal(next.previousAttempts[0].failureHash, readers.hashFile(failurePath));
  const missing = structuredClone(next);
  missing.previousAttempts = [];
  assert.throws(() => requirePhase009FailureChain(missing, readers));
  files.set(
    failurePath,
    bytes({
      phase: 9,
      attemptId: "attempt-1",
      status: "PASS",
      planHash: hash(files.get(frozenPath)),
      artifactCommit: null,
    }),
  );
  next.previousAttempts[0].failureHash = readers.hashFile(failurePath);
  assert.throws(() => requirePhase009FailureChain(next, readers));
});
check("implementation bytes and inventory cannot change after verification", () => {
  const before = { "src/a.ts": "1".repeat(64) };
  requirePhase009ImplementationBinding(before, { ...before });
  assert.throws(() => requirePhase009ImplementationBinding(before, { "src/a.ts": "2".repeat(64) }));
  assert.throws(() =>
    requirePhase009ImplementationBinding(before, { ...before, "src/b.ts": "2".repeat(64) }),
  );
});

check("actual appended review requirements preserve each frozen prior plan", () => {
  for (const previous of plan.previousAttempts)
    requirePriorCaseBinding(plan, readJson(previous.planPath), { readJson, hashFile });
});
for (const [name, change] of [
  [
    "undeclared expectation change",
    (value) => {
      value.expectationExtensions = [];
    },
  ],
  [
    "wrong extension hash",
    (value) => {
      value.expectationExtensions[0].priorPlanHash = "0".repeat(64);
    },
  ],
  [
    "changed original text",
    (value) => {
      value.expectationExtensions[0].originalExpected = "different original requirement";
    },
  ],
  [
    "removed original prefix",
    (value) => {
      value.cases.find(
        (item) => item.testCaseId === value.expectationExtensions[0].testCaseId,
      ).expected = value.expectationExtensions[0].appendedExpected;
    },
  ],
  [
    "duplicate extension receipt",
    (value) => {
      value.expectationExtensions.push(value.expectationExtensions[0]);
    },
  ],
  [
    "changed frozen command",
    (value) => {
      value.cases[0].command = "echo success";
    },
  ],
  [
    "changed denominator",
    (value) => {
      value.cases[0].denominator += 1;
    },
  ],
  [
    "changed input path",
    (value) => {
      value.cases[0].inputPath = "different.ts";
    },
  ],
  [
    "removed case",
    (value) => {
      value.cases.shift();
    },
  ],
])
  check("reject " + name, () => {
    const value = structuredClone(plan);
    change(value);
    assert.throws(() =>
      requirePriorCaseBinding(value, readJson(plan.previousAttempts[0].planPath), {
        readJson,
        hashFile,
      }),
    );
  });

const outputArg = process.argv.indexOf("--output");
const report = {
  status: "PASS",
  phase: 9,
  results,
  caseCount: results.length,
  testedSourceHashes: Object.fromEntries(
    ["docs/phase-plans/phase009-evidence.mjs", "tests/phase009/evidence-guards.mjs"].map((file) => [
      file,
      hashFile(file),
    ]),
  ),
};
if (outputArg !== -1) {
  const target = path.resolve(process.argv[outputArg + 1]);
  assert(target.startsWith(path.join(root, ".scaffold/phase009") + path.sep));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
}
console.warn(JSON.stringify({ status: report.status, caseCount: report.caseCount }));
