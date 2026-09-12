import {
  requirePhase013Inputs,
  requirePhase013Generation,
  requirePhase013FailureChain,
  createPhase013RetryPlan,
  requirePhase013ImplementationBinding,
  getPhase013ImplementationSnapshot,
  requirePhase013Vitest,
  requirePhase013CaseMapping,
  requirePhase013Discovery,
  phase013BusinessObservations,
  phase013FixtureBinding,
  requirePhase013BrowserReport,
  phase013NegativeControlDefinitions,
  requirePhase013NegativeControl,
  requirePhase013ScopeRepair,
} from "./phase013-evidence.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  requireHashCoverage,
  requireReportBinding,
  requireReviewIdentity,
  requirePriorCaseBinding,
} from "../../scripts/phase-evidence.mjs";
import {
  root,
  plan,
  planPath,
  receiptPath,
  directory,
  generationPath,
  migrationPath,
  imageDigest,
  read,
  json,
  hash,
  sha,
  write,
  git,
  inventory,
  scanSensitiveText,
} from "./phase013-runtime.mjs";

const reviewPath = `${directory}/review.json`;
const qualityPath = `${directory}/quality.json`;
const gatePath = "docs/evidence/Phase013-gate.json";
const requiredCaseIds = [
  "create-read",
  "disable-enable",
  "rotate-revoke",
  "authorization",
  "crypto-redaction",
  "failure-atomicity",
].map((key) => `Phase013:${key}`);

function audit(requireReview = true) {
  assert(!fs.existsSync(path.join(root, directory, "attempt.json")), "Failed attempt cannot seal");
  assert.equal(plan.phase, 13);
  assert.deepEqual(plan.requiredCaseIds, requiredCaseIds);
  assert.deepEqual(
    plan.cases.map((item) => item.testCaseId),
    requiredCaseIds,
  );
  assert.equal(plan.threshold.originalThreshold, 6);
  assert.equal(plan.threshold.automatedThreshold, 6);
  assert.equal(plan.threshold.requiredPassRate, 1);
  assert.equal(plan.threshold.waived, false);
  assert.equal(
    hash(`${directory}/frozen-plan.json`),
    hash(planPath),
    "Current attempt plan changed after freezing",
  );
  const receipt = json(receiptPath);
  requirePhase013Inputs(receipt, { hashFile: hash, readJson: json, readBytes: read, git });
  assert.equal(plan.testMode, "full");
  assert.equal(plan.crossAttemptReuse, "disabled");
  assert(plan.sourcePaths.includes(receipt.validationPolicy.path));
  assert.equal(
    hash(receipt.preflight.reportPath),
    receipt.preflight.reportHash,
    "PREFLIGHT_HASH: original admission report changed",
  );
  for (const [field, value] of Object.entries(json(receipt.preflight.reportPath)))
    assert.deepEqual(receipt.preflight[field], value, `PREFLIGHT_BINDING: ${field}`);
  requirePhase013FailureChain(plan, { readJson: json, hashFile: hash, git });
  assert.equal(receipt.phase, 13);
  assert.equal(receipt.requestedThrough, 13);
  for (const input of receipt.pinnedInputs) assert.equal(hash(input.path), input.sha256);
  assert.equal(hash(receipt.prerequisites.migrationPath), receipt.prerequisites.migrationHash);
  assert.equal(
    sha(git(["show", `${receipt.phaseStartCommit}:${receipt.prerequisites.schemaPath}`], null)),
    receipt.prerequisites.schemaHash,
  );
  for (const previous of plan.previousAttempts) {
    assert.equal(hash(previous.planPath), previous.planHash);
    const old = json(previous.planPath);
    assert.equal(old.phase, 13);
    assert.equal(old.attemptId, previous.attemptId);
    requirePriorCaseBinding(plan, old, { readJson: json, hashFile: hash });
  }
  const reports = plan.cases.map((item) => {
    const report = json(item.outputPath);
    requireReportBinding(report, item, hash(planPath), plan.sourcePaths, hash);
    assert.equal(report.simulation, true);
    assert.equal(report.productionTraffic, false);
    assert(Array.isArray(report.details.artifacts));
    for (const artifact of report.details.artifacts)
      assert.equal(hash(artifact.path), artifact.sha256);
    return report;
  });
  const generation = json(generationPath);
  requirePhase013Generation(generation, {
    receipt,
    hashFile: hash,
    readText: (file) => read(file).toString(),
    migrationPath,
  });
  for (const report of reports)
    assert(
      report.details.artifacts.some(
        (artifact) =>
          artifact.path === migrationPath && artifact.sha256 === generation.migrationHash,
      ),
    );
  const quality = json(qualityPath);
  assert.equal(quality.status, "PASS");
  requirePhase013ImplementationBinding(
    quality.implementationSnapshot,
    getPhase013ImplementationSnapshot({
      root,
      plan,
      receipt,
      git,
      hashFile: hash,
      inventory,
      migrationPath,
    }),
  );
  assert.equal(quality.planHash, hash(planPath));
  assert.equal(quality.phase, 13);
  assert.equal(quality.attemptId, plan.attemptId);
  assert.equal(quality.testMode, "full");
  assert.equal(quality.crossAttemptReuse, "disabled");
  assert.equal(quality.simulation, true);
  assert.equal(quality.productionTraffic, false);
  assert.deepEqual(quality.supportingChecks, plan.supportingChecks);
  assert.deepEqual(
    quality.supportingResults.map((entry) => entry.checkId),
    plan.supportingChecks,
  );
  assert(quality.supportingResults.every((entry) => entry.status === "PASS"));
  const pkg = json("package.json");
  const executionPaths = [
    ...new Set([
      ...Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).map(
        (name) => `node_modules/${name}/package.json`,
      ),
      ".scaffold/tools/node_modules/npm/package.json",
      ".scaffold/tools/node_modules/npm/bin/npm-cli.js",
      "node_modules/prisma/build/index.js",
      "node_modules/.prisma/client/schema.prisma",
      "node_modules/vitest/vitest.mjs",
      "node_modules/tsx/dist/cli.mjs",
      "vitest/stubs/server-only.ts",
      "scripts/test-phase-input-paths.mjs",
      "scripts/verify-phase003.mjs",
      "scripts/phase003-evidence.mjs",
      "scripts/checkpoint-history.mjs",
    ]),
  ].sort();
  requireHashCoverage(
    quality.executionDependencyHashes,
    executionPaths,
    hash,
    "EXECUTION_DEPENDENCY_HASH",
  );
  requireHashCoverage(quality.sourceHashes, plan.sourcePaths, hash, "QUALITY_SOURCE_HASH");
  assert(Number.isInteger(quality.testCount) && quality.testCount > 0);
  assert(quality.observations.length >= 10);
  assert(
    quality.observations.every(
      (entry) =>
        !entry.timedOut &&
        (entry.exitCode === 0 ||
          quality.negativeControls.rows.some(
            (row) =>
              row.negative.command === entry.command &&
              row.negative.exitCode === entry.exitCode &&
              entry.exitCode !== 0,
          )),
    ),
  );
  for (const artifact of quality.artifacts) assert.equal(hash(artifact.path), artifact.sha256);
  const cardPath = directory + "/card-vitest.json";
  const cardAssertions = requirePhase013Vitest(json(cardPath), { base: root });
  const mappings = requirePhase013CaseMapping(plan, cardAssertions);
  const mappingPath = directory + "/case-assertion-mapping.json";
  const mappingReport = json(mappingPath);
  assert.equal(mappingReport.planHash, hash(planPath));
  assert.equal(mappingReport.sourceReportPath, cardPath);
  assert.equal(mappingReport.sourceReportHash, hash(cardPath));
  assert.deepEqual(mappingReport.mappings, mappings);
  assert.equal(mappingReport.uniqueBusinessScenarioCount, 6);
  assert.equal(mappingReport.actualReportExecutionCount, 1);
  const cardCommandPath = directory + "/card-command.json";
  const cardCommand = json(cardCommandPath);
  assert.equal(cardCommand.command, mappingReport.actualCommand);
  const observedCard = quality.observations.filter(
    (record) => record.command === mappingReport.actualCommand,
  );
  assert.equal(observedCard.length, 1);
  assert.deepEqual(cardCommand, observedCard[0]);
  const business = phase013BusinessObservations(cardCommand);
  const businessPath = directory + "/business-observations.json";
  const businessReport = json(businessPath);
  assert.deepEqual(businessReport, {
    planHash: hash(planPath),
    command: cardCommand.command,
    sourceCommandPath: cardCommandPath,
    sourceCommandHash: hash(cardCommandPath),
    sourceReportPath: cardPath,
    sourceReportHash: hash(cardPath),
    rows: business,
  });
  assert.equal(quality.businessObservationPath, businessPath);
  assert.equal(quality.businessObservationHash, hash(businessPath));
  assert.deepEqual(quality.businessObservations, business);
  const fixtures = phase013FixtureBinding(plan, hash);
  for (const [field, value] of Object.entries(fixtures)) assert.deepEqual(quality[field], value);
  for (const report of reports) {
    assert.equal(report.details.sourceReportPath, cardPath);
    assert.equal(report.details.sourceReportHash, hash(cardPath));
    assert.equal(report.details.mappingPath, mappingPath);
    assert.equal(report.details.mappingHash, hash(mappingPath));
    assert.deepEqual(report.details.assertionMapping, mappings[report.testCaseId]);
    assert.equal(report.details.businessObservationPath, businessPath);
    assert.equal(report.details.businessObservationHash, hash(businessPath));
    assert.deepEqual(
      report.details.businessObservations,
      business.filter((row) => row.group === report.testCaseId.slice("Phase013:".length)),
    );
    for (const [field, value] of Object.entries(fixtures))
      assert.deepEqual(report.details[field], value);
  }
  const fullPath = directory + "/all-tests-vitest.json";
  const fullAssertions = requirePhase013Vitest(json(fullPath), { base: root });
  const coverage = requirePhase013Discovery(
    json(directory + "/test-discovery.json"),
    fullAssertions,
    root,
  );
  assert.deepEqual(quality.discoveryCoverage, coverage);
  assert.equal(quality.testCount, fullAssertions.length);
  assert.deepEqual(
    quality.negativeControls.rows.map((row) => row.id),
    plan.negativeControls.map((row) => row.id),
  );
  for (const row of quality.negativeControls.rows) {
    const control = plan.negativeControls.find((entry) => entry.id === row.id);
    const definition = phase013NegativeControlDefinitions().find((entry) => entry.id === row.id);
    assert.equal(row.sourcePath, control.sourcePath);
    assert.equal(row.sourcePath, definition.file);
    assert.equal(row.originalHash, hash(row.sourcePath));
    assert.equal(row.restoredSourceHash, row.originalHash);
    assert.equal(row.baseline.exitCode, 0);
    assert.equal(row.baseline.timedOut, false);
    assert.equal(row.baseline.cwd, root);
    assert.equal(row.baselineReportPath, directory + "/baseline-" + row.id + "-vitest.json");
    assert.equal(row.negativeReportPath, directory + "/negative-" + row.id + "-vitest.json");
    for (const record of [row.baseline, row.negative])
      assert(
        quality.observations.some(
          (observed) => JSON.stringify(observed) === JSON.stringify(record),
        ),
      );
    const baselineRaw = json(row.baselineReportPath);
    const negativeRaw = json(row.negativeReportPath);
    const failureEvidence = requirePhase013NegativeControl(row.id, {
      baselineRaw,
      baselineRecord: row.baseline,
      negativeRaw,
      negativeRecord: row.negative,
      readBytes: read,
      expectedContract: row.failureEvidence?.contract,
    });
    assert.deepEqual(row.failureEvidence, failureEvidence);
    for (const [file, expected] of Object.entries(failureEvidence.contract.testSourceHashes)) {
      assert(plan.sourcePaths.includes(file));
      assert.equal(quality.sourceHashes[file], expected);
    }
    const mutationReceipt = json(directory + "/mutations/" + row.id + ".json");
    assert.deepEqual(mutationReceipt.failureContract, failureEvidence.contract);
    assert.deepEqual(mutationReceipt.changedSources, row.changedSources);
    assert.deepEqual(mutationReceipt.testFiles, definition.files);
    assert.equal(mutationReceipt.testPattern, definition.pattern ?? null);
    assert.equal(mutationReceipt.originalCase, control.originalCase);
    const failed = negativeRaw.testResults.flatMap((suite) =>
      suite.assertionResults
        .filter((entry) => entry.status === "failed")
        .map(({ fullName }) => ({
          file: path.relative(row.negative.cwd, suite.name).replaceAll("\\", "/"),
          fullName,
        })),
    );
    assert.deepEqual(row.failedAssertions, failed);
    const mutations = [definition, ...(definition.additionalMutations ?? [])];
    assert.deepEqual(
      row.changedSources.map((entry) => entry.sourcePath),
      mutations.map((entry) => entry.file),
    );
    for (const [index, entry] of row.changedSources.entries()) {
      assert(plan.sourcePaths.includes(entry.sourcePath));
      assert.equal(entry.originalHash, hash(entry.sourcePath));
      const original = read(entry.sourcePath).toString();
      assert.equal(original.split(mutations[index].before).length - 1, 1);
      assert.equal(
        entry.mutatedHash,
        sha(original.replace(mutations[index].before, mutations[index].after)),
      );
      assert.notEqual(entry.originalHash, entry.mutatedHash);
    }
  }
  assert.equal(quality.negativeControls.sourceUnchanged, true);
  assert.equal(
    quality.negativeControls.restoredReportPath,
    directory + "/restored-card-vitest.json",
  );
  const restoredAssertions = requirePhase013Vitest(
    json(quality.negativeControls.restoredReportPath),
    { base: root },
  );
  assert.deepEqual(
    quality.negativeControls.restoredMappings,
    requirePhase013CaseMapping(plan, restoredAssertions),
  );
  const browser = json(directory + "/browser.json");
  const browserSummary = requirePhase013BrowserReport(browser);
  assert.equal(quality.browser.reportPath, directory + "/browser.json");
  assert.equal(quality.browser.reportHash, hash(quality.browser.reportPath));
  for (const [field, value] of Object.entries(browserSummary))
    assert.deepEqual(quality.browser[field], value);
  assert(
    quality.observations.some(
      (record) => JSON.stringify(record) === JSON.stringify(quality.browser.result),
    ),
  );
  assert.equal(quality.browser.result.exitCode, 0);
  for (const report of reports) {
    assert.equal(report.details.browserReportPath, quality.browser.reportPath);
    assert.equal(report.details.browserReportHash, quality.browser.reportHash);
  }
  for (const entry of browser.artifacts) assert.equal(hash(entry.path), entry.sha256);
  const target = reports.find((report) => report.testCaseId === "Phase013:create-read").details
    .target;
  assert.equal(target.host, "127.0.0.1");
  assert.match(target.database, /^phase013_disposable_[a-f0-9]{12}(?:_[a-z0-9_]+)?$/);
  assert.equal(target.image, imageDigest);
  assert.equal(target.networkMasquerading, false);
  assert.equal(target.credentials, "SYNTHETIC_REDACTED");
  assert(!Object.hasOwn(target, "password") && !Object.hasOwn(target, "url"));
  const review = requireReview ? json(reviewPath) : null;
  if (review) {
    assert.equal(review.phase, 13);
    assert.equal(review.attemptId, plan.attemptId);
    assert.equal(review.planPath, planPath);
    assert.equal(review.planHash, hash(planPath));
    assert.equal(review.decision, "PASS");
    requireReviewIdentity(review, plan.implementationContextId);
    requireHashCoverage(review.sourceHashes, plan.sourcePaths, hash, "REVIEW_SOURCE_HASH");
    requireHashCoverage(
      review.reportHashes,
      plan.cases.map((item) => item.outputPath),
      hash,
      "REVIEW_REPORT_HASH",
    );
    requireHashCoverage(
      review.supplementalReportHashes,
      [qualityPath],
      hash,
      "REVIEW_SUPPLEMENTAL_HASH",
    );
    assert(Array.isArray(review.issues) && Array.isArray(review.dispositions));
    for (const issue of review.issues)
      assert(
        issue.status === "RESOLVED" ||
          review.dispositions.some(
            (entry) => entry.issueId === issue.id && entry.status === "RESOLVED",
          ),
      );
  }
  return { reports, quality, review, receipt, target };
}

function retry() {
  assert(
    fs.existsSync(path.join(root, directory, "attempt.json")),
    "Retry requires a recorded failure",
  );
  const frozen = `${directory}/frozen-plan.json`;
  if (!fs.existsSync(path.join(root, frozen))) write(frozen, read(planPath));
  assert.equal(hash(frozen), hash(planPath));
  assert.match(plan.attemptId, /^attempt-\d+$/);
  const next = createPhase013RetryPlan(plan, { readJson: json, hashFile: hash, git });
  const failure = json(`${directory}/attempt.json`);
  if (failure.preparedReceiptPath) {
    assert.equal(failure.kind, "SOURCE_REPAIR");
    assert.equal(
      failure.preparedReceiptPath,
      `docs/evidence/attempts/Phase013/${next.attemptId}/migration-preparation.json`,
    );
    assert(failure.sourceAdditions?.includes(failure.preparedReceiptPath));
    next.migrationPolicy.preparedReceiptPath = failure.preparedReceiptPath;
  }
  for (const file of failure.sourceAdditions ?? []) {
    assert(typeof file === "string" && !file.includes("..") && !path.isAbsolute(file));
    if (!next.sourcePaths.includes(file)) next.sourcePaths.push(file);
  }
  next.sourcePaths.sort();
  for (const [id, file] of Object.entries(failure.negativeControlSourceCorrections ?? {})) {
    const control = next.negativeControls.find((entry) => entry.id === id);
    assert(control && next.sourcePaths.includes(file));
    control.sourcePath = file;
  }
  for (const file of failure.scopeAdditions ?? []) {
    assert(["PLAN_SCOPE", "SOURCE_REPAIR"].includes(failure.kind));
    assert(typeof file === "string" && !file.includes("..") && !path.isAbsolute(file));
    assert(
      plan.sourcePaths.includes(file),
      "Supporting scope addition must already be a frozen source",
    );
    if (!next.modificationScope.includes(file)) next.modificationScope.push(file);
  }
  const scopeRepairPath = `docs/evidence/attempts/Phase013/${next.attemptId}/scope-repair.json`;
  if (fs.existsSync(path.join(root, scopeRepairPath))) {
    const previous = next.previousAttempts.at(-1);
    const additions = requirePhase013ScopeRepair(json(scopeRepairPath), previous, {
      readJson: json,
      hashFile: hash,
    });
    previous.scopeRepairPath = scopeRepairPath;
    previous.scopeRepairHash = hash(scopeRepairPath);
    for (const file of additions) next.modificationScope.push(file);
    if (!next.sourcePaths.includes(scopeRepairPath)) next.sourcePaths.push(scopeRepairPath);
    next.sourcePaths.sort();
    requirePhase013FailureChain(next, { readJson: json, hashFile: hash, git });
  }
  write(`docs/evidence/attempts/Phase013/${next.attemptId}/frozen-plan.json`, next);
  write(planPath, next, false);
  console.warn(
    JSON.stringify({ status: "RETRY_FROZEN", attemptId: next.attemptId, cases: next.cases.length }),
  );
}

function metadata() {
  const { reports, quality, review, receipt, target } = audit();
  assert.equal(
    git(["status", "--porcelain=v1"]).trim(),
    "",
    "Artifact must be committed with a clean tree",
  );
  assert.equal(git(["show", "-s", "--format=%s", "HEAD"]).trim(), "phase(013): artifact");
  assert(!fs.existsSync(path.join(root, gatePath)), "Never overwrite a sealed Gate");
  const artifactCommit = git(["rev-parse", "HEAD"]).trim();
  const testedTree = git(["rev-parse", "HEAD^{tree}"]).trim();
  const state = json("docs/roadmap-run.json");
  assert.equal(state.completedThrough, 12);
  assert.equal(state.currentPhase, 13);
  assert.equal(state.checkpoints.at(-1).phase, 12);
  assert.equal(state.manifestHash, receipt.manifestHash);
  const allPaths = [
    ...new Set([
      ...plan.sourcePaths,
      ...plan.cases.flatMap((item) => [item.inputPath, item.outputPath]),
      ...inventory("docs/evidence/attempts/Phase013"),
      migrationPath,
      reviewPath,
      qualityPath,
    ]),
  ].sort();
  const inputs = allPaths.map((file) => {
    const sha256 = hash(file);
    assert.equal(
      sha(git(["show", `${artifactCommit}:${file}`], null)),
      sha256,
      `Uncommitted evidence bytes: ${file}`,
    );
    return { path: file, sha256 };
  });
  const results = plan.cases.map((item, index) => ({
    testCaseId: item.testCaseId,
    command: item.command,
    exitCode: reports[index].exitCode,
    numerator: reports[index].numerator,
    denominator: item.denominator,
    inputHash: `sha256:${hash(item.inputPath)}`,
    outputHash: `sha256:${hash(item.outputPath)}`,
    status: reports[index].status,
    details: { inputPath: item.inputPath, outputPath: item.outputPath, expected: item.expected },
  }));
  const intermediate = git([
    "rev-list",
    "--reverse",
    `${receipt.phaseStartCommit}..${artifactCommit}`,
  ])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  assert.equal(intermediate.at(-1), artifactCommit);
  const databaseIdentity = {
    host: target.host,
    port: target.port,
    database: target.database,
    containerId: target.containerId,
    image: target.image,
  };
  const gate = {
    schemaVersion: "agent-gate-v1",
    phase: 13,
    attemptId: plan.attemptId,
    status: "PASS",
    simulation: true,
    operatorMode: "AGENT_ONLY_AUTOMATED_NEW_BUILD",
    environment: {
      isolated: true,
      syntheticUsers: true,
      providerMode: "local-adapter",
      productionTraffic: false,
    },
    artifactCommit,
    requiredCaseIds: plan.requiredCaseIds,
    results,
    commands: results.map(({ command, exitCode }) => ({ command, exitCode })),
    inputs,
    failures: [],
    generatedAt: new Date().toISOString(),
    details: {
      planPath,
      planHash: hash(planPath),
      testedTree,
      reviewerRunId: review.reviewerRunId,
      reviewReportPath: reviewPath,
      reviewReportHash: hash(reviewPath),
      recoveryCommits: intermediate.slice(0, -1),
      originalThreshold: 6,
      automatedThreshold: 6,
      waived: false,
      requestedThrough: 13,
      nextPhaseExecutionAuthorized: false,
      notEvaluated: plan.notApplicable,
      qualityReportPath: qualityPath,
      qualityReportHash: hash(qualityPath),
      runtimeBaselinePath: "docs/runtime-baseline.json",
      runtimeBaselineHash: hash("docs/runtime-baseline.json"),
      manifestHash: receipt.manifestHash,
      projectCommit: artifactCommit,
      schemaPath: "prisma/schema.prisma",
      schemaHash: hash("prisma/schema.prisma"),
      authContractPath: "docs/auth.md",
      authContractHash: hash("docs/auth.md"),
      apiContractPath: "docs/api.md",
      apiContractHash: hash("docs/api.md"),
      migrationPath,
      migrationHash: hash(migrationPath),
      databaseRoles: {
        migration: "phase013_runner",
        runtime: "phase013_app",
        runtimeOwner: false,
        runtimeSuperuser: false,
      },
      databaseFingerprint: {
        ...databaseIdentity,
        sha256: sha(JSON.stringify(databaseIdentity)),
        credentials: "SYNTHETIC_REDACTED",
      },
      testMode: plan.testMode,
      validationPolicy: receipt.validationPolicy,
      checkpointMaintenance: receipt.checkpointMaintenance,
      fixtureHash: quality.fixtureHash,
      fixtureHashScope: quality.fixtureHashScope,
      fixtureHashes: quality.fixtureHashes,
      businessObservationPath: quality.businessObservationPath,
      businessObservationHash: quality.businessObservationHash,
      stateTransitionAuditCounts: quality.businessObservations.filter((row) =>
        Object.hasOwn(row, "matchingStateAudits"),
      ),
      businessObservations: quality.businessObservations,
      secretScan: {
        browserReportPath: quality.browser.reportPath,
        browserReportHash: quality.browser.reportHash,
        categories: quality.browser.secretScans,
        scope: quality.scan,
        privacyFailures: quality.browser.privacyFailures,
        externalRequestCount: quality.browser.externalRequestCount,
        finalGate: { hits: 0, scannedBeforeArchive: true },
      },
      actualCommandExitCodes: quality.observations.map(({ command, exitCode, timedOut }) => ({
        command,
        exitCode,
        timedOut,
      })),
      costAccounting: quality.costAccounting,
    },
  };
  scanSensitiveText(JSON.stringify(gate), "final Gate before archival");
  write(gatePath, gate);
  const checkpoint = {
    phase: 13,
    artifactCommit,
    evidencePath: gatePath,
    evidenceHash: hash(gatePath),
  };
  state.completedThrough = 13;
  state.currentPhase = 14;
  state.nextPhaseExecutionAuthorized = false;
  state.lastArtifactCommit = artifactCommit;
  state.currentLayoutPhaseSeal = checkpoint;
  state.checkpoints.push(checkpoint);
  write("docs/roadmap-run.json", state, false);
  const log = read("docs/phase-completion-log.md").toString().trimEnd();
  assert(!log.includes("| Phase013 |"));
  const row =
    "| Phase013 | 管理员密钥生命周期与脱敏审计读取 | AES-GCM/AAD与安全DTO、录入/停用/启用/轮换/紧急撤销、幂等原子审计、两引用adapter合同、日志keyset分页、真实UI与隔离测试；完整文件/hash见Gate | 固定6/6；PostgreSQL17；真实受控HTTP候选测试；反向红与恢复绿；Vitest " +
    quality.testCount +
    "/" +
    quality.testCount +
    "；testMode=full；lint/typecheck/format/build/layout/validator通过；独立Agent复核；artifactCommit=" +
    artifactCommit +
    "；attemptId=" +
    plan.attemptId +
    " | 无生产流量、真实密钥或Provider外呼；真人读屏NOT_EVALUATED；未执行Phase014 | metadata后执行双shell seal、clean和GitHub同步；授权止于013 |";
  write(
    "docs/phase-completion-log.md",
    `${log}\n${row}\n\nPhase013 计划：${planPath}；唯一 Gate：${gatePath}；恢复、原始命令、数据库、测试与独立复核：docs/evidence/attempts/Phase013/。旧检查点保持原字节。\n`,
    false,
  );
  console.warn(
    JSON.stringify({
      status: "METADATA_CANDIDATE_CREATED",
      artifactCommit,
      evidenceHash: checkpoint.evidenceHash,
      nextPhaseExecutionAuthorized: false,
    }),
  );
}

try {
  if (process.argv.includes("--retry")) retry();
  else if (process.argv.includes("--metadata")) metadata();
  else {
    const result = audit(!process.argv.includes("--without-review"));
    console.warn(
      JSON.stringify({
        status: "PASS",
        reports: result.reports.length,
        independentReview: Boolean(result.review),
      }),
    );
  }
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
}
