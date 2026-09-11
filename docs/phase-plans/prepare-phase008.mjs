import assert from "node:assert/strict";
import { requirePhase008Preflight } from "./phase008-evidence.mjs";
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
const planPath = "docs/phase-plans/Phase008.json";
const receiptPath = "docs/phase-plans/Phase008-inputs.json";
const preflightPath = "docs/evidence/attempts/Phase008/setup/preflight.json";
const state = json("docs/roadmap-run.json");
const previous = json("docs/phase-plans/Phase007-inputs.json");
const preflight = json(preflightPath);
requirePhase008Preflight(preflight);
assert.equal(state.executionMode, "NEW_BUILD");
assert.equal(state.operatorMode, "AGENT_ONLY_AUTOMATED_NEW_BUILD");
assert.equal(state.currentPhase, 8);
assert.equal(state.completedThrough, 7);
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
  assert.equal(shell.result.completedThrough, 7);
  assert.equal(shell.result.metadataCommit, preflight.head);
}
assert.equal(git("config", "--get", "remote.origin.url"), preflight.remote);
assert.equal(git("status", "--porcelain=v1", "--untracked-files=all", "--", ":(exclude)docs/phase-plans/prepare-phase008.mjs", ":(exclude)docs/evidence/attempts/Phase008/setup/preflight.json"), "");
for (const input of previous.pinnedInputs) assert.equal(hash(input.path), input.sha256, `Pinned input changed: ${input.path}`);
const checkpoint = state.currentLayoutPhaseSeal;
assert.equal(checkpoint.phase, 7);
assert.equal(hash(checkpoint.evidencePath), checkpoint.evidenceHash);
assert.equal(json(checkpoint.evidencePath).artifactCommit, checkpoint.artifactCommit);
assert.equal(git("rev-parse", `${preflight.head}^`), checkpoint.artifactCommit);
assert(!/model (?:TravelRecord|ChatMessage)\b/.test(read("prisma/schema.prisma").toString()));
const previousMigrations = git("ls-files", "prisma/migrations").split(/\r?\n/).filter((file) => file.endsWith("migration.sql"));
assert.equal(previousMigrations.length, 2);

const newFiles = [
  "docs/phase-plans/prepare-phase008.mjs", "docs/phase-plans/phase008-runtime.mjs",
  "docs/phase-plans/setup-phase008.mjs", "docs/phase-plans/verify-phase008.mjs", "docs/phase-plans/phase008-evidence.mjs",
  "docs/phase-plans/complete-phase008.mjs", planPath, receiptPath, "docs/phase008.md",
  "src/server/anonymous-owner.ts", "src/server/repositories/data-layer-error.ts",
  "src/server/repositories/travel-record.ts", "src/server/repositories/chat-message.ts",
  "tests/lib/travel-record.test.ts", "tests/lib/chat-message.test.ts",
  "tests/integration/travel-record.test.ts", "tests/integration/chat-message.test.ts",
  "tests/phase008/data-fixture.ts", "tests/phase008/data-types.ts", "tests/phase008/cli-network.mjs", "tests/phase008/evidence-guards.mjs",
];
const generationPath = "docs/evidence/attempts/Phase008/setup/migration-generation.json";
const sourcePaths = [...new Set([
  ...json("docs/phase-plans/Phase007.json").sourcePaths,
  "docs/database.md", "docs/api.md", "docs/privacy-and-user-data.md", "docs/travel-plan-schema.md",
  "scripts/phase-evidence.mjs", "scripts/validate-phase.mjs", "scripts/validate-phase.ps1",
  "scripts/test-validate-phase.mjs", "scripts/test-phase-input-paths.mjs",
  ...newFiles, generationPath, "prisma/.gitkeep",
])].sort();
const specs = [
  ["ownership", "tests/integration/travel-record.test.ts", "Anonymous hash-only and authenticated user-only owners succeed. Ownerless and dual-owned rows fail the real database XOR CHECK. Typed server helpers require exactly one trusted owner, deny wrong/missing owners, and atomically transfer ownership in a database transaction without exposing a merge API."],
  ["lifecycle-version", "tests/integration/travel-record.test.ts", "One real Prisma-generated additive migration preserves both previous migrations and their data, has no drift, and passes migrate status/generate. Exact scalar fields, three required new enum types, seven TravelStatus values, indexes, nullability, timestamps, defaults and version >= 0 match the contract. Unproduced JSON validators fail closed and no future model, pointer or cached plan field exists."],
  ["hash", "tests/lib/travel-record.test.ts", "Only a server utility hashes verified 256-bit Cookie material to lowercase SHA-256; raw values never persist or enter reports. Malformed hashes fail the database CHECK; application owner inputs reject invalid, ambiguous and raw-token-shaped alternatives with safe errors."],
  ["ordered-messages", "tests/integration/chat-message.test.ts", "Explicit positive sequence is unique per record under concurrent writes. Same-millisecond messages read by sequence with a record/sequence/id cursor whose anchor and ownership are checked; pagination has no skips or duplicates. Long PostgreSQL text succeeds; errors never become empty lists; no sequence allocation service exists."],
  ["client-idempotency", "tests/integration/chat-message.test.ts", "Non-null clientMessageId is unique per record while null and cross-record IDs may repeat. Concurrent identical payload retries replay the original message; a different payload conflicts with zero extra writes. Server scheduling fields are not client payload, and failed transactions have no partial writes."],
  ["reply-relation", "tests/integration/chat-message.test.ts", "The self foreign key rejects nonexistent targets, repository transactions reject cross-record targets, and valid replies are queryable. Rejection leaves no message or unrelated write; ownership and reply checks occur in the same locked record transaction."],
  ["delete-policy", "tests/integration/chat-message.test.ts", "Deleting an owner User is Restrict, exact fixture record purge cascades its messages, and deleting a reply target sets replyToMessageId to null. The business repository exposes no individual message delete. Concurrent fixture cleanup preserves every other fixture's recorded IDs."],
  ["mutation", "tests/integration/chat-message.test.ts", "Separate disposable SQL copies remove owner XOR CHECK, sequence uniqueness and client-message uniqueness. Each original targeted negative assertion must fail for the intended reason with a nonzero Vitest exit. Restored migrations and all eight card groups pass; no mutation touches the main schema or applied migration."],
];
const attemptId = "attempt-1";
const plan = {
  phase: 8, attemptId, producer: "Phase008", consumers: [16, 17, 25, 49, 51, 52, 82, 84],
  scope: "TRAVEL_RECORD_OWNERSHIP_AND_ORDERED_CHAT_MESSAGE_DATA_LAYER",
  implementationContextId: "codex:/root:Phase008:20260911", sourcePaths,
  requiredCaseIds: specs.map(([key]) => `Phase008:${key}`),
  cases: specs.map(([key, inputPath, expected]) => ({
    testCaseId: `Phase008:${key}`, command: `node docs/phase-plans/verify-phase008.mjs --case ${key}`,
    denominator: 1, inputPath, outputPath: `docs/evidence/attempts/Phase008/${attemptId}/${key}.json`, expected,
  })),
  modificationScope: [...newFiles, "prisma/schema.prisma", "prisma/migrations/", "docs/database.md", "docs/travel-plan-schema.md", "tests/integration/config-models.test.ts", "tests/phase006/database.integration.ts", "docs/evidence/attempts/Phase008/"],
  threshold: { originalThreshold: 8, automatedThreshold: 8, requiredPassRate: 1, waived: false },
  supportingChecks: ["lint", "typecheck", "test", "format-check", "build", "project-layout", "phase003-regression", "phase006-user-regression", "phase007-config-regression", "evidence-binding", "dependency-versions", "prisma-cli-network-isolation", "secret-and-scope-scan", "validator-regression"],
  migrationPolicy: { name: "travel_record_chat_message", generatedPathPattern: "prisma/migrations/[0-9]{14}_travel_record_chat_message/migration.sql", generationReceiptPath: generationPath, preserveGeneratedTimestamp: true, applyOnlyAfterChecks: true, sourceBinding: "The immutable generation receipt binds both raw generated SQL and final CHECK-enhanced SQL hashes. Every case report binds that receipt plus the actual migration artifact, and the final Gate includes the migration blob." },
  decisions: [
    "User authorization is limited to Phase008. Preserve the root layout, historical evidence and ignored local roadmap inputs; the next admission state does not authorize Phase009.",
    "Retain the three explicit enum field contracts TravelStatus, MessageRole and ChatMessageKind; the card's generic count of two enums is a counting typo and does not remove a required field type.",
    "Use the already pinned runtime, dependencies and PostgreSQL 17 image. One additive migration creates only TravelRecord, ChatMessage and their enum/index/check/foreign-key structure, preserving the actual Prisma-generated timestamp.",
    "Use stable test files as frozen case inputs. Bind the as-yet-unknown generated migration path through an immutable generation receipt rather than guessing a timestamp or changing a frozen case input.",
    "Owner is a userId-or-branded-anonTokenHash XOR union validated at runtime; the server hash helper consumes Cookie material only. Request authentication and cookie issuance/signature verification remain their registered later producers.",
    "The Phase017 requirement/content validators do not yet exist. Repository writes accept only absent/null JSON and reject every non-null requirementJson or structured content before SQL. Database JSON columns remain nullable; direct schema tests are synthetic. No permissive callback or claimed validation marker substitutes for the future real Schema.",
    "Message writes accept an explicitly supplied positive sequence and lock the owned record within the transaction for reply/idempotency consistency. Phase016 owns sequence allocation and the command ledger; this card does not implement either.",
    "Identical retry payload comparison covers role/kind/content/contentJson/reply target. It excludes server-assigned id, createdAt and sequence so a retry replays the persisted message. A payload mismatch fails with a safe conflict without creating a parallel command ledger.",
    "Repository cursors bind record, sequence and message id and verify the persisted anchor and current owner. HTTP signature/filter/watermark envelopes are produced with the later conversation API, not an unsigned public endpoint in this card.",
    "Extend only the existing Phase006/007 test database guards and schema expectations needed for the new authorized tables/migration. Preserve exact prior model fields and prior migration hashes and run the full affected real-database regression.",
    "All tests use labeled task-owned loopback-only PostgreSQL tmpfs with synthetic credentials in ignored .scaffold. Each fixture cleans only its recorded IDs. SQL mutations run in independent database copies and never modify applied main migrations.",
  ],
  previousAttempts: [],
  notApplicable: ["Runtime state transition services, command/event ledger and sequence allocator remain later producers; seven enum roundtrips do not claim a completed state machine.", "No AI/Prompt/model/provider table, API, UI, plan body or version pointer is produced. Phase017 supplies real JSON validation; Phase025 supplies plan versions and requirementRevision.", "No real users, production traffic or external provider calls were exercised."],
  costAccounting: { productImplementation: { durationMs: null, measurementStatus: "UNMEASURED" }, infrastructure: { durationMs: null, measurementStatus: "UNMEASURED" }, verification: "Actual per-command durationMs in reports", independentReview: { durationMs: null, measurementStatus: "UNMEASURED" }, evidencePreparation: { durationMs: null, measurementStatus: "UNMEASURED" }, productionRequests: 0, realProviderRequests: 0 },
};
const receipt = {
  layoutVersion: 2, phase: 8, repositoryRoot: ".", projectRoot: ".", roadmapRoot: state.roadmapRoot,
  baselineCommit: state.baselineCommit, executionBaselineCommit: state.executionBaselineCommit,
  phaseStartCommit: preflight.head, manifestHash: state.manifestHash, requestedThrough: 8,
  pinnedInputPolicy: "LOCAL_FILES_WITH_RECORDED_SHA256", checkpointMigration: state.checkpointMigration,
  pinnedInputs: previous.pinnedInputs,
  prerequisites: { ...checkpoint, metadataCommit: preflight.head, schemaPath: "prisma/schema.prisma", schemaHash: hash("prisma/schema.prisma"), migrationPath: previousMigrations.at(-1), migrationHash: hash(previousMigrations.at(-1)), migrations: previousMigrations.map((file) => ({ path: file, sha256: hash(file) })) },
  preflight: { ...preflight, reportPath: preflightPath, reportHash: hash(preflightPath), completedThrough: 7, currentPhase: 8 },
};
write(receiptPath, receipt);
write(planPath, plan);
write(`docs/evidence/attempts/Phase008/${attemptId}/frozen-plan.json`, plan);
console.log(JSON.stringify({ status: "FROZEN", phase: 8, attemptId, cases: plan.cases.length, planHash: hash(planPath), phaseStartCommit: preflight.head }));
