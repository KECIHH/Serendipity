import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { requireReportBinding, requirePriorCaseBinding } from "../../scripts/phase-evidence.mjs";
import {
  validatePhase016Recovery,
  phase016RecoveredCommits,
  phase016RecoveryPath,
} from "../../scripts/phase016-recovery.mjs";
import {
  requireInputs,
  requireSealRecovery,
  requirePlan,
  requireVitest,
  requireMappings,
  requireDiscovery,
  requireNegative,
  negativeDefinitions,
  mutate,
  regexEscape,
  requireCaseExecution,
} from "../../docs/phase-plans/phase016-evidence.mjs";
import {
  root,
  plan,
  planPath,
  receiptPath,
  json,
  read,
  hash,
  sha,
  git,
  npmCli,
  scanSensitiveText,
} from "../../docs/phase-plans/phase016-runtime.mjs";
const output = process.argv[process.argv.indexOf("--output") + 1];
assert(output && output !== process.argv[0]);
const testedPaths = [
  "docs/phase-plans/phase016-evidence.mjs",
  "docs/phase-plans/phase016-runtime.mjs",
  "docs/phase-plans/verify-phase016.mjs",
  "docs/phase-plans/complete-phase016.mjs",
  "scripts/phase-evidence.mjs",
  "scripts/phase016-recovery.mjs",
  "tests/phase016/evidence-guards.mjs",
];
const startedAt = new Date().toISOString(),
  results = [],
  cache = new Map();
const dependencies = {
  readJson: json,
  readBytes: read,
  hashFile: hash,
  git: (args, encoding) => {
    const key = JSON.stringify([args, encoding]);
    if (!cache.has(key)) cache.set(key, git(args, encoding));
    return cache.get(key);
  },
};
function check(name, operation) {
  operation();
  results.push({ name, status: "PASS" });
}
function rejected(name, operation) {
  check(name, () => assert.throws(operation));
}
function raw(rows) {
  const files = new Map();
  for (const row of rows) {
    const list = files.get(row.file) ?? [];
    list.push({
      fullName: row.fullName,
      title: row.fullName,
      ancestorTitles: [],
      status: row.status ?? "passed",
      failureMessages: row.failureMessages ?? [],
    });
    files.set(row.file, list);
  }
  return {
    success: rows.every((x) => !x.status || x.status === "passed"),
    numTotalTests: rows.length,
    numPassedTests: rows.filter((x) => !x.status || x.status === "passed").length,
    numFailedTests: rows.filter((x) => x.status === "failed").length,
    numPendingTests: rows.filter((x) => x.status === "skipped").length,
    numTodoTests: 0,
    testResults: [...files].map(([file, assertionResults]) => ({
      name: path.resolve(root, file),
      assertionResults,
    })),
  };
}
const rows = Object.values(plan.assertionBindings).flat(),
  valid = raw(rows);
if (plan.sealRecovery) {
  check("unsealed checkpoint recovery binds original bytes and both failed shells", () => requireSealRecovery(plan, dependencies));
  for (const [name, mutation] of [
    ["wrong seal failure hash", p => { p.sealRecovery.failure.sha256 = "0".repeat(64); }],
    ["wrong unsealed metadata parent", p => { p.sealRecovery.metadataCommit = p.sealRecovery.artifactCommit; }],
    ["omitted unsealed metadata path", p => { p.sealRecovery.metadataFiles.pop(); }],
    ["changed unsealed archive hash", p => { p.sealRecovery.metadataFiles[0].sha256 = "0".repeat(64); }],
    ["unrelated unsealed metadata path", p => { p.sealRecovery.metadataFiles[0].path = "docs/unrelated.json"; }],
  ]) rejected(name, () => { const candidate = structuredClone(plan); mutation(candidate); requireSealRecovery(candidate, dependencies); });
  const failure = json(plan.sealRecovery.failure.path);
  rejected("missing second failed shell record", () => requireSealRecovery(plan, {
    ...dependencies,
    readJson: file => file === plan.sealRecovery.failure.path ? { ...failure, sealRecords: failure.sealRecords.slice(0, 1) } : json(file),
  }));
  rejected("successful shell cannot be claimed as failed recovery", () => requireSealRecovery(plan, {
    ...dependencies,
    readJson: file => file === failure.sealRecords[0].path ? { ...json(file), exitCode: 0 } : json(file),
  }));
}
check("current plan and restored baseline input binding", () => {
  requirePlan(plan, dependencies);
  requireInputs(json(receiptPath), dependencies);
});
check("current assertion and collection maps", () => {
  const parsed = requireVitest(valid);
  requireMappings(plan, parsed);
  requireDiscovery(
    rows.map((x) => ({ file: path.resolve(x.file), name: x.fullName })),
    parsed,
  );
});
rejected("missing required local input", () =>
  requireInputs(json(receiptPath), {
    ...dependencies,
    hashFile: (file) => {
      if (file === json(receiptPath).pinnedInputs[0].path) throw new Error("MISSING_INPUT");
      return hash(file);
    },
  }),
);
rejected("wrong previous metadata commit", () => {
  const receipt = structuredClone(json(receiptPath));
  receipt.prerequisites.metadataCommit = "0".repeat(40);
  requireInputs(receipt, dependencies);
});
rejected("removed frozen case", () => {
  const changed = structuredClone(plan);
  changed.cases.pop();
  changed.requiredCaseIds.pop();
  requirePlan(changed, dependencies);
});
rejected("changed previous frozen command", () => {
  const changed = structuredClone(plan);
  changed.cases[0].command += " --passWithNoTests";
  requirePlan(changed, dependencies);
});
rejected("omitted assertion despite overall passing summary", () =>
  requireMappings(plan, requireVitest(raw(rows.slice(1)))),
);
rejected("tampered aggregate count", () => {
  const changed = structuredClone(valid);
  changed.numPassedTests++;
  requireVitest(changed);
});
rejected("duplicate raw assertion", () => requireVitest(raw([...rows, rows[0]])));
rejected("silently skipped assertion", () =>
  requireVitest(raw([{ ...rows[0], status: "skipped" }])),
);
rejected("foreign report source", () => {
  const changed = structuredClone(valid);
  changed.testResults[0].name = path.resolve(root, "../foreign.test.ts");
  requireVitest(changed);
});
rejected("missing discovery leaf", () =>
  requireDiscovery(
    rows.slice(1).map((x) => ({ file: path.resolve(x.file), name: x.fullName })),
    requireVitest(valid),
  ),
);
const item = plan.cases[0],
  report = {
    testCaseId: item.testCaseId,
    command: item.command,
    status: "PASS",
    exitCode: 0,
    numerator: 1,
    denominator: 1,
    inputPath: item.inputPath,
    inputHash: hash(item.inputPath),
    planHash: hash(planPath),
    sourceHashes: Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(file)])),
  };
check("exact report bindings", () =>
  requireReportBinding(report, item, hash(planPath), plan.sourcePaths, hash),
);
rejected("stale report source", () => {
  const changed = structuredClone(report);
  changed.sourceHashes[item.inputPath] = "0".repeat(64);
  requireReportBinding(changed, item, hash(planPath), plan.sourcePaths, hash);
});
rejected("unexecuted command alias", () =>
  requireCaseExecution(
    item,
    {
      logicalCommand: item.command,
      result: {
        exitCode: 0,
        timedOut: false,
        arguments: [
          npmCli,
          "run",
          "test",
          "--",
          "unrelated",
          "--reporter=json",
          "--outputFile=fixture",
        ],
      },
      reportHash: "0".repeat(64),
    },
    npmCli,
  ),
);
check("literal mutation filters and unique source anchors", () => {
  for (const definition of negativeDefinitions) {
    assert.notEqual(
      mutate(definition.id, read(definition.file).toString()),
      read(definition.file).toString(),
    );
    assert(new RegExp(regexEscape(definition.pattern)).test(definition.pattern));
    assert(!new RegExp(regexEscape(definition.pattern)).test(definition.pattern.slice(0, -1)));
  }
});
rejected("wrong mutation failed assertion", () =>
  requireNegative(
    raw([
      {
        file: negativeDefinitions[0].testFile,
        fullName: "unrelated failure",
        status: "failed",
        failureMessages: ["AssertionError: unrelated"],
      },
    ]),
    negativeDefinitions[0],
    root,
  ),
);
rejected("mutation import failure is not a business witness", () =>
  requireNegative(
    raw([
      {
        file: negativeDefinitions[0].testFile,
        fullName: negativeDefinitions[0].pattern,
        status: "failed",
        failureMessages: ["Cannot find module"],
      },
    ]),
    negativeDefinitions[0],
    root,
  ),
);
check("reviewed source placeholders require exact path and bytes", () => {
  for (const row of json("tests/phase016/source-scan-allowlist.json").fixtures)
    scanSensitiveText(read(row.path).toString(), row.path);
});
rejected("changed placeholder bytes do not inherit a scan exception", () =>
  scanSensitiveText(read(".env.example").toString() + "\n", ".env.example"),
);
rejected("output cannot reuse a source scan exception", () =>
  scanSensitiveText(read(".env.example").toString(), "output"),
);
rejected("generated run secrets are never exempt", () =>
  scanSensitiveText(json(".scaffold/phase016/full-database.json").encryptionKey, ".env.example"),
);
if (plan.archiveRedactions) {
  const redactions = json(plan.archiveRedactions.path);
  const withoutOriginals = {
    ...dependencies,
    hashFile: (file) => {
      assert(
        !redactions.mappings.some((row) => row.originalPath === file),
        "PRIVATE_ORIGINAL_UNAVAILABLE",
      );
      return hash(file);
    },
    readJson: (file) => {
      assert(
        !redactions.mappings.some((row) => row.originalPath === file),
        "PRIVATE_ORIGINAL_UNAVAILABLE",
      );
      return json(file);
    },
  };
  check("public failed archive is verifiable without local private originals", () =>
    requirePlan(plan, withoutOriginals),
  );
  rejected("tampered redacted archive bytes", () =>
    requirePlan(plan, {
      ...withoutOriginals,
      hashFile: (file) =>
        file === redactions.mappings[0].publicPath
          ? "0".repeat(64)
          : withoutOriginals.hashFile(file),
    }),
  );
  rejected("missing redaction binding cannot replace the original digest", () => {
    const changed = structuredClone(plan);
    delete changed.archiveRedactions;
    requirePlan(changed, withoutOriginals);
  });
}
const recoveryOptions = () => ({
  plan,
  inputReceipt: json(receiptPath),
  recoveryBytes: read(phase016RecoveryPath),
  recoveryCommits: [...phase016RecoveredCommits],
  git: (args) => dependencies.git(args, null),
});
check("prior frozen cases and exact documented corrections", () =>
  requirePriorCaseBinding(plan, json(plan.previousAttempts[0].planPath), dependencies),
);
rejected("missing command correction cannot change a frozen command", () => {
  const changed = structuredClone(plan);
  delete changed.commandCorrection;
  requirePriorCaseBinding(changed, json(plan.previousAttempts[0].planPath), dependencies);
});
rejected("missing expectation correction cannot change a frozen requirement", () => {
  const changed = structuredClone(plan);
  delete changed.expectationCorrection;
  requirePriorCaseBinding(changed, json(plan.previousAttempts[0].planPath), dependencies);
});
rejected("unrelated requirement cannot inherit the narrow correction", () => {
  const changed = structuredClone(plan);
  changed.cases[0].expected = "weakened";
  requirePriorCaseBinding(changed, json(plan.previousAttempts[0].planPath), dependencies);
});
check("exact existing recovery history is accepted", () =>
  validatePhase016Recovery(recoveryOptions()),
);
for (const [name, mutateReceipt] of [
  ["missing recovered commit", (r) => r.commits.pop()],
  ["forged recovered commit", (r) => (r.commits[0].commit = "0".repeat(40))],
  ["wrong parent", (r) => (r.commits[1].parent = r.phaseStartCommit)],
  ["wrong tree", (r) => (r.commits[0].tree = "0".repeat(40))],
  ["forged subject", (r) => (r.commits[0].subject = "phase(016): recovery")],
  ["omitted changed file", (r) => r.commits[0].files.pop()],
  ["tampered recovered blob", (r) => (r.commits[0].files[0].sha256 = "0".repeat(64))],
])
  rejected(name, () => {
    const args = recoveryOptions(),
      receipt = JSON.parse(args.recoveryBytes);
    mutateReceipt(receipt);
    args.recoveryBytes = Buffer.from(JSON.stringify(receipt));
    const binding = { path: phase016RecoveryPath, sha256: sha(args.recoveryBytes) };
    args.plan = { ...plan, recoveryReceipt: binding };
    args.inputReceipt = { ...args.inputReceipt, recoveryReceipt: binding };
    validatePhase016Recovery(args);
  });
rejected("wrong recovery ancestry", () => {
  const args = recoveryOptions();
  args.recoveryCommits.reverse();
  validatePhase016Recovery(args);
});
const evidence = {
  phase: 16,
  status: "PASS",
  caseCount: results.length,
  results,
  testedSourceHashes: Object.fromEntries(testedPaths.map((file) => [file, hash(file)])),
  startedAt,
  finishedAt: new Date().toISOString(),
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({ status: "PASS", caseCount: results.length }));
