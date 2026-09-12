import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  root, plan, planPath, read, json, hash, sha, write, command,
  scanSensitiveText, safeDiagnostics,
} from "../../../docs/phase-plans/phase013-runtime.mjs";
import { requirePhase013FailureChain } from "../../../docs/phase-plans/phase013-evidence.mjs";

const output = ".scaffold/phase013/diagnostics/failure-chain-repro-6";
assert.equal(plan.attemptId, "attempt-6");
function save(name, value) {
  scanSensitiveText(JSON.stringify(value), name);
  write(output + "/" + name + ".json", value);
}
if (!process.argv.includes("--probe")) {
  const result = await command("Phase013 actual historical evidence rejection regression", [process.argv[1], "--probe"], { expected: null });
  save("command", result);
  process.exitCode = result.exitCode;
} else {
  const attempt1Path = "docs/evidence/attempts/Phase013/attempt-1/attempt.json";
  const attempt5Path = "docs/evidence/attempts/Phase013/attempt-5/attempt.json";
  const attempt1 = json(attempt1Path), attempt5 = json(attempt5Path);
  const rawPath = "docs/evidence/attempts/Phase013/attempt-5/all-tests-vitest.json";
  const archive = attempt5.archivedFiles.find(entry => entry.sourcePath === "docs/phase-plans/phase013-evidence.mjs");
  const cases = [
    { id: "original-evidence-raw", path: rawPath, expectedHash: attempt5.originalEvidenceHashes[rawPath], receiptPath: attempt5Path, field: "originalEvidenceHashes" },
    { id: "archived-failure-source", path: archive.path, expectedHash: archive.sha256, receiptPath: attempt5Path, field: "archivedFiles" },
    { id: "original-migration-diagnostic", path: attempt1.diagnosticPath, expectedHash: attempt1.diagnosticHash, receiptPath: attempt1Path, field: "diagnosticHash" },
  ];
  const sourcePaths = [...new Set([
    planPath,
    "docs/phase-plans/phase013-evidence.mjs", "docs/phase-plans/verify-phase013.mjs",
    "docs/phase-plans/complete-phase013.mjs", "tests/phase013/evidence-guards.mjs",
    ...plan.previousAttempts.flatMap(entry => [entry.planPath, entry.failurePath]),
    ...cases.map(entry => entry.path),
  ])];
  const inputHashes = Object.fromEntries(sourcePaths.map(file => [file, hash(file)]));
  const results = [];
  let gitCalls = 0;
  try {
    for (const item of cases) {
      assert.equal(hash(item.path), item.expectedHash, "Original historical input must remain intact");
      const overlayPath = output + "/overlays/" + item.id + "/" + item.path;
      const original = read(item.path);
      const changed = Buffer.concat([original, Buffer.from("\n")]);
      scanSensitiveText(changed.toString(), item.id);
      const absolute = path.resolve(root, overlayPath);
      assert(absolute.startsWith(path.resolve(root, output) + path.sep));
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, changed, { flag: "wx" });
      const overlayHash = hash(overlayPath);
      assert.notEqual(overlayHash, item.expectedHash);
      const accessed = new Set();
      const readOverlay = file => {
        accessed.add(file);
        return read(file === item.path ? overlayPath : file);
      };
      let rejected = false, diagnostic = null;
      try {
        requirePhase013FailureChain(plan, {
          readJson: file => JSON.parse(readOverlay(file)),
          hashFile: file => sha(readOverlay(file)),
          git: () => { gitCalls++; throw new Error("Git is prohibited in this isolated diagnostic"); },
        });
      } catch (error) {
        rejected = true;
        diagnostic = safeDiagnostics(error.message);
      }
      results.push({
        id: item.id, expected: "REJECT", observed: rejected ? "REJECT" : "ACCEPT",
        status: rejected ? "PASS" : "FAIL", diagnostic,
        originalPath: item.path, originalHash: item.expectedHash,
        bindingReceiptPath: item.receiptPath, bindingReceiptHash: hash(item.receiptPath), bindingField: item.field,
        overlayPath, overlayHash, overlayMutation: "one LF byte appended in an isolated copy",
        targetReadByHelper: accessed.has(item.path),
      });
    }
    assert.equal(gitCalls, 0);
    for (const [file, expected] of Object.entries(inputHashes)) assert.equal(hash(file), expected);
    save("result", {
      phase: 13, attemptId: plan.attemptId,
      scope: "ISOLATED_FAILURE_CHAIN_OVERLAY_REJECTION_NOT_PRODUCT_ACCEPTANCE",
      status: results.every(entry => entry.status === "PASS") ? "PASS" : "FAIL",
      testCount: results.length, inputHashes, results,
      originalFilesModified: false, productTestsExecuted: false, databaseAccessed: false, gitCalls,
    });
    assert(results.every(entry => entry.status === "PASS"), "Original failure chain accepted altered immutable historical evidence in all three overlays");
  } catch (error) {
    console.warn(safeDiagnostics(error.stack ?? error));
    process.exitCode = 1;
  }
}
