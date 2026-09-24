import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as runtime from "./phase018-runtime.mjs";
import { audit, checkNegative, dedicatedArgs, dedicatedCommand, dedicatedFiles, mutate, negatives, planPath, receiptPath, requireDiscovery, requireInputs, requirePlan, requireVitest } from "./phase021-evidence.mjs";

const { command, environment, hash, json, npmCli, npmRun, read, resetDatabase, resetRegression, root, scan, write } = runtime;
const plan = json(planPath);
const directory = `docs/evidence/attempts/Phase021/${plan.attemptId}`;
const negativeOnly = process.argv.includes("--negative-controls");
const archiveRoot = negativeOnly ? `${directory}/negative` : directory;
const context = { ...runtime, directory };
const records = [];
const artifacts = [];
const startedAt = new Date().toISOString();
const sourceHashes = Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(file)]));
function archive(name, value) {
  const file = `${archiveRoot}/${name}`;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  scan(text, file);
  write(file, value);
  artifacts.push({ path: file, sha256: hash(file) });
  return file;
}
function record(label, result, exitCode = 0) {
  records.push(result);
  archive(`commands/${String(records.length).padStart(3, "0")}.json`, result);
  assert.equal(result.exitCode, exitCode, `${label}:${result.stderr}`);
  assert.equal(result.timedOut, false);
  return result;
}
function stable() {
  for (const [file, expected] of Object.entries(sourceHashes)) assert.equal(hash(file), expected, `SOURCE_CHANGED:${file}`);
}
function test(name, selectors = dedicatedArgs) {
  const scratchPath = path.join(root, `.scaffold/phase021/${plan.attemptId}-${name}.json`);
  const result = record(name, npmRun("test", ["--", ...selectors, "--reporter=json", `--outputFile=${scratchPath}`], { env: environment(), timeoutMs: 900000 }));
  const reportPath = archive(`${name}.json`, fs.readFileSync(scratchPath, "utf8"));
  const rows = requireVitest(json(reportPath), { base: root });
  const selected = json(plan.discoverySnapshot.path).filter((row) => !selectors.length || dedicatedFiles.includes(path.relative(root, row.file).replaceAll("\\", "/")));
  requireDiscovery(selected, rows, root);
  return { logicalCommand: selectors.length ? dedicatedCommand : "npm run test", scratchPath, result, reportPath, reportHash: hash(reportPath), count: rows.length };
}
try {
  assert(!fs.existsSync(path.join(root, directory, "attempt.json")), "FAILED_ATTEMPT");
  requirePlan(plan, context);
  requireInputs(json(receiptPath), context);
  assert.equal(hash(`${directory}/frozen-plan.json`), hash(planPath));
  if (negativeOnly) {
    const rows = [];
    for (const definition of negatives) {
      const target = path.join(root, definition.file);
      const original = read(definition.file).toString();
      const originalHash = hash(definition.file);
      const changed = mutate(definition, original);
      try {
        fs.writeFileSync(target, changed);
        const scratch = path.join(root, `.scaffold/phase021/${plan.attemptId}-${definition.id}.json`);
        const result = record(definition.id, command(process.execPath, [npmCli, "run", "test", "--", definition.test, "-t", definition.pattern, "--reporter=json", `--outputFile=${scratch}`], { cwd: root, env: environment(), timeoutMs: 180000 }), 1);
        const reportPath = archive(`${definition.id}.json`, fs.readFileSync(scratch, "utf8"));
        rows.push({ id: definition.id, originalHash, mutatedHash: runtime.sha(Buffer.from(changed)), testHash: hash(definition.test), result, reportPath, reportHash: hash(reportPath), failure: checkNegative(json(reportPath), definition, root) });
      } finally { fs.writeFileSync(target, original); }
    }
    stable();
    archive("summary.json", { status: "PASS", rows, artifacts });
  } else {
    assert(process.argv.includes("--all"), "Use --all or --negative-controls");
    const supporting = [];
    for (const [id, operation] of [["schema", () => command(process.execPath, ["scripts/generate-ai-schemas.mjs", "--check"])], ["typecheck", () => npmRun("typecheck", [], { env: environment() })], ["lint", () => npmRun("lint", [], { env: environment() })], ["format", () => npmRun("format:check", [], { env: environment() })], ["layout", () => command(process.execPath, ["scripts/check-project-layout.mjs"])], ["whitespace", () => command("git", ["diff", "--check"])], ["guards", () => command(process.execPath, ["tests/nlu/evidence-guards.mjs"])]]) supporting.push({ id, result: record(id, operation()) });
    for (const result of [...(await resetRegression()), await resetDatabase()]) record("database reset", result);
    const full = test("full-tests", []);
    const dedicated = test("dedicated-tests");
    record("negative controls", command(process.execPath, ["docs/phase-plans/verify-phase021.mjs", "--negative-controls"], { timeoutMs: 300000 }));
    const negative = json(`${directory}/negative/summary.json`);
    const restored = test("restored-tests");
    supporting.push({ id: "build", result: record("build", npmRun("build", [], { env: environment(), timeoutMs: 300000 })) });
    stable();
    const rows = requireVitest(json(restored.reportPath), { base: root });
    for (const [index, item] of plan.cases.entries()) {
      const assertions = index < 5 ? rows.filter((row) => plan.assertionBindings[item.testCaseId].some((binding) => binding.file === row.file && binding.fullName === row.fullName)).map(({ file, fullName }) => ({ file, fullName })) : null;
      if (index < 5) assert.equal(assertions.length, plan.assertionBindings[item.testCaseId].length);
      archive(item.outputPath.slice(directory.length + 1), { testCaseId: item.testCaseId, command: item.command, status: "PASS", exitCode: 0, numerator: item.denominator, denominator: item.denominator, inputPath: item.inputPath, inputHash: hash(item.inputPath), planHash: hash(planPath), sourceHashes, simulation: true, productionTraffic: false, details: index < 5 ? { assertions, rawReportPath: restored.reportPath, actualExecution: restored.result } : { controls: negative.rows } });
    }
    const quality = { status: "PASS", phase: 21, attemptId: plan.attemptId, planHash: hash(planPath), sourceHashes, full, dedicated, restored, negative, supporting, testCount: full.count, dedicatedCount: restored.count, observations: records, artifacts: [...artifacts, ...negative.artifacts, { path: `${directory}/negative/summary.json`, sha256: hash(`${directory}/negative/summary.json`) }], scan: { hits: 0, files: plan.sourcePaths.length }, costAccounting: { startedAt, finishedAt: new Date().toISOString(), crossAttemptReuse: "disabled" } };
    archive("quality.json", quality);
    audit(plan, context, false);
    console.log(JSON.stringify({ status: "PASS", tests: full.count, dedicated: restored.count }));
  }
} catch (error) {
  const message = String(error.stack ?? error);
  if (!negativeOnly) write(`${directory}/attempt.json`, { phase: 20, attemptId: plan.attemptId, status: "FAIL", blockedCategory: "VERIFICATION", artifactCommit: null, planHash: hash(planPath), error: message, observations: records }, false);
  console.error(message);
  process.exitCode = 1;
}
