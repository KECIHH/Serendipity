import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  root,
  plan,
  planPath,
  receiptPath,
  directory,
  read,
  json,
  hash,
  git,
  command,
  write,
  sourceFiles,
  fixtureFiles,
  environment,
  ensureDatabase,
} from "./phase018-runtime.mjs";
import { caseTags, requirePlan, requireInputs, startCommit } from "./phase018-evidence.mjs";

const mode = process.argv.includes("--receipt") ? "receipt" : "freeze";

if (mode === "receipt") {
  assert(!fs.existsSync(path.join(root, receiptPath)), "RECEIPT_ALREADY_EXISTS");
  assert.equal(git(["rev-parse", "HEAD"]).trim(), startCommit, "PREPARE_HEAD");
  assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all"]).trim(), "", "PREFLIGHT_DIRTY");
  const previous = json("docs/phase-plans/Phase017-inputs.json");
  const state = json("docs/roadmap-run.json");
  const checkpoint = state.checkpoints.at(-1);
  assert.equal(checkpoint.phase, 17);
  const seals = ["powershell", "pwsh"].map((shell) => {
    const result = command(
      shell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "scripts/validate-phase.ps1",
        "-CompletedThrough",
        "17",
        "-Json",
      ],
      { timeoutMs: 600000 },
    );
    return { ...result, executable: shell };
  });
  const receipt = {
    layoutVersion: previous.layoutVersion,
    phase: 18,
    repositoryRoot: previous.repositoryRoot,
    projectRoot: previous.projectRoot,
    roadmapRoot: previous.roadmapRoot,
    baselineCommit: previous.baselineCommit,
    executionBaselineCommit: previous.executionBaselineCommit,
    phaseStartCommit: startCommit,
    manifestHash: state.manifestHash,
    requestedThrough: 18,
    pinnedInputPolicy: previous.pinnedInputPolicy,
    checkpointMigration: previous.checkpointMigration,
    checkpointMaintenance: previous.checkpointMaintenance,
    validationPolicy: previous.validationPolicy,
    executionMaintenance: previous.executionMaintenance,
    executionPolicy: previous.executionPolicy,
    pinnedInputs: previous.pinnedInputs,
    prerequisites: {
      phase: 17,
      metadataCommit: startCommit,
      artifactCommit: checkpoint.artifactCommit,
      evidencePath: checkpoint.evidencePath,
      evidenceHash: checkpoint.evidenceHash,
      schemaPath: "prisma/schema.prisma",
      schemaHash: hash("prisma/schema.prisma"),
      migrations: fs
        .readdirSync(path.join(root, "prisma/migrations"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `prisma/migrations/${entry.name}/migration.sql`)
        .sort()
        .map((file) => ({ path: file, sha256: hash(file) })),
    },
    preflight: {
      head: git(["rev-parse", "HEAD"]).trim(),
      originMain: git(["rev-parse", "origin/main"]).trim(),
      porcelain: git(["status", "--porcelain=v1", "--untracked-files=all"]).trim(),
      branch: git(["branch", "--show-current"]).trim(),
      remote: git(["remote", "get-url", "origin"]).trim(),
      seals,
    },
  };
  for (const item of [...receipt.pinnedInputs, receipt.checkpointMigration, receipt.checkpointMaintenance, receipt.validationPolicy, receipt.executionMaintenance, receipt.executionPolicy])
    assert.equal(hash(item.path), item.sha256, `INPUT_HASH:${item.path}`);
  requireInputs(receipt, { readJson: json, hashFile: hash, git });
  write(receiptPath, receipt);
  console.log(
    JSON.stringify({
      status: "RECEIPT_WRITTEN",
      phase: 18,
      pinnedInputs: receipt.pinnedInputs.length,
      seals: receipt.preflight.seals.map((seal) => ({ shell: seal.executable, exitCode: seal.exitCode })),
    }),
  );
} else {
  assert(
    !fs.existsSync(path.join(root, directory, "quality.json")) &&
      !fs.existsSync(path.join(root, directory, "attempt.json")),
    "ATTEMPT_ALREADY_EXECUTED",
  );
  const recoveryHeads = plan.previousAttempts
    .map((attempt) => attempt.metadataCommit)
    .filter(Boolean);
  assert(
    [startCommit, ...recoveryHeads].includes(git(["rev-parse", "HEAD"]).trim()),
    "PREPARE_HEAD",
  );
  requireInputs(json(receiptPath), { readJson: json, hashFile: hash, git });
  await ensureDatabase();
  const additions = [
    ...sourceFiles(),
    ...fixtureFiles(),
    "docs/ai-debug.md",
    "docs/milestone-gate-m4.md",
    "docs/phase-plans/prepare-phase018.mjs",
    "docs/phase-plans/phase018-runtime.mjs",
    "docs/phase-plans/phase018-evidence.mjs",
    "docs/phase-plans/verify-phase018.mjs",
    "docs/phase-plans/complete-phase018.mjs",
    "docs/phase-plans/Phase018.json",
    "docs/phase-plans/Phase018-inputs.json",
    "docs/testing-execution-policy.md",
    "docs/development-execution-policy.md",
    ".env.example",
    ".gitattributes",
    ".gitignore",
    ".prettierignore",
    ".prettierrc.json",
    "eslint.config.mjs",
    "next.config.ts",
    "postcss.config.mjs",
    "tsconfig.json",
  ];
  plan.sourcePaths = [...new Set([...plan.sourcePaths, ...additions])].sort();
  for (const file of plan.sourcePaths) assert(fs.existsSync(path.join(root, file)), `SOURCE_MISSING:${file}`);
  plan.fixtureSourcePaths = fixtureFiles();
  const scratch = `.scaffold/phase018/freeze-${plan.attemptId}.json`;
  const result = command(process.execPath, ["node_modules/vitest/vitest.mjs", "list", `--json=${scratch}`], {
    env: environment(),
    timeoutMs: 180000,
  });
  assert.equal(result.exitCode, 0, "DISCOVERY_FAILED");
  const discovery = json(scratch);
  assert(discovery.length > 0);
  const rows = discovery.map((row) => ({
    file: path.relative(root, row.file).replaceAll("\\", "/"),
    fullName: row.name.replaceAll(" > ", " "),
  }));
  plan.assertionBindings = Object.fromEntries(
    Object.entries(caseTags).map(([id, tag]) => [
      id,
      rows
        .filter((row) => row.file.startsWith("tests/integration/") && row.fullName.includes(tag))
        .sort((a, b) => `${a.file}:${a.fullName}`.localeCompare(`${b.file}:${b.fullName}`, "en")),
    ]),
  );
  const covered = new Set(Object.values(plan.assertionBindings).flat().map((row) => row.file + "::" + row.fullName));
  assert(
    rows.filter((row) => row.file.startsWith("tests/integration/ai-e2e")).every((row) => covered.has(row.file + "::" + row.fullName)),
    "UNMAPPED_CARD_ASSERTION",
  );
  for (const [id, bindings] of Object.entries(plan.assertionBindings))
    assert(bindings.length > 0, `EMPTY_ASSERTION_BINDING:${id}`);
  write(`${directory}/frozen-discovery.json`, discovery, false);
  plan.discoverySnapshot = {
    path: `${directory}/frozen-discovery.json`,
    sha256: hash(`${directory}/frozen-discovery.json`),
    discovered: discovery.length,
  };
  const frozenAt = new Date().toISOString();
  plan.executionFreeze = {
    frozenAt,
    requirementsPath: "docs/evidence/attempts/Phase018/attempt-1/requirements-freeze.json",
    requirementsHash: "",
    crossAttemptReuse: "disabled",
  };
  plan.costAccounting = { ...plan.costAccounting, implementationStartedAt: frozenAt };
  write(
    plan.executionFreeze.requirementsPath,
    {
      phase: 18,
      attemptId: plan.attemptId,
      frozenAt,
      phaseStartCommit: startCommit,
      scope: plan.scope,
      requiredCaseIds: plan.requiredCaseIds,
      cases: plan.cases,
      negativeControls: plan.negativeControls,
      supportingChecks: plan.supportingChecks,
      threshold: plan.threshold,
      sourcePaths: plan.sourcePaths,
      crossAttemptReuse: "disabled",
    },
    false,
  );
  plan.executionFreeze.requirementsHash = hash(plan.executionFreeze.requirementsPath);
  requirePlan(plan, { readJson: json, hashFile: hash, allowUnwrittenDiscovery: true });
  write(planPath, plan, false);
  write(`${directory}/frozen-plan.json`, read(planPath), false);
  write(`${directory}/freeze-command.json`, result, false);
  write(`${directory}/input-receipt.json`, read(receiptPath), false);
  write(
    `${directory}/source-basis.json`,
    {
      planHash: hash(planPath),
      sourceHashes: Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(file)])),
    },
    false,
  );
  console.log(
    JSON.stringify({
      status: "FROZEN",
      phase: 18,
      attemptId: plan.attemptId,
      sources: plan.sourcePaths.length,
      discovered: discovery.length,
      bindings: Object.fromEntries(
        Object.entries(plan.assertionBindings).map(([id, values]) => [id, values.length]),
      ),
    }),
  );
}
