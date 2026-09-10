import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => fs.readFileSync(path.join(root, file));
const json = (file) => JSON.parse(read(file));
const hash = (file) => createHash("sha256").update(read(file)).digest("hex");
const git = (...args) => {
  const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const write = (file, value) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
};
const planPath = "docs/phase-plans/Phase007.json";
const receiptPath = "docs/phase-plans/Phase007-inputs.json";
const preflightPath = "docs/evidence/attempts/Phase007/setup/preflight.json";
const state = json("docs/roadmap-run.json");
const previous = json("docs/phase-plans/Phase006-inputs.json");
const preflight = json(preflightPath);
assert.equal(state.currentPhase, 7);
assert.equal(state.completedThrough, 6);
assert.equal(git("rev-parse", "HEAD"), preflight.head);
assert.equal(git("rev-parse", "origin/main"), preflight.head);
assert.equal(git("branch", "--show-current"), "main");
assert.equal(preflight.workingTree, "");
assert.equal(preflight.ahead, 0);
assert.equal(preflight.behind, 0);
assert.equal(preflight.shells.length, 2);
for (const shell of preflight.shells) {
  assert.equal(shell.exitCode, 0);
  assert.equal(shell.result.status, "PASS");
  assert.equal(shell.result.completedThrough, 6);
  assert.equal(shell.result.metadataCommit, preflight.head);
}
assert.equal(git("config", "--get", "remote.origin.url"), preflight.remote);
assert.equal(git("status", "--porcelain=v1", "--untracked-files=all", "--", ":(exclude)docs/phase-plans/prepare-phase007.mjs", ":(exclude)docs/evidence/attempts/Phase007/setup/preflight.json"), "");
for (const input of previous.pinnedInputs) assert.equal(hash(input.path), input.sha256, `Pinned input changed: ${input.path}`);
const checkpoint = state.currentLayoutPhaseSeal;
assert.equal(checkpoint.phase, 6);
assert.equal(hash(checkpoint.evidencePath), checkpoint.evidenceHash);
const oldGate = json(checkpoint.evidencePath);
assert.equal(oldGate.artifactCommit, checkpoint.artifactCommit);
assert.equal(git("rev-parse", `${preflight.head}^`), checkpoint.artifactCommit);

const newFiles = [
  "docs/phase-plans/prepare-phase007.mjs", "docs/phase-plans/phase007-runtime.mjs",
  "docs/phase-plans/setup-phase007.mjs", "docs/phase-plans/verify-phase007.mjs",
  "docs/phase-plans/complete-phase007.mjs", planPath, receiptPath, "docs/phase007.md",
  "src/server/projections/public-user.ts", "src/server/projections/admin-user.ts",
  "src/lib/schemas/system-config.ts", "tests/lib/public-user.test.ts",
  "tests/integration/config-models.test.ts", "tests/phase007/config-fixture.ts",
  "tests/phase007/config-types.ts", "tests/phase007/cli-network.mjs",
  "prisma/migrations/20260911000000_system_config/migration.sql",
];
const sourcePaths = [...new Set([
  ...json("docs/phase-plans/Phase006.json").sourcePaths,
  "docs/code-style.md", "docs/privacy-and-user-data.md", ...newFiles,
])].sort();
const specs = [
  ["migration", "prisma/migrations/20260911000000_system_config/migration.sql", "A real migrate-dev generated additive migration replays from the Phase006 baseline, preserves its schema/data, has no drift, and passes migrate status and client generation on verified disposable PostgreSQL 17."],
  ["schema", "tests/integration/config-models.test.ts", "Exact SystemConfig fields, JSON roundtrip, required columns, timestamptz precision, indexes, CHECKs and foreign key match Prisma and PostgreSQL; forbidden models/secrets are absent; concurrent fixtures clean only their recorded IDs."],
  ["default-private", "tests/integration/config-models.test.ts", "Omitted isPublic reads false; revision defaults to zero and rejects negatives; public exposure is never a model default."],
  ["key-uniqueness", "tests/integration/config-models.test.ts", "The database rejects duplicate configuration keys with Prisma P2002."],
  ["group-validation", "tests/integration/config-models.test.ts", "Exactly AI/UI/EXPORT/SECURITY/GENERAL succeed; unknown groups fail both the application schema and direct SQL CHECK."],
  ["user-fk", "tests/integration/config-models.test.ts", "Unknown updatedBy fails; deleting a test user preserves configuration and sets the actor null; changing the referenced ID cascades."],
  ["projection", "tests/lib/public-user.test.ts", "PUBLIC_USER_FIELDS has exactly eight keys; ADMIN extends it by revision only. Types and real Prisma select return no passwordHash/sessionVersion/phone; server-only imports have no unauthorized production consumers."],
  ["mutation", "tests/integration/config-models.test.ts", "Separate disposable migration/source copies flip isPublic to true, remove the group CHECK, and expose sessionVersion. Each corresponding real assertion fails for the intended reason; restored copies and all original cases pass."],
];
const attemptId = "attempt-1";
const plan = {
  phase: 7, attemptId, producer: "Phase007", consumers: [10, 11, 12, 14],
  scope: "SYSTEM_CONFIG_MODEL_AND_SAFE_ACCOUNT_PROJECTIONS",
  implementationContextId: "codex:/root:Phase007:20260911",
  sourcePaths,
  requiredCaseIds: specs.map(([key]) => `Phase007:${key}`),
  cases: specs.map(([key, inputPath, expected]) => ({
    testCaseId: `Phase007:${key}`, command: `node docs/phase-plans/verify-phase007.mjs --case ${key}`,
    denominator: 1, inputPath, outputPath: `docs/evidence/attempts/Phase007/${attemptId}/${key}.json`, expected,
  })),
  modificationScope: [
    ...newFiles, "prisma/schema.prisma", "tests/phase006/database.integration.ts",
    "docs/evidence/attempts/Phase007/",
  ],
  threshold: { originalThreshold: 8, automatedThreshold: 8, requiredPassRate: 1, waived: false },
  supportingChecks: ["lint", "typecheck", "test", "format-check", "build", "project-layout", "phase003-regression", "phase006-user-regression", "evidence-binding", "dependency-versions", "prisma-cli-network-isolation", "secret-and-scope-scan"],
  decisions: [
    "The user authorized only Phase007. The attached Phase006 document supplies prerequisite context; no later phase is executed.",
    "Keep the current root layout, existing synced Git history and all sealed evidence unchanged. Local roadmap documents remain ignored; retain their previously pinned SHA-256 values.",
    "Use the existing pinned runtime and dependencies; no new library, service, API, seed, UI or future business model is required.",
    "Generate one system_config migration with migrate dev --create-only, fix its unapplied directory name to 20260911000000_system_config, add group and nonnegative revision CHECKs, then apply using the required migrate-dev command. Never edit an applied migration.",
    "The group/key composite index supplies the group prefix required by the card and matches docs/database.md. updatedBy has its own index and SetNull/Cascade foreign key.",
    "Safe account projections are server-only field allowlists. Email remains limited to authorized account contexts. Admin route authorization and GET-to-PATCH workflows remain Phase012 work.",
    "Use a labeled task-owned PostgreSQL 17 tmpfs container, loopback-only port, bridge without masquerading, random synthetic credentials and per-database run marker. Store credentials only in ignored .scaffold.",
    "Only the explicitly injected PHASE007_DATABASE_URL enables integration tests. The Gate injects it and requires all selected assertions to execute; ordinary unit runs do not consult developer credentials.",
    "Repair the Phase006 test cleanup by deleting only its recorded user IDs. Its User schema assertions remain exact while allowing the newly authorized SystemConfig table; run the affected real-database regression.",
    "Keep the eight card cases fixed. Schema, concurrent cleanup, source scans, mutation failures, command evidence and independent review are all required within those cases and mandatory supporting checks.",
  ],
  previousAttempts: [],
  notApplicable: ["Configuration key-specific schemas, write services, CAS/audit and public APIs are produced in Phase014; authenticated admin GET/PATCH is produced in Phase012.", "No production traffic, real user data, seed data, UI or new Prompt/model/provider tables are created."],
  costAccounting: {
    productImplementation: { durationMs: null, measurementStatus: "UNMEASURED" },
    infrastructure: { durationMs: null, measurementStatus: "UNMEASURED" },
    verification: "Actual per-command durationMs in reports",
    independentReview: { durationMs: null, measurementStatus: "UNMEASURED" },
    evidencePreparation: { durationMs: null, measurementStatus: "UNMEASURED" },
    productionRequests: 0, realProviderRequests: 0,
  },
};
const receipt = {
  layoutVersion: 2, phase: 7, repositoryRoot: ".", projectRoot: ".", roadmapRoot: state.roadmapRoot,
  baselineCommit: state.baselineCommit, executionBaselineCommit: state.executionBaselineCommit,
  phaseStartCommit: preflight.head, manifestHash: state.manifestHash, requestedThrough: 7,
  pinnedInputPolicy: "LOCAL_FILES_WITH_RECORDED_SHA256", checkpointMigration: state.checkpointMigration,
  pinnedInputs: previous.pinnedInputs,
  prerequisites: {
    ...checkpoint, metadataCommit: preflight.head,
    schemaPath: "prisma/schema.prisma", schemaHash: hash("prisma/schema.prisma"),
    migrationPath: "prisma/migrations/20260910000000_init_user/migration.sql",
    migrationHash: hash("prisma/migrations/20260910000000_init_user/migration.sql"),
  },
  preflight: { ...preflight, reportPath: preflightPath, reportHash: hash(preflightPath), completedThrough: 6, currentPhase: 7 },
};
write(receiptPath, receipt);
write(planPath, plan);
write(`docs/evidence/attempts/Phase007/${attemptId}/frozen-plan.json`, plan);
console.log(JSON.stringify({ status: "FROZEN", phase: 7, attemptId, cases: plan.cases.length, planHash: hash(planPath), phaseStartCommit: preflight.head }));
