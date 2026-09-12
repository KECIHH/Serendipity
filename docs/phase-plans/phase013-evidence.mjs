import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const prefix = "PHASE013_EVIDENCE";
const sha256 = /^[0-9a-f]{64}$/;
const objectId = /^[0-9a-f]{40,64}$/;

export function requirePhase013Preflight(preflight) {
  assert.equal(preflight.phase, 13, prefix + ": wrong phase");
  assert.equal(preflight.workingTree, "", prefix + ": dirty admission");
  assert.equal(preflight.branch, "main");
  assert.equal(preflight.remote, "https://github.com/KECIHH/Serendipity.git");
  assert.equal(preflight.head, "408f6ae5516069efcaa423cc61ea431e528bd040");
  assert.equal(preflight.originMain, preflight.head);
  assert.equal(preflight.remoteHead, preflight.head);
  assert.equal(preflight.ahead, 0);
  assert.equal(preflight.behind, 0);
  assert.equal(preflight.completedThrough, 12);
  assert.equal(preflight.currentPhase, 13);
  assert.equal(preflight.remoteVerification.command, "git ls-remote --heads origin main");
  assert.equal(preflight.remoteVerification.exitCode, 0);
  assert.equal(preflight.remoteVerification.head, preflight.head);
  assert(Array.isArray(preflight.shells));
  const commands = {
    "PowerShell 7":
      "pwsh -NoProfile -File scripts/validate-phase.ps1 -CompletedThrough 12 -Strict -Json",
    "Windows PowerShell 5.1":
      "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/validate-phase.ps1 -CompletedThrough 12 -Strict -Json",
  };
  assert.deepEqual(
    preflight.shells.map((shell) => shell.shell).sort(),
    Object.keys(commands).sort(),
    prefix + ": both distinct shells are required",
  );
  for (const shell of preflight.shells) {
    assert.equal(shell.command, commands[shell.shell]);
    assert.equal(shell.exitCode, 0);
    assert.equal(shell.result.status, "PASS");
    assert.equal(shell.result.scope, "ROOT_LAYOUT_PHASE_CHECKPOINT_ADMISSION");
    assert.equal(shell.result.protocolFixture, false);
    assert.equal(shell.result.layoutVersion, 2);
    assert.equal(shell.result.projectGitPrefix, "");
    assert.equal(shell.result.completedThrough, 12);
    assert.equal(shell.result.currentPhase, 13);
    assert.equal(shell.result.metadataCommit, "3fa20a8dca445859d94db8dfa1232d16f8a6e07f");
    assert.equal(shell.result.maintenanceHead, preflight.head);
    assert.equal(shell.result.admissionOnly, true);
    assert.equal(shell.result.artifactCommit, "171025ef44f194b6417e9bf091c0d635d9741e2b");
  }
}

export function requirePhase013Inputs(receipt, { hashFile, readJson, readBytes, git }) {
  assert.equal(receipt.phase, 13);
  assert.equal(receipt.requestedThrough, 13);
  assert.equal(receipt.phaseStartCommit, "408f6ae5516069efcaa423cc61ea431e528bd040");
  assert.equal(receipt.prerequisites.metadataCommit, "3fa20a8dca445859d94db8dfa1232d16f8a6e07f");
  const maintenancePath = "docs/checkpoint-migrations/testing-policy-20260912.json";
  const maintenance = readJson(maintenancePath);
  assert.deepEqual(
    receipt.checkpointMaintenance,
    { path: maintenancePath, sha256: hashFile(maintenancePath), commit: receipt.phaseStartCommit },
    prefix + ": maintenance binding",
  );
  assert.deepEqual(receipt.validationPolicy, maintenance.policy, prefix + ": policy binding");
  assert.equal(receipt.validationPolicy.path, "docs/testing-execution-policy.md");
  assert.equal(receipt.validationPolicy.version, "phase-verification-v1");
  assert.equal(hashFile(receipt.validationPolicy.path), receipt.validationPolicy.sha256);
  assert(!readBytes(receipt.validationPolicy.path).includes(13), prefix + ": policy LF bytes");
  assert.equal(
    git(["rev-parse", receipt.phaseStartCommit + "^"]).trim(),
    receipt.prerequisites.metadataCommit,
  );
  assert.equal(
    git(["rev-parse", receipt.prerequisites.metadataCommit + "^"]).trim(),
    receipt.prerequisites.artifactCommit,
  );
  const blobHash = (file) =>
    createHash("sha256")
      .update(git(["show", receipt.phaseStartCommit + ":" + file], null))
      .digest("hex");
  assert.equal(blobHash(maintenancePath), receipt.checkpointMaintenance.sha256);
  assert.equal(blobHash(receipt.validationPolicy.path), receipt.validationPolicy.sha256);
  requirePhase013Preflight(receipt.preflight);
  for (const shell of receipt.preflight.shells)
    assert.deepEqual(shell.result.checkpointMaintenance, {
      ...receipt.checkpointMaintenance,
      policy: receipt.validationPolicy,
    });
  assert.equal(hashFile(receipt.preflight.reportPath), receipt.preflight.reportHash);
  for (const [field, value] of Object.entries(readJson(receipt.preflight.reportPath)))
    assert.deepEqual(receipt.preflight[field], value);
  for (const input of receipt.pinnedInputs) assert.equal(hashFile(input.path), input.sha256);
}

export function requirePhase013Generation(
  generation,
  { receipt, hashFile, readText, migrationPath },
) {
  assert.match(
    migrationPath,
    /^prisma\/migrations\/[0-9]{14}_key_rotation_contract\/migration\.sql$/,
  );
  assert.equal(generation.generatedMigrationPath, migrationPath);
  assert.equal(generation.mode, "EXISTING_TABLE_SQL_CONTRACT_REPAIR");
  assert.equal(generation.protectionPath, "docs/phase-plans/key-rotation-protection.sql");
  for (const field of ["migrationHash", "schemaHash", "previousSchemaHash", "protectionHash"])
    assert.match(generation[field], sha256);
  assert.equal(hashFile(generation.protectionPath), generation.protectionHash);
  assert.equal(hashFile(migrationPath), generation.migrationHash);
  assert.equal(generation.schemaPath, "prisma/schema.prisma");
  assert.equal(hashFile(generation.schemaPath), generation.schemaHash);
  assert.equal(generation.previousSchemaHash, receipt.prerequisites.schemaHash);
  assert.deepEqual(generation.previousMigrations, receipt.prerequisites.migrations);
  assert.equal(generation.previousMigrations.length, 7);
  for (const previous of generation.previousMigrations)
    assert.equal(hashFile(previous.path), previous.sha256);
  assert.equal(generation.simulation, true);
  assert.equal(generation.productionTraffic, false);
  assert(Array.isArray(generation.records) && generation.records.length > 0);
  assert(generation.records.every((record) => record.exitCode === 0 && record.timedOut !== true));
  assert(
    generation.records.some((record) => record.command === "npm exec -- prisma migrate deploy"),
  );
  assert(
    generation.records.some(
      (record) =>
        record.command === "npm exec -- prisma migrate status" &&
        /Database schema is up to date/.test(record.stdout),
    ),
  );
  assert.equal(generation.newTables, 0);
  const protection = readText(generation.protectionPath);
  assert(
    protection.trim().length > 0 && !protection.includes("\r"),
    prefix + ": custom SQL must use LF",
  );
  assert.equal(
    readText(migrationPath),
    protection.trimEnd() + "\n",
    prefix + ": custom migration and reviewed protection must be exact",
  );
  assert(
    !/\bCREATE\s+TABLE\b|\bDROP\s+TABLE\b|^\s*TRUNCATE\s/im.test(protection),
    prefix + ": this repair cannot create or drop product tables",
  );
  const allowed = ["AdminCommandReceipt", "KeyRotationRun", "ApiKeyConfig"];
  const touched = [...protection.matchAll(/ALTER\s+TABLE\s+(?:public\.)?"([^"]+)"/gi)].map(
    (match) => match[1],
  );
  assert(touched.length > 0 && touched.every((table) => allowed.includes(table)));
  if (generation.amendment) {
    const amendment = generation.amendment;
    for (const [file, expected] of [
      [amendment.originalReceiptPath, amendment.originalReceiptHash],
      [amendment.failedMigrationPath, amendment.failedMigrationHash],
      [amendment.failedProtectionPath, amendment.failedProtectionHash],
      [amendment.failedAttemptPath, amendment.failedAttemptHash],
    ])
      assert.equal(hashFile(file), expected);
    const original = JSON.parse(readText(amendment.originalReceiptPath));
    assert.equal(original.generatedMigrationPath, migrationPath);
    assert.equal(original.migrationHash, amendment.failedMigrationHash);
    assert.equal(original.protectionHash, amendment.failedProtectionHash);
    assert.equal(
      readText(amendment.failedMigrationPath),
      readText(amendment.failedProtectionPath).trimEnd() + "\n",
    );
    assert.deepEqual(generation.correction, {
      emptyCandidateAccepted: true,
      malformedCandidateRejected: true,
      exactCandidateAccepted: true,
      duplicateReferenceRejected: true,
    });
    assert(typeof amendment.reason === "string" && amendment.reason.length > 0);
  }
}

export function requirePhase013ScopeRepair(repair, previous, { readJson, hashFile }) {
  assert.equal(repair.phase, 13);
  assert.equal(repair.kind, "EXACT_RECORDED_TEST_SCOPE_ADDITION");
  assert.equal(repair.fromAttemptId, previous.attemptId);
  const nextAttemptId = `attempt-${Number(previous.attemptId.slice("attempt-".length)) + 1}`;
  assert.equal(repair.toAttemptId, nextAttemptId);
  for (const field of ["planPath", "planHash", "failurePath", "failureHash"])
    assert.equal(repair[field], previous[field]);
  assert.equal(hashFile(repair.planPath), repair.planHash);
  assert.equal(hashFile(repair.failurePath), repair.failureHash);
  const old = readJson(repair.planPath);
  const failure = readJson(repair.failurePath);
  assert.equal(failure.phase, 13);
  assert.equal(failure.status, "FAIL");
  assert.equal(failure.artifactCommit, null);
  assert.equal(failure.planHash, repair.planHash);
  assert.equal(failure.command, "node docs/phase-plans/verify-phase013.mjs --all");
  assert.equal(failure.exitCode, 1);
  assert.equal(
    repair.sourceReportPath,
    `docs/evidence/attempts/Phase013/${previous.attemptId}/all-tests-vitest.json`,
  );
  assert.equal(hashFile(repair.sourceReportPath), repair.sourceReportHash);
  assert(
    failure.artifacts.some(
      (entry) => entry.path === repair.sourceReportPath && entry.sha256 === repair.sourceReportHash,
    ),
  );
  const oldDirectory = `docs/evidence/attempts/Phase013/${previous.attemptId}/`;
  const protectedPaths = [
    previous.planPath,
    previous.failurePath,
    ...failure.artifacts
      .filter((entry) => entry.path.startsWith(oldDirectory))
      .map((entry) => entry.path),
  ];
  assert(repair.preservedEvidenceHashes && typeof repair.preservedEvidenceHashes === "object");
  for (const file of protectedPaths) assert(Object.hasOwn(repair.preservedEvidenceHashes, file));
  for (const [file, expected] of Object.entries(repair.preservedEvidenceHashes)) {
    assert(file.startsWith(oldDirectory) && !file.includes(".."));
    assert.match(expected, sha256);
    assert.equal(hashFile(file), expected, "Scope repair cannot change prior attempt evidence");
  }
  const record = failure.observations.find((entry) => entry.command === repair.failedCommand);
  assert(record && Number.isInteger(record.exitCode) && record.exitCode !== 0 && !record.timedOut);
  assert(
    record.arguments.some((entry) =>
      entry.replaceAll("\\", "/").endsWith(`/${previous.attemptId}-all-tests-vitest.json`),
    ),
  );
  const raw = readJson(repair.sourceReportPath);
  assert.equal(raw.success, false);
  assert.equal(raw.numRuntimeErrorTestSuites ?? 0, 0);
  assert.equal(raw.numPendingTests, 0);
  assert.equal(raw.numTodoTests ?? 0, 0);
  const assertions = phase013Assertions(raw, record.cwd);
  assert.equal(raw.numTotalTests, assertions.length);
  const failed = assertions
    .filter((entry) => entry.status === "failed")
    .map(({ file, fullName }) => ({ file, fullName }));
  assert(failed.length > 0);
  assert.equal(raw.numFailedTests, failed.length);
  assert.deepEqual(repair.failedAssertions, failed);
  const identities = new Map();
  for (const entry of assertions) {
    const identity = entry.file + "\0" + entry.fullName;
    const row = identities.get(identity) ?? {
      file: entry.file,
      fullName: entry.fullName,
      count: 0,
    };
    row.count++;
    identities.set(identity, row);
  }
  const duplicates = [...identities.values()].filter((entry) => entry.count > 1);
  assert.deepEqual(repair.duplicateAssertionIdentities, duplicates);
  assert.equal(repair.testMode, "full");
  assert.equal(repair.crossAttemptReuse, "disabled");
  assert(Array.isArray(repair.scopeAdditions) && repair.scopeAdditions.length > 0);
  assert.equal(new Set(repair.scopeAdditions).size, repair.scopeAdditions.length);
  for (const file of repair.scopeAdditions) {
    assert(typeof file === "string" && !file.includes("..") && !path.isAbsolute(file));
    assert(
      /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file),
      "Scope repair must name an exact existing test file",
    );
    assert(old.sourcePaths.includes(file));
    assert(
      !old.modificationScope.some((scope) =>
        scope.endsWith("/") ? file.startsWith(scope) : scope === file,
      ),
    );
    assert(
      [...failed, ...duplicates].some((entry) => entry.file === file),
      "Scope repair must be justified by an actual failed assertion or duplicate identity",
    );
  }
  assert.deepEqual(
    repair.originalTestSources.map((entry) => entry.sourcePath),
    repair.scopeAdditions,
  );
  for (const entry of repair.originalTestSources) {
    assert.equal(
      entry.path,
      `docs/evidence/attempts/Phase013/${nextAttemptId}/prior-test-sources/${entry.sourcePath}`,
    );
    assert.match(entry.sha256, sha256);
    assert.equal(
      hashFile(entry.path),
      entry.sha256,
      "Original test bytes must remain available for comparison",
    );
  }
  return repair.scopeAdditions;
}

/** Verify historical bytes without comparing repaired sources to old source snapshots. */
export function requirePhase013FailureEvidence(
  failure,
  { previous, frozenPlan, currentPlan, readJson, hashFile, git },
) {
  const message = prefix + ": HISTORICAL_EVIDENCE";
  const ownDirectory = `docs/evidence/attempts/Phase013/${previous.attemptId}/`;
  const setupReceipt = "docs/evidence/attempts/Phase013/setup/migration-generation.json";
  const record = (value, label) =>
    assert(
      value !== null && typeof value === "object" && !Array.isArray(value),
      `${message}: ${label} must be an object`,
    );
  const canonicalPath = (file) => {
    assert(typeof file === "string" && file.length > 0, message + ": missing path");
    assert(
      !/[\\:<>"|?*\u0000-\u001f\u007f]/.test(file) &&
        !path.posix.isAbsolute(file) &&
        path.posix.normalize(file) === file &&
        file === file.normalize("NFC") &&
        file.split("/").every((part) => part.length > 0 && !/[. ]$/.test(part) && part !== ".."),
      message + ": noncanonical or escaping path",
    );
    return file;
  };
  const generationPath =
    frozenPlan.migrationPolicy.preparedReceiptPath ??
    frozenPlan.migrationPolicy.generationReceiptPath;
  canonicalPath(generationPath);
  assert(
    generationPath === setupReceipt ||
      /^docs\/evidence\/attempts\/Phase013\/attempt-[1-9][0-9]*\/migration-preparation\.json$/.test(
        generationPath,
      ),
    message + ": unknown generation receipt",
  );
  const references = new Map(),
    spellings = new Map(),
    verified = new Set(),
    sources = new Map();
  const remember = (file, expected, allowed) => {
    canonicalPath(file);
    assert(allowed(file), message + ": reference escaped its recorded evidence scope");
    assert(typeof expected === "string" && sha256.test(expected), message + ": malformed SHA-256");
    const spelling = spellings.get(file.toLowerCase());
    assert(spelling === undefined || spelling === file, message + ": path alias collision");
    spellings.set(file.toLowerCase(), file);
    const prior = references.get(file);
    assert(
      prior === undefined || prior === expected,
      message + ": conflicting hashes for one path",
    );
    references.set(file, expected);
  };
  const own = (file) => file.startsWith(ownDirectory);
  const verify = (file) => {
    if (verified.has(file)) return;
    assert(references.has(file), message + ": missing recorded hash");
    let actual;
    try {
      actual = hashFile(file);
    } catch {
      assert.fail(message + ": missing or unreadable historical file " + file);
    }
    assert.equal(actual, references.get(file), message + ": historical bytes changed: " + file);
    verified.add(file);
  };
  const pair = (value, field, { required = false, allowed = own } = {}) => {
    const hasPath = Object.hasOwn(value, field + "Path"),
      hasHash = Object.hasOwn(value, field + "Hash");
    assert.equal(hasPath, hasHash, message + ": incomplete " + field + " path/hash pair");
    if (required) assert(hasPath, message + ": missing " + field + " path/hash pair");
    if (hasPath) remember(value[field + "Path"], value[field + "Hash"], allowed);
  };
  const artifacts = (items, label) => {
    assert(Array.isArray(items), message + ": " + label + " must be an array");
    const seen = new Set();
    for (const item of items) {
      record(item, label + " entry");
      canonicalPath(item.path);
      assert(!seen.has(item.path.toLowerCase()), message + ": duplicate artifact path");
      seen.add(item.path.toLowerCase());
      if (/^prisma\/migrations\/[0-9]{14}_key_rotation_contract\/migration\.sql$/.test(item.path)) {
        assert(
          typeof item.sha256 === "string" && sha256.test(item.sha256),
          message + ": malformed source hash",
        );
        const prior = sources.get(item.path);
        assert(
          prior === undefined || prior === item.sha256,
          message + ": conflicting source artifact hashes",
        );
        sources.set(item.path, item.sha256);
      } else remember(item.path, item.sha256, (file) => own(file) || file === generationPath);
    }
  };
  assert(
    failure.artifactCommit === null ||
      (typeof failure.artifactCommit === "string" && objectId.test(failure.artifactCommit)),
    message + ": malformed artifact commit",
  );
  const postArtifact = failure.artifactCommit !== null;
  const runnerFailure =
    failure.kind === undefined &&
    failure.command === "node docs/phase-plans/verify-phase013.mjs --all";
  const migrationFailure = !postArtifact && failure.kind === "SOURCE_REPAIR";
  const reviewFailure = failure.kind === "INDEPENDENT_REVIEW_FINDINGS";
  const guardFailure = failure.kind === "EVIDENCE_GUARD_REPAIR";
  assert(
    postArtifact || runnerFailure || migrationFailure || reviewFailure || guardFailure,
    message + ": unknown failure receipt shape",
  );
  if (runnerFailure) {
    assert(Array.isArray(failure.observations), message + ": runner observations must be an array");
    assert(Array.isArray(failure.artifacts), message + ": runner artifacts must be an array");
  }
  const completed = Object.hasOwn(failure, "completedVerification");
  assert.equal(
    completed,
    Object.hasOwn(failure, "originalEvidenceHashes"),
    message + ": incomplete completed-verification evidence",
  );
  if (reviewFailure || guardFailure)
    assert(completed, message + ": completed verification and original evidence are required");
  for (const field of [
    "diagnostic",
    "commandReceipt",
    "review",
    "reviewerRun",
    "failedMigration",
    "failedProtection",
    "originalReceipt",
  ]) {
    pair(failure, field, {
      required:
        (postArtifact && field === "diagnostic") ||
        (migrationFailure &&
          ["diagnostic", "failedMigration", "failedProtection", "originalReceipt"].includes(
            field,
          )) ||
        (reviewFailure && ["review", "reviewerRun"].includes(field)) ||
        (guardFailure && ["diagnostic", "commandReceipt"].includes(field)),
      allowed: field === "originalReceipt" ? (file) => file === setupReceipt || own(file) : own,
    });
  }
  if (Object.hasOwn(failure, "artifacts")) artifacts(failure.artifacts, "artifacts");
  if (guardFailure)
    assert(
      Array.isArray(failure.archivedFiles) && failure.archivedFiles.length > 0,
      message + ": archived failure files are required",
    );
  if (Object.hasOwn(failure, "archivedFiles")) {
    assert(Array.isArray(failure.archivedFiles), message + ": archivedFiles must be an array");
    const seen = new Set();
    for (const entry of failure.archivedFiles) {
      record(entry, "archivedFiles entry");
      canonicalPath(entry.sourcePath);
      assert(
        frozenPlan.sourcePaths.includes(entry.sourcePath) ||
          entry.sourcePath.startsWith(".scaffold/phase013/") ||
          /^prisma\/migrations\/[0-9]{14}_key_rotation_contract\/migration\.sql$/.test(
            entry.sourcePath,
          ),
        message + ": unknown archived source identity",
      );
      canonicalPath(entry.path);
      assert(!seen.has(entry.path.toLowerCase()), message + ": duplicate archive path");
      seen.add(entry.path.toLowerCase());
      remember(entry.path, entry.sha256, own);
    }
    if (guardFailure)
      for (const field of ["diagnostic", "commandReceipt"])
        assert(
          failure.archivedFiles.some(
            (entry) =>
              entry.path === failure[field + "Path"] && entry.sha256 === failure[field + "Hash"],
          ),
          message + ": missing required failure archive",
        );
  }
  let quality;
  if (completed) {
    record(failure.completedVerification, "completedVerification");
    record(failure.originalEvidenceHashes, "originalEvidenceHashes");
    assert(
      Object.keys(failure.originalEvidenceHashes).length > 0,
      message + ": originalEvidenceHashes cannot be empty",
    );
    pair(failure.completedVerification, "quality", { required: true });
    assert.equal(
      failure.completedVerification.qualityPath,
      ownDirectory + "quality.json",
      message + ": wrong historical quality path",
    );
    for (const [file, expected] of Object.entries(failure.originalEvidenceHashes))
      remember(file, expected, own);
    verify(failure.completedVerification.qualityPath);
    quality = readJson(failure.completedVerification.qualityPath);
    record(quality, "historical quality");
    assert.equal(quality.phase, 13, message + ": historical quality phase");
    assert.equal(quality.attemptId, previous.attemptId, message + ": historical quality attempt");
    assert.equal(quality.planHash, previous.planHash, message + ": historical quality plan");
    artifacts(quality.artifacts, "historical quality artifacts");
    const requiredOriginal = new Set([
      previous.planPath,
      failure.completedVerification.qualityPath,
      ...frozenPlan.cases.map((item) => item.outputPath),
      ...quality.artifacts.filter((entry) => own(entry.path)).map((entry) => entry.path),
      ...[failure.reviewPath, failure.reviewerRunPath].filter((file) => file !== undefined),
    ]);
    for (const file of requiredOriginal)
      assert(
        Object.hasOwn(failure.originalEvidenceHashes, file),
        message + ": omitted original evidence reference " + file,
      );
    for (const entry of failure.archivedFiles ?? [])
      if (Object.hasOwn(quality.sourceHashes ?? {}, entry.sourcePath))
        assert.equal(
          entry.sha256,
          quality.sourceHashes[entry.sourcePath],
          message + ": archive differs from the historical source snapshot",
        );
  }
  for (const file of references.keys()) verify(file);
  for (const [sourcePath, expected] of sources) {
    assert(
      references.has(generationPath),
      message + ": source artifact lacks its generation receipt",
    );
    verify(generationPath);
    const generation = readJson(generationPath);
    record(generation, "historical generation receipt");
    assert.equal(
      generation.generatedMigrationPath,
      sourcePath,
      message + ": unregistered migration artifact",
    );
    assert.equal(
      generation.migrationHash,
      expected,
      message + ": migration artifact differs from its recorded generation",
    );
    // These existing receipt mappings identify old bytes. Never hash sourcePath
    // for an archived former implementation or silently substitute HEAD.
    const archive = (failure.archivedFiles ?? []).find(
      (entry) => entry.sourcePath === sourcePath && entry.sha256 === expected,
    );
    if (archive || (failure.failedMigrationPath && failure.failedMigrationHash === expected))
      continue;
    if (postArtifact) {
      assert.match(failure.artifactCommit, objectId);
      assert.equal(
        typeof git,
        "function",
        message + ": historical source requires its artifact blob",
      );
      assert.equal(
        createHash("sha256")
          .update(git(["show", `${failure.artifactCommit}:${sourcePath}`], null))
          .digest("hex"),
        expected,
        message + ": historical migration blob changed",
      );
      continue;
    }
    const preparedPath = currentPlan.migrationPolicy.preparedReceiptPath;
    let preservedByAmendment = false;
    if (preparedPath && preparedPath !== generationPath) {
      canonicalPath(preparedPath);
      assert(
        currentPlan.sourcePaths.includes(preparedPath) &&
          /^docs\/evidence\/attempts\/Phase013\/attempt-[1-9][0-9]*\/migration-preparation\.json$/.test(
            preparedPath,
          ),
        message + ": unknown preparation receipt",
      );
      const amendment = readJson(preparedPath).amendment;
      if (
        amendment?.originalReceiptPath === generationPath &&
        amendment.failedMigrationHash === expected
      ) {
        assert.equal(
          amendment.originalReceiptHash,
          references.get(generationPath),
          message + ": amendment original receipt changed",
        );
        const prior = currentPlan.previousAttempts.find(
          (entry) => entry.failurePath === amendment.failedAttemptPath,
        );
        assert(
          prior && prior.failureHash === amendment.failedAttemptHash,
          message + ": amendment lacks a bound failure",
        );
        remember(
          amendment.failedAttemptPath,
          amendment.failedAttemptHash,
          (file) => file === prior.failurePath,
        );
        remember(amendment.failedMigrationPath, expected, (file) =>
          file.startsWith(`docs/evidence/attempts/Phase013/${prior.attemptId}/`),
        );
        verify(amendment.failedAttemptPath);
        verify(amendment.failedMigrationPath);
        const failedAttempt = readJson(amendment.failedAttemptPath);
        assert.equal(
          failedAttempt.failedMigrationPath,
          amendment.failedMigrationPath,
          message + ": amendment archive is not the recorded failed migration",
        );
        assert.equal(
          failedAttempt.failedMigrationHash,
          expected,
          message + ": amendment differs from the recorded failed migration",
        );
        assert.equal(
          failedAttempt.originalReceiptPath,
          generationPath,
          message + ": amendment is not the recorded generation repair",
        );
        assert.equal(
          failedAttempt.originalReceiptHash,
          references.get(generationPath),
          message + ": amendment differs from the recorded generation repair",
        );
        preservedByAmendment = true;
      }
    }
    if (!preservedByAmendment) {
      let current;
      try {
        current = hashFile(sourcePath);
      } catch {
        assert.fail(message + ": missing historical migration source");
      }
      assert.equal(
        current,
        expected,
        message + ": changed migration lacks an existing archive/amendment/blob binding",
      );
    }
  }
  return {
    archivedReferenceHashes: Object.fromEntries(references),
    sourceArtifactHashes: Object.fromEntries(sources),
  };
}

export function requirePhase013FailureChain(plan, { readJson, hashFile, git }) {
  assert.equal(plan.phase, 13);
  assert(Array.isArray(plan.previousAttempts));
  assert.match(plan.attemptId, /^attempt-[1-9][0-9]*$/);
  const ordinal = Number(plan.attemptId.slice("attempt-".length));
  assert(Number.isSafeInteger(ordinal) && ordinal <= 10000);
  const expectedIds = Array.from({ length: ordinal - 1 }, (_, index) => `attempt-${index + 1}`);
  assert.deepEqual(
    plan.previousAttempts.map((entry) => entry.attemptId),
    expectedIds,
    `${prefix}: complete ordered failure history is required`,
  );
  const currentBindings = new Map(plan.previousAttempts.map((entry) => [entry.attemptId, entry]));
  for (const previous of plan.previousAttempts) {
    assert.equal(
      previous.planPath,
      `docs/evidence/attempts/Phase013/${previous.attemptId}/frozen-plan.json`,
    );
    assert.equal(
      previous.failurePath,
      `docs/evidence/attempts/Phase013/${previous.attemptId}/attempt.json`,
    );
    assert.match(previous.planHash, sha256);
    assert.match(previous.failureHash, sha256);
    assert.equal(hashFile(previous.planPath), previous.planHash);
    assert.equal(hashFile(previous.failurePath), previous.failureHash);
    const old = readJson(previous.planPath);
    assert.equal(old.phase, 13);
    assert.equal(old.attemptId, previous.attemptId);
    const oldOrdinal = Number(old.attemptId.slice("attempt-".length));
    assert(Array.isArray(old.previousAttempts));
    assert.deepEqual(
      old.previousAttempts.map((entry) => entry.attemptId),
      expectedIds.slice(0, oldOrdinal - 1),
      `${prefix}: frozen history is incomplete`,
    );
    for (const inherited of old.previousAttempts) {
      assert.deepEqual(
        inherited,
        currentBindings.get(inherited.attemptId),
        `${prefix}: frozen prior binding changed`,
      );
    }
    const failure = readJson(previous.failurePath);
    assert.equal(failure.phase, 13);
    assert.equal(failure.attemptId, previous.attemptId);
    assert(
      ["FAIL", "BLOCKED"].includes(failure.status),
      `${prefix}: prior attempt must be a failure`,
    );
    assert.equal(failure.planHash, previous.planHash);
    requirePhase013FailureEvidence(failure, {
      previous,
      frozenPlan: old,
      currentPlan: plan,
      readJson,
      hashFile,
      git,
    });
    if (previous.scopeRepairPath !== undefined || previous.scopeRepairHash !== undefined) {
      const nextAttemptId = `attempt-${oldOrdinal + 1}`;
      assert.equal(
        previous.scopeRepairPath,
        `docs/evidence/attempts/Phase013/${nextAttemptId}/scope-repair.json`,
      );
      assert.match(previous.scopeRepairHash, sha256);
      assert.equal(hashFile(previous.scopeRepairPath), previous.scopeRepairHash);
      assert(plan.sourcePaths.includes(previous.scopeRepairPath));
      const additions = requirePhase013ScopeRepair(readJson(previous.scopeRepairPath), previous, {
        readJson,
        hashFile,
      });
      for (const file of additions) assert(plan.modificationScope.includes(file));
    }
    if (failure.artifactCommit === null) {
      assert.notEqual(
        failure.stage,
        "METADATA_GENERATION",
        `${prefix}: metadata failure must identify its artifact`,
      );
      continue;
    }
    // Metadata generation can fail after a valid artifact commit. Preserve and
    // authenticate that unsealed commit instead of pretending it never existed.
    assert.equal(failure.kind, "SOURCE_REPAIR");
    assert.equal(failure.stage, "METADATA_GENERATION");
    assert.match(failure.artifactCommit, objectId);
    assert.equal(failure.metadataCommit, null);
    assert.equal(failure.gateCreated, false);
    assert.equal(failure.command, "node docs/phase-plans/complete-phase013.mjs --metadata");
    assert.equal(failure.exitCode, 1);
    assert.equal(
      typeof git,
      "function",
      `${prefix}: post-artifact recovery requires actual Git objects`,
    );
    assert.equal(
      failure.diagnosticPath,
      `docs/evidence/attempts/Phase013/${previous.attemptId}/metadata-diagnostic.json`,
    );
    assert.equal(hashFile(failure.diagnosticPath), failure.diagnosticHash);
    const diagnostic = readJson(failure.diagnosticPath);
    for (const field of [
      "phase",
      "attemptId",
      "status",
      "stage",
      "artifactCommit",
      "planHash",
      "gateCreated",
      "command",
      "exitCode",
    ])
      assert.deepEqual(diagnostic[field], failure[field]);
    assert.equal(diagnostic.workingTreeBefore, "");
    assert.equal(diagnostic.workingTreeAfter, "");
    assert.equal(diagnostic.observation.command, failure.command);
    assert.equal(diagnostic.observation.exitCode, 1);
    assert.equal(diagnostic.observation.timedOut, false);
    const commit = failure.artifactCommit;
    assert.equal(git(["show", "-s", "--format=%s", commit]).trim(), "phase(013): artifact");
    assert.equal(git(["rev-parse", `${commit}^{tree}`]).trim(), diagnostic.artifactTree);
    assert.match(diagnostic.phaseStartCommit, objectId);
    assert.notEqual(commit, diagnostic.phaseStartCommit);
    git(["merge-base", "--is-ancestor", diagnostic.phaseStartCommit, commit]);
    git(["merge-base", "--is-ancestor", commit, "HEAD"]);
    assert.equal(
      git(["ls-tree", "--name-only", commit, "--", "docs/evidence/Phase013-gate.json"]).trim(),
      "",
    );
    const blobHash = (file) =>
      createHash("sha256")
        .update(git(["show", `${commit}:${file}`], null))
        .digest("hex");
    assert.equal(blobHash("docs/phase-plans/Phase013.json"), previous.planHash);
    const inputReceipt = JSON.parse(
      git(["show", `${commit}:docs/phase-plans/Phase013-inputs.json`]),
    );
    assert.equal(inputReceipt.phaseStartCommit, diagnostic.phaseStartCommit);
    for (const name of ["quality", "review"]) {
      const file = `docs/evidence/attempts/Phase013/${previous.attemptId}/${name}.json`;
      assert.equal(diagnostic[`${name}ReportPath`], file);
      assert.equal(hashFile(file), diagnostic[`${name}ReportHash`]);
      assert.equal(blobHash(file), diagnostic[`${name}ReportHash`]);
    }
    const originalAttemptFiles = git([
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      commit,
      "--",
      `docs/evidence/attempts/Phase013/${previous.attemptId}/`,
    ])
      .split("\0")
      .filter(Boolean);
    assert(originalAttemptFiles.includes(previous.planPath));
    for (const item of old.cases) assert(originalAttemptFiles.includes(item.outputPath));
    for (const file of originalAttemptFiles)
      assert.equal(
        hashFile(file),
        blobHash(file),
        `${prefix}: committed attempt evidence changed: ${file}`,
      );
    assert(Array.isArray(diagnostic.archivedSources) && diagnostic.archivedSources.length > 0);
    assert.equal(
      new Set(diagnostic.archivedSources.map((entry) => entry.sourcePath)).size,
      diagnostic.archivedSources.length,
    );
    for (const entry of diagnostic.archivedSources) {
      assert(old.sourcePaths.includes(entry.sourcePath));
      assert.equal(
        entry.path,
        `docs/evidence/attempts/Phase013/${previous.attemptId}/artifact-${path.posix.basename(entry.sourcePath)}`,
      );
      assert.equal(hashFile(entry.path), entry.sha256);
      assert.equal(blobHash(entry.sourcePath), entry.sha256);
    }
  }
}

export function createPhase013RetryPlan(plan, { readJson, hashFile, git }) {
  requirePhase013FailureChain(plan, { readJson, hashFile, git });
  const planPath = `docs/evidence/attempts/Phase013/${plan.attemptId}/frozen-plan.json`;
  const failurePath = `docs/evidence/attempts/Phase013/${plan.attemptId}/attempt.json`;
  assert.deepEqual(readJson(planPath), plan, `${prefix}: current frozen plan changed`);
  const next = structuredClone(plan);
  next.attemptId = `attempt-${Number(plan.attemptId.slice("attempt-".length)) + 1}`;
  next.previousAttempts.push({
    attemptId: plan.attemptId,
    planPath,
    planHash: hashFile(planPath),
    failurePath,
    failureHash: hashFile(failurePath),
  });
  for (const item of next.cases)
    item.outputPath = item.outputPath.replace(`/${plan.attemptId}/`, `/${next.attemptId}/`);
  requirePhase013FailureChain(next, { readJson, hashFile, git });
  return next;
}

export function requirePhase013ImplementationBinding(expectedSnapshot, actualSnapshot) {
  assert(
    expectedSnapshot && typeof expectedSnapshot === "object" && !Array.isArray(expectedSnapshot),
  );
  assert(actualSnapshot && typeof actualSnapshot === "object" && !Array.isArray(actualSnapshot));
  assert.deepEqual(
    actualSnapshot,
    expectedSnapshot,
    "IMPLEMENTATION_CHANGED: implementation files were added, removed or changed after verification",
  );
}

export function phase013Assertions(raw, base) {
  assert(raw && Array.isArray(raw.testResults), prefix + ": missing raw Vitest suites");
  return raw.testResults.flatMap((suite) => {
    assert(typeof suite.name === "string" && Array.isArray(suite.assertionResults));
    const file = path.relative(base, suite.name).replaceAll("\\", "/");
    assert(
      !file.startsWith("../") && !path.isAbsolute(file),
      prefix + ": report escaped its tested root",
    );
    return suite.assertionResults.map((test) => {
      assert(typeof test.fullName === "string" && test.fullName.length > 0);
      assert(Array.isArray(test.ancestorTitles) && typeof test.title === "string");
      return {
        file,
        fullName: test.fullName,
        discoveryName: [...test.ancestorTitles, test.title].join(" > "),
        status: test.status,
        failureMessages: test.failureMessages ?? [],
      };
    });
  });
}

export function requirePhase013Vitest(
  raw,
  { base, expectedFailure = false, allowFiltered = false },
) {
  const assertions = phase013Assertions(raw, base);
  assert(assertions.length > 0, prefix + ": zero matching assertions");
  for (const entry of assertions) {
    assert(["passed", "failed", "skipped", "pending", "todo"].includes(entry.status));
    assert(Array.isArray(entry.failureMessages));
    assert(entry.failureMessages.every((message) => typeof message === "string"));
    if (entry.status !== "failed") assert.equal(entry.failureMessages.length, 0);
  }
  assert.equal(raw.numTotalTests, assertions.length, prefix + ": inconsistent total count");
  for (const [field, statuses] of [
    ["numPassedTests", ["passed"]],
    ["numFailedTests", ["failed"]],
    ["numPendingTests", ["skipped", "pending"]],
    ["numTodoTests", ["todo"]],
  ])
    assert.equal(
      raw[field] ?? (field === "numTodoTests" ? 0 : undefined),
      assertions.filter((entry) => statuses.includes(entry.status)).length,
      prefix + ": inconsistent " + field,
    );
  assert.equal(
    raw.numRuntimeErrorTestSuites ?? 0,
    0,
    prefix + ": suite import errors are not assertion evidence",
  );
  assert.equal(
    new Set(assertions.map((entry) => entry.file + "\0" + entry.fullName)).size,
    assertions.length,
    prefix + ": duplicate assertion identity",
  );
  if (expectedFailure) {
    assert.equal(raw.success, false);
    assert(raw.numFailedTests > 0);
    const failures = assertions.filter((entry) => entry.status === "failed");
    assert(failures.length > 0);
    for (const failure of failures) {
      assert(failure.failureMessages.length > 0);
      for (const message of failure.failureMessages) {
        // A runner frame named runWithTimeout is normal. Inspect error text,
        // including explicit connection codes, instead of matching stack names.
        const errorText = message
          .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
          .split(/\r?\n/)
          .filter((line) => !/^\s*at\s/.test(line))
          .join("\n");
        assert(
          !/Cannot find module|Failed to resolve|SyntaxError|ReferenceError|PrismaClientInitializationError|\bP(?:1000|1001|1002|1003|1008|1010|1011|1013|1017|2024|2037)\b|\bE(?:CONNREFUSED|CONNRESET|TIMEDOUT|HOSTUNREACH|NETUNREACH|AI_AGAIN)\b|(?:Test|Hook|(?:before|after)(?:All|Each)\s+hook)\s+timed\s+out/i.test(
            errorText,
          ),
          prefix + ": mutation failed setup or infrastructure rather than an original assertion",
        );
      }
    }
  } else {
    assert.equal(raw.success, true);
    assert.equal(raw.numFailedTests, 0);
    assert.equal(
      raw.numPassedTests,
      assertions.filter((entry) => entry.status === "passed").length,
    );
    assert(raw.numPassedTests > 0);
    if (!allowFiltered) {
      assert.equal(raw.numPendingTests, 0, prefix + ": required assertions cannot be skipped");
      assert.equal(raw.numTodoTests ?? 0, 0);
      assert(assertions.every((entry) => entry.status === "passed"));
    }
  }
  return assertions;
}

export function requirePhase013CaseMapping(plan, assertions) {
  assert.equal(plan.phase, 13);
  assert.equal(plan.testMode, "full");
  assert.equal(plan.crossAttemptReuse, "disabled");
  assert.deepEqual(
    plan.requiredCaseIds,
    [
      "create-read",
      "disable-enable",
      "rotate-revoke",
      "authorization",
      "crypto-redaction",
      "failure-atomicity",
    ].map((key) => "Phase013:" + key),
  );
  assert.deepEqual(
    plan.cases.map((entry) => entry.testCaseId),
    plan.requiredCaseIds,
  );
  const mapped = {};
  for (const item of plan.cases) {
    assert.equal(item.denominator, 1);
    const expected = {
      file: "tests/admin/api-keys.integration.test.ts",
      tag: "[" + item.testCaseId.slice("Phase013:".length) + "]",
      minimum: 1,
    };
    assert.deepEqual(item.assertionSelector, expected);
    const selected = assertions.filter(
      (entry) => entry.file === expected.file && entry.fullName.includes(expected.tag),
    );
    assert(
      selected.length >= expected.minimum,
      prefix + ": missing business assertion for " + item.testCaseId,
    );
    assert(
      selected.every((entry) => entry.status === "passed"),
      prefix + ": mapped assertion did not pass",
    );
    mapped[item.testCaseId] = selected.map(({ file, fullName }) => ({ file, fullName }));
  }
  for (const file of [
    "tests/lib/secret-envelope.test.ts",
    "tests/integration/secret-envelope.test.ts",
    "tests/admin/logs.test.ts",
    "tests/admin/api-keys-client.test.tsx",
    "tests/admin/logs-client.test.tsx",
  ]) {
    const selected = assertions.filter((entry) => entry.file === file);
    assert(
      selected.length > 0 && selected.every((entry) => entry.status === "passed"),
      prefix + ": missing supplemental file " + file,
    );
    const keys = file.includes("secret-envelope")
      ? ["crypto-redaction"]
      : file.includes("logs.test")
        ? ["authorization", "crypto-redaction", "failure-atomicity"]
        : ["failure-atomicity"];
    for (const key of keys) {
      const scoped = file.includes("logs.test")
        ? selected.filter((entry) => entry.fullName.includes("[" + key + "]"))
        : selected;
      assert(scoped.length > 0, prefix + ": missing supplemental assertion group " + key);
      mapped["Phase013:" + key].push(
        ...scoped.map(({ file: source, fullName }) => ({ file: source, fullName })),
      );
    }
  }
  return mapped;
}

export function requirePhase013Discovery(discovery, assertions, base) {
  assert(Array.isArray(discovery) && discovery.length > 0, prefix + ": missing test discovery");
  const expected = discovery
    .map((entry) => {
      assert(typeof entry.file === "string" && typeof entry.name === "string");
      const file = path.relative(base, entry.file).replaceAll("\\", "/");
      assert(!file.startsWith("../") && !path.isAbsolute(file));
      return file + "\0" + entry.name;
    })
    .sort();
  const actual = assertions.map((entry) => entry.file + "\0" + entry.discoveryName).sort();
  assert.equal(new Set(expected).size, expected.length, prefix + ": duplicate discovered test");
  assert.deepEqual(
    actual,
    expected,
    prefix + ": full execution differs from discovered assertions",
  );
  assert(assertions.every((entry) => entry.status === "passed"));
  return {
    discoveredAssertions: expected.length,
    executedAssertions: actual.length,
    discoveredFiles: [...new Set(assertions.map((entry) => entry.file))].sort(),
  };
}

export function phase013NegativeControlDefinitions() {
  return [
    {
      id: "require-admin",
      file: "src/server/auth/guards.ts",
      before: "const principal = await requireAdmin(request);",
      after:
        'const principal = { id: "fixture-admin", role: "ADMIN" } as unknown as AdminPrincipal;',
      files: ["tests/lib/auth-guards.test.ts", "tests/admin/api-keys.integration.test.ts"],
      pattern:
        "\\[authorization\\]|requireAdmin server authorization|management page, Route Handler and Server Action guard ordering",
      requiredFailures: [
        {
          file: "tests/admin/api-keys.integration.test.ts",
          fullName:
            "admin/api-keys real PostgreSQL [authorization] rejects every unauthenticated or stale principal and CSRF failure with zero protected reads or writes",
          anchor:
            "expect(list.queries?.some((query) => query.includes('\"ApiKeyConfig\"'))).toBe(false);",
          matcher: "toBe",
          failureHeader: "AssertionError: expected true to be false // Object.is equality",
        },
      ],
      additionalMutations: [
        {
          file: "src/server/admin/api-keys.ts",
          before:
            "async list(request: Request): Promise<ApiKeyPage> {\n      try {\n        const identity = await authorize(request);",
          after:
            'async list(request: Request): Promise<ApiKeyPage> {\n      try {\n        const identity = { principal: { id: "fixture-admin" }, tokenHash: "fixture-token" } as CurrentIdentity;',
        },
      ],
    },
    {
      id: "aad",
      file: "src/server/security/secret-envelope.ts",
      before: "return apiKeyAad(record);",
      after: "return Buffer.alloc(0);",
      files: ["tests/lib/secret-envelope.test.ts"],
      requiredFailures: [
        {
          file: "tests/lib/secret-envelope.test.ts",
          fullName:
            "[crypto-redaction] secret-envelope service AAD and authentication bind record provider version IV tag and ciphertext",
          anchor:
            '      { provider: "another-synthetic-provider" },\n      { envelopeVersion: 2 },\n      { id: "\\ud800" },\n    ])\n      expect(rejectsSafely(() => decryptSecret({ ...value.row, ...patch }, value.resolver))).toBe(\n        true,\n      );',
          matcher: "toBe",
          failureHeader: "AssertionError: expected false to be true // Object.is equality",
        },
        {
          file: "tests/lib/secret-envelope.test.ts",
          fullName:
            "[crypto-redaction] secret-envelope service decryption failures contain only the fixed safe classification",
          anchor: "expect(safe).toBe(true);",
          matcher: "toBe",
          failureHeader: "AssertionError: expected false to be true // Object.is equality",
        },
      ],
    },
    {
      id: "terminal-state",
      file: "src/lib/admin-api-keys.ts",
      before: 'if (current === "REVOKED" && next !== "REVOKED") throw new ApiKeyInputError();',
      after: "/* Isolated security mutation: terminal-state guard removed. */",
      files: ["tests/admin/api-keys.integration.test.ts"],
      pattern: "\\[disable-enable\\]",
      requiredFailures: [
        {
          file: "tests/admin/api-keys.integration.test.ts",
          fullName:
            "admin/api-keys real PostgreSQL [disable-enable] rejects revoked restoration before any write",
          anchor: 'expect(() => assertApiKeyTransition("REVOKED", "ACTIVE")).toThrow();',
          matcher: "toThrow",
          failureHeader: "AssertionError: expected [Function] to throw an error",
        },
      ],
    },
    {
      id: "dto-whitelist",
      file: "src/server/projections/admin-api-key.ts",
      before: 'id, name, provider, left("keyFingerprint"::text,12)',
      after: 'id, name, provider, "encryptedKey", left("keyFingerprint"::text,12)',
      files: ["tests/admin/api-keys.integration.test.ts"],
      pattern: "\\[crypto-redaction\\]",
      requiredFailures: [
        {
          file: "tests/admin/api-keys.integration.test.ts",
          fullName:
            "admin/api-keys real PostgreSQL [crypto-redaction] rejects secret fields at the retained result whitelist",
          anchor:
            "expect(\n          projections.every(\n            (query) =>\n              query.includes('left(\"keyFingerprint\"::text,12)') &&\n              !query.includes('\"encryptedKey\"'),\n          ),\n        ).toBe(true);",
          matcher: "toBe",
          failureHeader: "AssertionError: expected false to be true // Object.is equality",
        },
      ],
    },
  ];
}

function phase013FailureSignal(header) {
  const equality =
    /^AssertionError: expected (true|false) to be (true|false) \/\/ Object\.is equality$/.exec(
      header,
    );
  if (equality)
    return {
      error: "AssertionError",
      matcher: "toBe",
      actual: equality[1] === "true",
      expected: equality[2] === "true",
    };
  assert.equal(header, "AssertionError: expected [Function] to throw an error");
  return { error: "AssertionError", matcher: "toThrow", signal: "MISSING_EXPECTED_THROW" };
}

/** Bind the unchanged original assertions, including their exact matcher positions. */
export function phase013NegativeControlContract(id, readBytes) {
  const definition = phase013NegativeControlDefinitions().find((entry) => entry.id === id);
  assert(definition, prefix + ": unknown negative control");
  const sourceBytes = new Map(definition.files.map((file) => [file, readBytes(file)]));
  const testSourceHashes = Object.fromEntries(
    [...sourceBytes].map(([file, bytes]) => [
      file,
      createHash("sha256").update(bytes).digest("hex"),
    ]),
  );
  const requiredFailures = definition.requiredFailures.map((entry) => {
    assert(sourceBytes.has(entry.file));
    const source = sourceBytes.get(entry.file).toString("utf8");
    assert(!source.includes("\r"), prefix + ": assertion source must retain LF bytes");
    assert.equal(
      source.split(entry.anchor).length - 1,
      1,
      prefix + ": assertion anchor is not unique",
    );
    const matcherToken = "." + entry.matcher + "(";
    assert.equal(entry.anchor.split(matcherToken).length - 1, 1);
    const offset = source.indexOf(entry.anchor) + entry.anchor.indexOf(matcherToken) + 1;
    const location = {
      file: entry.file,
      line: source.slice(0, offset).split("\n").length,
      column: offset - source.lastIndexOf("\n", offset - 1),
    };
    const signal = phase013FailureSignal(entry.failureHeader);
    assert.equal(signal.matcher, entry.matcher);
    return {
      ...entry,
      sourceHash: testSourceHashes[entry.file],
      anchorHash: createHash("sha256").update(entry.anchor).digest("hex"),
      location,
      signal,
    };
  });
  return {
    version: "phase013-exact-security-assertion-v1",
    controlId: id,
    testSourceHashes,
    requiredFailures,
  };
}

function phase013StackPath(value) {
  let normalized = value;
  if (/^file:\/\//i.test(normalized)) {
    const url = new URL(normalized);
    assert(["", "localhost"].includes(url.hostname));
    normalized = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, "$1");
  }
  normalized = normalized.replaceAll("\\", "/");
  if (/^[a-z]:\//i.test(normalized)) return path.win32.normalize(normalized).replaceAll("\\", "/");
  if (normalized.startsWith("/")) return path.posix.normalize(normalized);
  return null;
}

function phase013FirstProjectFrame(message, base) {
  const normalizedBase = phase013StackPath(base);
  assert(normalizedBase, prefix + ": negative execution root must be absolute");
  for (const line of message.split(/\r?\n/).slice(1)) {
    const callsite = /^\s*at\s+(.+?)\s*$/.exec(line);
    if (!callsite) continue;
    // Only these exact native placeholders have no source position. Unknown
    // wrappers must not hide an earlier project frame behind the target frame.
    if (
      /^(?:new Promise|Array\.(?:map|forEach)) \(<anonymous>\)$/.test(callsite[1]) ||
      /^(?:async )?Promise\.(?:all|allSettled|any) \(index [0-9]+\)$/.test(callsite[1])
    )
      continue;
    let position = callsite[1].replace(/^async\s+(?=file:\/\/|[a-z]:[\\/]|\/)/i, "");
    if (!/^(?:file:\/\/|[a-z]:[\\/]|\/|node:)/i.test(position) && position.endsWith(")")) {
      const functionSeparator = position.indexOf(" (");
      assert(functionSeparator > 0, prefix + ": malformed stack wrapper before security assertion");
      position = position.slice(functionSeparator + 2, -1);
    }
    const frame = /^(.+):([1-9][0-9]*):([1-9][0-9]*)$/.exec(position);
    assert(frame, prefix + ": unrecognized source position before security assertion");
    const rawPath = frame[1];
    if (rawPath.startsWith("node:")) continue;
    const file = phase013StackPath(rawPath);
    assert(file, prefix + ": unrecognized source path before security assertion");
    if (/(?:^|\/)node_modules\//.test(file)) continue;
    // Do not search further for a convenient target frame. A helper assertion or
    // a frame from outside this mutation copy is itself a mismatched origin.
    assert(file.startsWith(normalizedBase + "/"), prefix + ": failure frame escaped mutation root");
    const location = {
      file: file.slice(normalizedBase.length + 1),
      line: Number(frame[2]),
      column: Number(frame[3]),
    };
    assert(Number.isSafeInteger(location.line) && Number.isSafeInteger(location.column));
    return location;
  }
  assert.fail(prefix + ": missing original assertion stack frame");
}

/** Re-read raw reports in both the runner and completion path; summaries cannot grant PASS. */
export function requirePhase013NegativeControl(
  id,
  { baselineRaw, baselineRecord, negativeRaw, negativeRecord, readBytes, expectedContract },
) {
  const definition = phase013NegativeControlDefinitions().find((entry) => entry.id === id);
  assert(definition, prefix + ": unknown negative control");
  const contract = phase013NegativeControlContract(id, readBytes);
  assert.deepEqual(
    expectedContract,
    contract,
    prefix + ": original assertion source binding changed",
  );
  assert.equal(baselineRecord.exitCode, 0);
  assert.equal(baselineRecord.timedOut, false);
  assert(Number.isInteger(negativeRecord.exitCode) && negativeRecord.exitCode !== 0);
  assert.equal(negativeRecord.timedOut, false);
  for (const record of [baselineRecord, negativeRecord]) {
    assert.equal(record.signal, null, prefix + ": terminated commands are not assertion evidence");
    assert(phase013StackPath(record.cwd));
  }
  assert.notEqual(phase013StackPath(baselineRecord.cwd), phase013StackPath(negativeRecord.cwd));
  const baseline = requirePhase013Vitest(baselineRaw, {
    base: baselineRecord.cwd,
    allowFiltered: Boolean(definition.pattern),
  });
  const negative = requirePhase013Vitest(negativeRaw, {
    base: negativeRecord.cwd,
    expectedFailure: true,
    allowFiltered: Boolean(definition.pattern),
  });
  const identity = (entry) => entry.file + "\0" + entry.fullName;
  assert.deepEqual(
    negative.map(identity).sort(),
    baseline.map(identity).sort(),
    prefix + ": negative execution changed the original assertion set",
  );
  assert.deepEqual(
    [...new Set(baseline.map((entry) => entry.file))].sort(),
    [...definition.files].sort(),
  );
  for (const entry of negative) {
    const original = baseline.find((candidate) => identity(candidate) === identity(entry));
    if (entry.status === "failed")
      assert.equal(
        original.status,
        "passed",
        prefix + ": negative assertion lacked a passing baseline",
      );
    else
      assert.equal(
        entry.status,
        original.status,
        prefix + ": negative changed assertion selection",
      );
  }
  const observedFailures = contract.requiredFailures.map((required) => {
    const original = baseline.find((entry) => identity(entry) === identity(required));
    const actual = negative.find((entry) => identity(entry) === identity(required));
    assert(original && actual, prefix + ": missing exact original security assertion");
    assert.equal(original.status, "passed");
    assert.equal(
      actual.status,
      "failed",
      prefix + ": the required security assertion did not fail",
    );
    assert.equal(
      actual.failureMessages.length,
      1,
      prefix + ": ambiguous security assertion failure",
    );
    const message = actual.failureMessages[0].replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    const header = message.split(/\r?\n/, 1)[0];
    assert.equal(
      header,
      required.failureHeader,
      prefix + ": wrong security assertion failure signal",
    );
    const signal = phase013FailureSignal(header);
    assert.deepEqual(signal, required.signal);
    const location = phase013FirstProjectFrame(message, negativeRecord.cwd);
    assert.deepEqual(
      location,
      required.location,
      prefix + ": wrong original assertion source position",
    );
    return {
      file: actual.file,
      fullName: actual.fullName,
      failureHeader: header,
      signal,
      location,
      rawFailureMessageHash: createHash("sha256").update(actual.failureMessages[0]).digest("hex"),
    };
  });
  return { contract, observedFailures };
}

export function phase013BusinessObservations(record) {
  assert.equal(record.exitCode, 0);
  assert.equal(record.timedOut, false);
  assert.equal(typeof record.stdout, "string");
  assert.equal(typeof record.stderr, "string");
  const output = (record.stdout + "\n" + record.stderr).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const rows = output.split(/\r?\n/).flatMap((line) => {
    const text = line.trim();
    if (!text.startsWith("{") || !text.endsWith("}")) return [];
    try {
      const value = JSON.parse(text);
      return value?.phase === 13 &&
        typeof value.group === "string" &&
        value.database === "REAL_POSTGRESQL17"
        ? [value]
        : [];
    } catch {
      return [];
    }
  });
  assert.deepEqual([...new Set(rows.map((row) => row.group))].sort(), [
    "authorization",
    "create-read",
    "crypto-redaction",
    "disable-enable",
    "failure-atomicity",
    "rotate-revoke",
  ]);
  const state = rows.find(
    (row) => row.group === "disable-enable" && Object.hasOwn(row, "legalStateChanges"),
  );
  assert(
    state && state.legalStateChanges === 3 && state.matchingStateAudits === state.legalStateChanges,
  );
  const rotation = rows.find((row) => row.group === "rotate-revoke" && row.referenceCount === 2);
  assert(
    rotation &&
      rotation.switchedReferences === 2 &&
      rotation.matchingStateAudits === 2 &&
      rotation.oldRevoked === true &&
      rotation.newActive === true,
  );
  const concurrent = rows.find((row) => row.group === "rotate-revoke" && row.contenders === 2);
  assert(concurrent && concurrent.winners === 1 && concurrent.disabledLoserCandidates === 1);
  const authorization = rows.find((row) => row.group === "authorization");
  assert(authorization.rejectedPrincipals >= 4 && authorization.csrfFailures >= 2);
  const redaction = rows.find((row) => row.group === "crypto-redaction");
  assert(redaction.dtoRejectedSecretFields === 5 && redaction.dbSafeProjection === true);
  const zeroFields = [
    "duplicatePlaintextRows",
    "secretHits",
    "revokedRestorations",
    "noopAudits",
    "staleWrites",
    "redirectsFollowed",
    "networkInsideTransaction",
    "extraReplayCandidates",
    "orphanActiveKeys",
    "newCallsAfterRevoke",
    "forgedTargetCalls",
    "partialSwitches",
    "realReferenceCount",
    "providerTableQueries",
    "externalCalls",
    "unauthorizedBusinessReads",
    "unauthorizedBusinessWrites",
    "httpBodyHits",
    "auditHits",
    "fullFingerprintHits",
    "encryptedRowsChanged",
    "statusRowsChanged",
    "receiptsChanged",
    "failedKeyStateChanges",
    "failedActivationAudits",
  ];
  for (const row of rows)
    for (const field of zeroFields)
      if (Object.hasOwn(row, field))
        assert.equal(row[field], 0, prefix + ": nonzero safety metric " + field);
  return rows;
}

export function phase013FixtureBinding(plan, hashFile) {
  const paths = plan.sourcePaths
    .filter(
      (file) => file.startsWith("tests/") && /fixture|worker|browser|node-network-guard/.test(file),
    )
    .sort();
  for (const file of [
    "tests/phase013/api-key-fixture.ts",
    "tests/phase013/api-key-worker.ts",
    "tests/phase013/logs-fixture.ts",
    "tests/phase013/browser.mjs",
  ])
    assert(paths.includes(file), prefix + ": missing synthetic fixture implementation " + file);
  const fixtureHashes = Object.fromEntries(paths.map((file) => [file, hashFile(file)]));
  for (const value of Object.values(fixtureHashes)) assert.match(value, sha256);
  return {
    fixtureHash: createHash("sha256").update(JSON.stringify(fixtureHashes)).digest("hex"),
    fixtureHashScope: "TRACKED_SYNTHETIC_FIXTURE_IMPLEMENTATION_PRIVATE_CREDENTIALS_NOT_ARCHIVED",
    fixtureHashes,
  };
}

export function requirePhase013BrowserReport(report, { diagnostic = false } = {}) {
  assert.equal(report.phase, 13);
  assert.equal(report.status, "PASS");
  assert.equal(report.simulation, true);
  assert.equal(report.productionTraffic, false);
  assert.equal(report.notGate, diagnostic);
  assert.equal(report.verificationScope, "AUTOMATED_BROWSER_A11Y");
  assert.equal(report.humanScreenReaderExperience, "NOT_EVALUATED");
  const ids = [
    "unauthorized-reads-and-login",
    "create-read",
    "disable-enable",
    "rotate-revoke",
    "audit-filters-pagination",
    "responsive-keyboard",
    "failed-read-retry",
    "logout-and-safe-pages",
  ];
  assert.deepEqual(
    report.results.map((entry) => entry.id),
    ids,
  );
  assert.equal(report.caseCount, ids.length);
  assert(report.results.every((entry) => entry.status === "PASS"));
  assert.equal(report.externalRequestCount, 0);
  assert.equal(report.privacyFailures, 0);
  assert(Number.isInteger(report.localRequestCount) && report.localRequestCount > 0);
  assert.equal(typeof report.browserVersion, "string");
  assert.match(report.browserVersion, /^\d+(?:\.\d+)+$/);
  assert.match(report.serverOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const categories = [
    "httpBodies",
    "html",
    "browserStorage",
    "logs",
    "audit",
    "dbSafeProjection",
    "trace",
    "evidence",
  ];
  assert.deepEqual(Object.keys(report.secretScans).sort(), [...categories, "hits"].sort());
  for (const category of categories)
    assert(
      Number.isInteger(report.secretScans[category]) && report.secretScans[category] > 0,
      prefix + ": missing actual browser scan category " + category,
    );
  assert.equal(report.secretScans.hits, 0);
  assert(Array.isArray(report.responseEvidence) && report.responseEvidence.length > 0);
  for (const response of report.responseEvidence) assert.match(response.sha256, sha256);
  assert(Array.isArray(report.artifacts) && report.artifacts.length > 0);
  return {
    caseCount: report.caseCount,
    externalRequestCount: report.externalRequestCount,
    localRequestCount: report.localRequestCount,
    privacyFailures: report.privacyFailures,
    secretScans: report.secretScans,
    responseCount: report.responseEvidence.length,
    browserVersion: report.browserVersion,
  };
}

export function getPhase013ImplementationSnapshot({
  root,
  plan,
  receipt,
  git,
  hashFile,
  inventory,
  migrationPath,
}) {
  const migrations = inventory("prisma/migrations")
    .filter((file) => file.endsWith("/migration.sql"))
    .sort();
  assert.deepEqual(
    migrations,
    [...receipt.prerequisites.migrations.map((entry) => entry.path), migrationPath].sort(),
    "IMPLEMENTATION_CHANGED: unexpected migration inventory",
  );
  const plannedSources = new Set([...plan.sourcePaths, migrationPath]);
  for (const file of [...inventory("src"), ...inventory("tests"), ...inventory("prisma")]) {
    assert(
      plannedSources.has(file),
      `IMPLEMENTATION_CHANGED: unregistered product or test file ${file}`,
    );
  }
  const changed = [
    ...new Set(
      [
        ...git(["diff", "--no-renames", "--name-only", "-z", receipt.phaseStartCommit]).split("\0"),
        ...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
      ].filter(Boolean),
    ),
  ].sort();
  for (const file of changed)
    assert(
      plan.modificationScope.some((scope) =>
        scope.endsWith("/") ? file.startsWith(scope) : scope === file,
      ),
      `IMPLEMENTATION_CHANGED: out-of-scope path ${file}`,
    );
  return Object.fromEntries(
    changed
      .filter((file) => !file.startsWith("docs/evidence/attempts/Phase013/"))
      .map((file) => [file, fs.existsSync(path.join(root, file)) ? hashFile(file) : null]),
  );
}
