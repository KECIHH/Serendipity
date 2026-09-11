import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  root, plan, planPath, directory, configPath, npmCli,
  read, json, hash, sha, write, npm, dbConfig, scanSensitiveText, safeDiagnostics,
  assertDatabaseTarget, setCommandObserver,
} from "../../../../phase-plans/phase011-runtime.mjs";
import { requireHashCoverage } from "../../../../../scripts/phase-evidence.mjs";

const scriptPath = path.relative(root, fileURLToPath(import.meta.url)).replaceAll("\\", "/");
const reportPath = directory + "/supplemental-observations.json";
const freezePath = directory + "/source-freeze.json";
const originalCases = ["uniform-failure", "guards"].map((key) =>
  plan.cases.find((item) => item.testCaseId === "Phase011:" + key),
);
const startPlanHash = hash(planPath);
const startScriptHash = hash(scriptPath);
const startFreezeHash = hash(freezePath);
const startOriginalCaseReportHashes = Object.fromEntries(originalCases.map((item) =>
  [item.outputPath, hash(item.outputPath)],
));
const startHashes = Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(file)]));
const commands = [];
const artifacts = [];
const results = [];
const startedAt = new Date().toISOString();
let databaseTarget = null;
let failure = null;

function archive(file, value) {
  const bytes = typeof value === "string" || Buffer.isBuffer(value)
    ? value
    : JSON.stringify(value, null, 2) + "\n";
  scanSensitiveText(bytes.toString(), file);
  write(file, bytes);
  const entry = { path: file, sha256: hash(file) };
  artifacts.push(entry);
  return entry;
}

function extractSingleConsoleObject(stdout, key) {
  const prefix = '{"' + key + '":';
  const lines = stripVTControlCharacters(stdout).split(/\r?\n/);
  const matching = lines.filter((line) => line.trim().startsWith(prefix));
  assert.equal(matching.length, 1, "Exactly one real console observation must be captured: " + key);
  const value = JSON.parse(matching[0].trim());
  assert.deepEqual(Object.keys(value), [key]);
  return { value: value[key], capturedJsonLine: matching[0].trim() };
}

function deterministicSchedule() {
  const source = read("tests/integration/admin-login.test.ts").toString();
  assert(source.includes("for (let sample = -1; sample < 16; sample++)"));
  assert(source.includes("for (let step = 0; step < 4; step++)"));
  assert(source.includes("const group = (step + sample + 5) % 4;"));
  const iterations = Array.from({ length: 17 }, (_, offset) => {
    const sample = offset - 1;
    return {
      sampleIndex: sample,
      warmup: sample === -1,
      groupOrder: Array.from({ length: 4 }, (_, step) => (step + sample + 5) % 4),
    };
  });
  return {
    evidenceKind: "DETERMINISTIC_INPUT_SCHEDULE_FROM_FROZEN_SOURCE",
    measuredEventLog: false,
    sourcePath: "tests/integration/admin-login.test.ts",
    sourceHash: hash("tests/integration/admin-login.test.ts"),
    formula: "sample=-1..15; step=0..3; group=(step+sample+5)%4",
    groupDefinitions: ["UNKNOWN_ACCOUNT", "PASSWORD_MISMATCH", "USER_ACCOUNT", "DISABLED_ADMIN"],
    iterations,
    totalScheduledComparisons: 68,
    scheduledWarmups: 4,
    retainedSamples: 64,
    limitation: "This schedule is derived from the frozen sequential source, not fabricated as an independently measured event log.",
  };
}

async function capture(key, observationKey) {
  const item = originalCases.find((candidate) => candidate.testCaseId === "Phase011:" + key);
  const original = json(item.outputPath);
  const rawPath = path.join(root, ".scaffold/phase011/attempt-10-observe-" + key + "-vitest.json");
  assert(!fs.existsSync(rawPath), "A supplemental raw report cannot be overwritten");
  const args = [
    "run", "test", "--", "tests/integration/admin-login.test.ts", "-t", key + ":",
    "--no-file-parallelism", "--reporter=default", "--reporter=json", "--outputFile=" + rawPath,
  ];
  const config = dbConfig();
  const result = await npm(args, {
    expected: null,
    env: {
      DATABASE_URL: config.appUrl,
      PHASE007_DATABASE_URL: config.url,
      PHASE008_DATABASE_URL: config.url,
      PHASE009_DATABASE_URL: config.url,
      PHASE009_RUNTIME_DATABASE_URL: config.appUrl,
      PHASE010_FIXTURE_CONFIG: path.join(root, configPath),
      PHASE011_FIXTURE_CONFIG: path.join(root, configPath),
    },
  });
  const stdout = archive(directory + "/observations/" + key + ".stdout.txt", result.stdout);
  const stderr = archive(directory + "/observations/" + key + ".stderr.txt", result.stderr);
  assert(fs.existsSync(rawPath), "The real reporter must produce its JSON file");
  const rawBytes = fs.readFileSync(rawPath);
  scanSensitiveText(rawBytes.toString(), key + " raw Vitest JSON");
  const raw = JSON.parse(rawBytes);
  const rawReport = archive(directory + "/observations/" + key + "-vitest.json", rawBytes);
  assert.equal(result.exitCode, 0, "The supplemental test process must actually succeed");
  assert.equal(result.timedOut, false);
  assert.equal(raw.success, true);
  assert.equal(raw.numFailedTests, 0);
  assert.equal(raw.numRuntimeErrorTestSuites ?? 0, 0);
  assert.equal(raw.numPassedTests, original.details.tests, "All original selected assertions must run");
  const assertions = raw.testResults.flatMap((suite) => suite.assertionResults);
  const passed = assertions.filter((item) => item.status === "passed");
  assert(passed.length > 0 && passed.every((item) => item.fullName.includes(key + ":")));
  const extracted = extractSingleConsoleObject(result.stdout, observationKey);
  const entry = {
    caseId: item.testCaseId,
    status: "CAPTURED",
    originalCaseReport: { path: item.outputPath, sha256: startOriginalCaseReportHashes[item.outputPath] },
    command: result.command,
    executable: result.executable,
    arguments: result.arguments,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    passedTests: raw.numPassedTests,
    passedAssertions: passed.map((item) => item.fullName),
    stdout, stderr, rawReport,
    observationKey,
    observed: extracted.value,
    capturedJsonLine: extracted.capturedJsonLine,
  };
  results.push(entry);
  return entry;
}

setCommandObserver((observation) => {
  scanSensitiveText(JSON.stringify(observation), "supplemental command");
  commands.push(observation);
});

try {
  assert.equal(plan.attemptId, "attempt-10");
  assert.equal(plan.phase, 11);
  assert.equal(plan.sourcePaths.length, 174);
  assert(!fs.existsSync(path.join(root, directory, "attempt.json")));
  assert(!fs.existsSync(path.join(root, reportPath)));
  assert.equal(hash(directory + "/frozen-plan.json"), startPlanHash);
  const freeze = json(freezePath);
  assert.equal(freeze.planHash, startPlanHash);
  assert.deepEqual(freeze.sourceHashes, startHashes);
  for (const item of originalCases) {
    assert(item);
    const original = json(item.outputPath);
    assert.equal(original.status, "PASS");
    assert.equal(original.planHash, startPlanHash);
    assert.deepEqual(original.sourceHashes, startHashes);
  }
  assert.equal(json(".scaffold/tools/node_modules/npm/package.json").version, "11.7.0");
  const version = await npm(["--version"]);
  assert.equal(version.stdout.trim(), "11.7.0");
  databaseTarget = await assertDatabaseTarget();
  const timing = await capture("uniform-failure", "authTiming");
  const observed = timing.observed;
  assert.equal(observed.samplesPerGroup, 16);
  assert.equal(observed.warmupPerGroup, 1);
  assert.equal(observed.alpha, 0.01);
  assert.equal(observed.maxMedianRatio, 1.5);
  assert.equal(observed.samplesMs.length, 4);
  assert(observed.samplesMs.every((group) => group.length === 16));
  assert(observed.samplesMs.flat().every((value) => Number.isInteger(value) && value >= 0));
  assert.equal(observed.samplesMs.flat().length, 64);
  assert.equal(observed.medians.length, 4);
  assert(observed.medians.every((value) => Number.isFinite(value) && value > 0));
  assert(Number.isFinite(observed.medianRatio) && observed.medianRatio >= 1 && observed.medianRatio <= 1.5);
  assert(Number.isFinite(observed.permutationP) && observed.permutationP >= 0.01 && observed.permutationP <= 1);
  timing.deterministicInputSchedule = deterministicSchedule();
  timing.samplePrecision = "Integer milliseconds rounded by the frozen test console output";
  timing.statisticPrecision = "The frozen test computes medians, medianRatio and permutationP from its original unrounded elapsed times";
  timing.status = "PASS";
  const guards = await capture("guards", "guardObservation");
  assert.deepEqual(guards.observed, {
    status: "PASS",
    deniedRoute: [401, 403, 401],
    deniedAction: [401, 403, 401],
    unauthorizedQueries: 0,
    unauthorizedWrites: 0,
    authorizedQueries: 2,
    authorizedWrites: 2,
    revokedRoute: 401,
    revokedAction: 401,
    requestContext: "REAL_NEXT_REQUEST_STORE",
    database: "REAL_POSTGRESQL17",
  });
  guards.status = "PASS";
  assert.equal(hash(planPath), startPlanHash);
  assert.equal(hash(scriptPath), startScriptHash);
  assert.equal(hash(freezePath), startFreezeHash);
  requireHashCoverage(startHashes, plan.sourcePaths, hash, "SUPPLEMENTAL_SOURCE_CHANGED");
  for (const [file, expected] of Object.entries(startOriginalCaseReportHashes)) assert.equal(hash(file), expected);
} catch (error) {
  failure = safeDiagnostics(error.stack ?? error);
  process.exitCode = 1;
} finally {
  setCommandObserver(null);
}

const report = {
  schemaVersion: 1,
  phase: 11,
  attemptId: plan.attemptId,
  status: failure ? "FAIL" : "PASS",
  evidenceKind: "SAME_FROZEN_SOURCE_NEW_REAL_OBSERVATIONS",
  originalStatisticsCaptured: false,
  limitation: "The original JSON-only invocations did not retain authTiming or guardObservation. These are new real invocations of the unchanged frozen source; no earlier timing values are reconstructed or replaced.",
  originalCaseReportsUnmodified: Object.entries(startOriginalCaseReportHashes).every(([file, expected]) => hash(file) === expected),
  originalCaseReportHashesBefore: startOriginalCaseReportHashes,
  originalCaseReportHashesAfter: Object.fromEntries(originalCases.map((item) => [item.outputPath, hash(item.outputPath)])),
  planPath,
  planHash: startPlanHash,
  sourceFreeze: { path: freezePath, sha256: startFreezeHash, sha256After: hash(freezePath) },
  sourceHashes: startHashes,
  sourceHashesAfter: Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(file)])),
  captureScript: { path: scriptPath, sha256: startScriptHash, sha256After: hash(scriptPath) },
  captureCommand: "node " + scriptPath,
  captureExitCode: failure ? 1 : 0,
  runtime: { nodeVersion: process.version, npmVersion: "11.7.0", npmCliPath: path.relative(root, npmCli).replaceAll("\\", "/"), npmCliHash: hash(path.relative(root, npmCli)) },
  databaseTarget,
  results,
  commands,
  artifacts,
  simulation: true,
  productionTraffic: false,
  secretScan: { hits: 0, scannedBeforeArchival: true },
  startedAt,
  recordedAt: new Date().toISOString(),
  ...(failure ? { diagnostic: failure } : {}),
};
archive(reportPath, report);
if (failure) {
  const failurePath = directory + "/attempt.json";
  if (!fs.existsSync(path.join(root, failurePath))) {
    write(failurePath, {
      phase: 11, attemptId: plan.attemptId, status: "FAIL", kind: "SUPPLEMENTAL_OBSERVATION",
      artifactCommit: null, command: report.captureCommand, exitCode: 1, planHash: startPlanHash,
      reason: failure, supplementalReport: { path: reportPath, sha256: hash(reportPath) },
      recordedAt: new Date().toISOString(),
    });
  }
}
console.log(JSON.stringify({ status: report.status, reportPath, reportHash: hash(reportPath), observations: results.length }));
