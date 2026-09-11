import assert from "node:assert/strict";

export const phase001SourcePaths = Object.freeze(
  [
    "docs/git-workflow.md",
    "docs/code-style.md",
    "docs/ui-design-system.md",
    "docs/database.md",
    "docs/phase-plans/Phase001.json",
    "docs/phase-plans/Phase001-inputs.json",
    "docs/phase-plans/verify-phase001.mjs",
    "docs/phase-plans/prepare-phase001.mjs",
    "docs/phase-plans/retry-phase001.mjs",
    "docs/phase-plans/replay-historical-phase.ps1",
    "docs/phase-plans/complete-phase001.mjs",
    "docs/agent-execution-contract.md",
    "docs/tech-stack.md",
    "docs/directory-structure.md",
    "scripts/check-project-layout.mjs",
    "scripts/validate-phase.mjs",
    "scripts/validate-phase.ps1",
    "scripts/test-validate-phase.mjs",
    "scripts/phase-evidence.mjs",
  ].sort(),
);

export function requireEvidenceSources(plan, { protocolFixture = false } = {}) {
  const sources = plan.sourcePaths;
  assert(
    Array.isArray(sources) &&
      sources.length > 0 &&
      sources.every((value) => typeof value === "string" && value.length > 0),
    "PLAN_SOURCE_PATHS: sourcePaths must be nonempty",
  );
  assert.equal(new Set(sources).size, sources.length, "PLAN_SOURCE_PATHS: duplicate source");
  if (plan.phase === 1 && !protocolFixture)
    assert.deepEqual(
      [...sources].sort(),
      phase001SourcePaths,
      "PLAN_SOURCE_PATHS: incomplete Phase001 source inventory",
    );
  return [...sources].sort();
}

export function requireHashCoverage(hashes, expectedPaths, hashFile, code) {
  assert(
    hashes !== null && typeof hashes === "object" && !Array.isArray(hashes),
    `${code}: hash map is required`,
  );
  assert.deepEqual(
    Object.keys(hashes).sort(),
    [...expectedPaths].sort(),
    `${code}: hash map must cover every required file exactly`,
  );
  for (const [file, expected] of Object.entries(hashes)) {
    assert(
      typeof expected === "string" && /^[0-9a-f]{64}$/.test(expected),
      `${code}: invalid hash for ${file}`,
    );
    assert.equal(hashFile(file), expected, `${code}: bytes changed for ${file}`);
  }
}

export function requireReviewIdentity(
  review,
  implementationContextId,
  { protocolFixture = false } = {},
) {
  const kind = protocolFixture
    ? "SYNTHETIC_PROTOCOL_FIXTURE_NOT_AGENT_REVIEW"
    : "INDEPENDENT_CODEX_AGENT";
  assert.equal(review.runnerIdentity?.kind, kind, "REVIEW_IDENTITY: unexpected reviewer kind");
  assert.equal(
    review.runnerIdentity?.implementationAuthored,
    false,
    "REVIEW_IDENTITY: reviewer authored implementation",
  );
  assert(
    typeof implementationContextId === "string" && implementationContextId.length > 0,
    "REVIEW_IDENTITY: implementation context is required",
  );
  assert.equal(
    review.implementationContextId,
    implementationContextId,
    "REVIEW_IDENTITY: implementation context binding differs",
  );
  for (const key of ["contextId", "reviewerRunId", "generatedBy"])
    assert(
      typeof review[key] === "string" && review[key].length > 0,
      `REVIEW_IDENTITY: ${key} is required`,
    );
  assert.notEqual(
    review.contextId,
    implementationContextId,
    "REVIEW_IDENTITY: reviewer must use a different context",
  );
}

export function requireReportBinding(report, item, planHash, sources, hashFile) {
  for (const [key, value] of Object.entries({
    testCaseId: item.testCaseId,
    command: item.command,
    status: "PASS",
    exitCode: 0,
    numerator: item.denominator,
    denominator: item.denominator,
    inputPath: item.inputPath,
    inputHash: hashFile(item.inputPath),
    planHash,
  })) {
    assert.equal(report[key], value, `REPORT_BINDING: ${item.testCaseId}.${key}`);
  }
  requireHashCoverage(report.sourceHashes, sources, hashFile, "REPORT_SOURCE_HASH");
}

export function requirePriorCaseBinding(plan, priorPlan, { readJson, hashFile } = {}) {
  assert.equal(
    plan.phase,
    priorPlan.phase,
    "PRIOR_PLAN_PHASE: prior plan belongs to another phase",
  );
  const extensions = plan.expectationExtensions ?? [];
  assert(Array.isArray(extensions), "PRIOR_PLAN_EXPECTATION: extensions must be an array");
  const extensionKeys = new Set();
  const validatedExtensions = [];
  for (const extension of extensions) {
    // Phase009's failed attempt preserved all original text but added review requirements.
    // Accept only an explicit append bound to the immutable prior plan, never replacement text.
    assert.equal(plan.phase, 9, "PRIOR_PLAN_EXPECTATION: unsupported phase");
    assert.equal(typeof readJson, "function", "PRIOR_PLAN_EXPECTATION: artifact reader required");
    assert.equal(typeof hashFile, "function", "PRIOR_PLAN_EXPECTATION: hash reader required");
    assert.deepEqual(
      Object.keys(extension).sort(),
      [
        "testCaseId",
        "priorPlanPath",
        "priorPlanHash",
        "originalExpected",
        "appendedExpected",
        "reason",
      ].sort(),
      "PRIOR_PLAN_EXPECTATION: unexpected receipt fields",
    );
    const binding = plan.previousAttempts?.find(
      (entry) => entry.planPath === extension.priorPlanPath,
    );
    assert(binding, "PRIOR_PLAN_EXPECTATION: receipt must bind a recorded prior attempt");
    assert.equal(
      extension.priorPlanHash,
      binding.planHash,
      "PRIOR_PLAN_EXPECTATION: prior binding differs",
    );
    assert.equal(
      hashFile(binding.planPath),
      binding.planHash,
      "PRIOR_PLAN_EXPECTATION: prior bytes changed",
    );
    const previous = readJson(binding.planPath);
    assert.equal(previous.phase, plan.phase, "PRIOR_PLAN_EXPECTATION: wrong prior phase");
    assert.equal(
      previous.attemptId,
      binding.attemptId,
      "PRIOR_PLAN_EXPECTATION: wrong prior attempt",
    );
    const old = previous.cases.find((entry) => entry.testCaseId === extension.testCaseId);
    const current = plan.cases.find((entry) => entry.testCaseId === extension.testCaseId);
    assert(old && current, "PRIOR_PLAN_EXPECTATION: unknown case");
    assert.equal(
      extension.originalExpected,
      old.expected,
      "PRIOR_PLAN_EXPECTATION: original requirement changed",
    );
    assert(
      typeof extension.appendedExpected === "string" && /^ \S/.test(extension.appendedExpected),
      "PRIOR_PLAN_EXPECTATION: nonempty appended requirement required",
    );
    assert(
      typeof extension.reason === "string" && extension.reason.trim(),
      "PRIOR_PLAN_EXPECTATION: reason required",
    );
    assert.equal(
      current.expected,
      old.expected + extension.appendedExpected,
      "PRIOR_PLAN_EXPECTATION: original requirement must remain verbatim",
    );
    const key = `${binding.attemptId}:${extension.testCaseId}`;
    assert(!extensionKeys.has(key), "PRIOR_PLAN_EXPECTATION: duplicate receipt");
    extensionKeys.add(key);
    validatedExtensions.push({ ...extension, priorAttemptId: binding.attemptId });
  }
  const corrections = plan.inputPathCorrections ?? [];
  assert(Array.isArray(corrections), "PRIOR_PLAN_INPUT_PATH: corrections must be an array");
  assert(
    corrections.length <= 1,
    "PRIOR_PLAN_INPUT_PATH: only one generated migration correction is supported",
  );
  const correction = corrections[0];
  if (correction) {
    assert.equal(plan.phase, 7, "PRIOR_PLAN_INPUT_PATH: only Phase007 supports this correction");
    assert.equal(
      correction.testCaseId,
      "Phase007:migration",
      "PRIOR_PLAN_INPUT_PATH: only the migration case can change its input path",
    );
    const migrationPattern = /^prisma\/migrations\/[0-9]{14}_system_config\/migration\.sql$/;
    for (const key of ["from", "to"]) {
      assert(
        typeof correction[key] === "string" && migrationPattern.test(correction[key]),
        `PRIOR_PLAN_INPUT_PATH: invalid ${key} migration path`,
      );
    }
    assert.notEqual(
      correction.from,
      correction.to,
      "PRIOR_PLAN_INPUT_PATH: correction must change the path",
    );
    assert(
      typeof correction.reason === "string" && correction.reason.trim(),
      "PRIOR_PLAN_INPUT_PATH: correction reason is required",
    );
    const receiptPath = "docs/evidence/attempts/Phase007/setup/migration-generation.json";
    assert.equal(
      correction.receiptPath,
      receiptPath,
      "PRIOR_PLAN_INPUT_PATH: unexpected generation receipt path",
    );
    assert(
      typeof correction.receiptHash === "string" && /^[0-9a-f]{64}$/.test(correction.receiptHash),
      "PRIOR_PLAN_INPUT_PATH: invalid receipt hash",
    );
    assert(
      typeof readJson === "function" && typeof hashFile === "function",
      "PRIOR_PLAN_INPUT_PATH: artifact readers are required",
    );
    assert.equal(
      hashFile(receiptPath),
      correction.receiptHash,
      "PRIOR_PLAN_INPUT_PATH: generation receipt bytes changed",
    );
    const generation = readJson(receiptPath);
    assert(
      generation && typeof generation === "object" && !Array.isArray(generation),
      "PRIOR_PLAN_INPUT_PATH: invalid generation receipt",
    );
    assert.equal(
      generation.generatedMigrationPath,
      correction.to,
      "PRIOR_PLAN_INPUT_PATH: target differs from the actual generated migration",
    );
    const current = plan.cases.find((item) => item.testCaseId === correction.testCaseId);
    assert(current, "PRIOR_PLAN_INPUT_PATH: corrected case is absent");
    assert.equal(
      current.inputPath,
      correction.to,
      "PRIOR_PLAN_INPUT_PATH: current input does not use the generated path",
    );
    const rawPath = generation.rawMigrationPath;
    assert(
      typeof rawPath === "string" &&
        rawPath.startsWith("docs/evidence/attempts/Phase007/setup/") &&
        rawPath.endsWith(".sql") &&
        rawPath
          .split("/")
          .every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== ".."),
      "PRIOR_PLAN_INPUT_PATH: raw migration must be archived inside Phase007 setup evidence",
    );
    assert(
      typeof generation.rawMigrationHash === "string" &&
        /^[0-9a-f]{64}$/.test(generation.rawMigrationHash),
      "PRIOR_PLAN_INPUT_PATH: invalid raw migration hash",
    );
    assert.equal(
      hashFile(rawPath),
      generation.rawMigrationHash,
      "PRIOR_PLAN_INPUT_PATH: generated SQL bytes changed",
    );
    assert(
      typeof generation.schemaHash === "string" && /^[0-9a-f]{64}$/.test(generation.schemaHash),
      "PRIOR_PLAN_INPUT_PATH: invalid generation schema hash",
    );
    assert.equal(
      hashFile("prisma/schema.prisma"),
      generation.schemaHash,
      "PRIOR_PLAN_INPUT_PATH: generation schema bytes changed",
    );
    const generatedHash = hashFile(correction.to);
    assert(
      typeof generatedHash === "string" && /^[0-9a-f]{64}$/.test(generatedHash),
      "PRIOR_PLAN_INPUT_PATH: generated migration file is missing or has an invalid hash",
    );
    // The CLI can omit its summary; the receipt binds the generated SQL and current schema.
    const commandPattern =
      /^npm run db:migrate -- (?:--name system_config --create-only|--create-only --name system_config)(?: --skip-generate)?$/;
    assert(
      Array.isArray(generation.records) &&
        generation.records.some(
          (record) =>
            record &&
            record.exitCode === 0 &&
            record.timedOut === false &&
            typeof record.command === "string" &&
            commandPattern.test(record.command) &&
            typeof record.stdout === "string" &&
            typeof record.stderr === "string",
        ),
      "PRIOR_PLAN_INPUT_PATH: no successful create-only command has complete output records",
    );
  }
  for (const oldCase of priorPlan.cases) {
    const current = plan.cases.find((item) => item.testCaseId === oldCase.testCaseId);
    assert(current, `PRIOR_PLAN_CASES: required case removed: ${oldCase.testCaseId}`);
    for (const key of ["command", "denominator"]) {
      assert.equal(
        current[key],
        oldCase[key],
        `PRIOR_PLAN_CASES: frozen assertion changed: ${oldCase.testCaseId}.${key}`,
      );
    }
    const extension = validatedExtensions.find(
      (entry) =>
        entry.testCaseId === oldCase.testCaseId && entry.priorAttemptId === priorPlan.attemptId,
    );
    assert.equal(
      current.expected,
      extension ? oldCase.expected + extension.appendedExpected : oldCase.expected,
      `PRIOR_PLAN_CASES: frozen assertion changed: ${oldCase.testCaseId}.expected`,
    );
    if (current.inputPath === oldCase.inputPath) continue;
    assert(
      correction &&
        correction.testCaseId === oldCase.testCaseId &&
        correction.from === oldCase.inputPath &&
        correction.to === current.inputPath,
      `PRIOR_PLAN_INPUT_PATH: undeclared input path change: ${oldCase.testCaseId}`,
    );
  }
}
