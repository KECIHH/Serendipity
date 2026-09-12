import assert from "node:assert/strict";
import path from "node:path";
import {
  root, plan, planPath, directory, hash, read, json, write, command,
  scanSensitiveText, safeDiagnostics,
} from "../../../docs/phase-plans/phase013-runtime.mjs";
import { requirePhase013NegativeControl } from "../../../docs/phase-plans/phase013-evidence.mjs";

const output = ".scaffold/phase013/diagnostics/frame-origin-repro-5";
assert.equal(plan.attemptId, "attempt-5");
function save(name, value) {
  scanSensitiveText(JSON.stringify(value), name);
  write(output + "/" + name + ".json", value);
}
if (!process.argv.includes("--probe")) {
  const result = await command("Phase013 actual first-project-frame rejection regression", [process.argv[1], "--probe"], { expected: null });
  save("command", result);
  process.exitCode = result.exitCode;
} else {
  const qualityPath = directory + "/quality.json";
  const row = json(qualityPath).negativeControls.rows.find(entry => entry.id === "require-admin");
  const baselineRaw = json(row.baselineReportPath);
  const originalNegative = json(row.negativeReportPath);
  const required = row.failureEvidence.contract.requiredFailures[0];
  const proofSources = [
    planPath, qualityPath, row.baselineReportPath, row.negativeReportPath,
    "docs/phase-plans/phase013-evidence.mjs", "docs/phase-plans/verify-phase013.mjs",
    "docs/phase-plans/complete-phase013.mjs", "tests/phase013/evidence-guards.mjs",
  ];
  const sourceHashes = Object.fromEntries(proofSources.map(file => [file, hash(file)]));
  const results = [];
  try {
    for (const [id, insertedFrame] of [
      ["relative-project-frame", "    at helper (tests/phase013/api-key-fixture.ts:1:1)"],
      ["project-frame-missing-column", "    at helper (" + path.join(row.negative.cwd, "tests/phase013/api-key-fixture.ts").replaceAll("\\", "/") + ":1)"],
    ]) {
      const negativeRaw = structuredClone(originalNegative);
      const target = negativeRaw.testResults.flatMap(suite => suite.assertionResults).find(entry => entry.fullName === required.fullName);
      const lines = target.failureMessages[0].split("\n");
      lines.splice(1, 0, insertedFrame);
      target.failureMessages[0] = lines.join("\n");
      save(id + "-synthetic-raw", {
        scope: "ISOLATED_REJECTION_REPRODUCTION_NOT_PRODUCT_ACCEPTANCE",
        syntheticAlteration: true,
        originalReportPath: row.negativeReportPath,
        originalReportHash: hash(row.negativeReportPath),
        insertedFrame,
        raw: negativeRaw,
      });
      let rejected = false, diagnostic = null;
      try {
        requirePhase013NegativeControl(row.id, {
          baselineRaw, baselineRecord: row.baseline,
          negativeRaw, negativeRecord: row.negative,
          expectedContract: row.failureEvidence.contract, readBytes: read,
        });
      } catch (error) {
        rejected = true;
        diagnostic = safeDiagnostics(error.message);
      }
      results.push({ id, expected: "REJECT", observed: rejected ? "REJECT" : "ACCEPT", status: rejected ? "PASS" : "FAIL", diagnostic });
    }
    save("result", {
      phase: 13, attemptId: plan.attemptId,
      scope: "ISOLATED_REJECTION_REPRODUCTION_NOT_PRODUCT_ACCEPTANCE",
      status: results.every(entry => entry.status === "PASS") ? "PASS" : "FAIL",
      testCount: results.length, sourceHashes, results,
      implementationFilesModified: false,
    });
    assert(results.every(entry => entry.status === "PASS"), "Original first-project-frame invariant accepted both malformed fixtures");
  } catch (error) {
    console.warn(safeDiagnostics(error.stack ?? error));
    process.exitCode = 1;
  }
}
