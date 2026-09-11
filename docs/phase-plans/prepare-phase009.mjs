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
const planPath = "docs/phase-plans/Phase009.json";
const receiptPath = "docs/phase-plans/Phase009-inputs.json";
const preflightPath = "docs/evidence/attempts/Phase009/setup/preflight.json";
const state = json("docs/roadmap-run.json");
const previous = json("docs/phase-plans/Phase008-inputs.json");
const preflight = json(preflightPath);
assert.equal(preflight.phase, 9);
assert.equal(state.executionMode, "NEW_BUILD");
assert.equal(state.operatorMode, "AGENT_ONLY_AUTOMATED_NEW_BUILD");
assert.equal(state.currentPhase, 9);
assert.equal(state.completedThrough, 8);
assert.equal(git("rev-parse", "HEAD"), preflight.head);
assert.equal(git("rev-parse", "origin/main"), preflight.head);
assert.equal(git("branch", "--show-current"), "main");
assert.equal(preflight.workingTree, "");
assert.equal(preflight.ahead, 0);
assert.equal(preflight.behind, 0);
assert.deepEqual(preflight.shells.map((shell) => shell.shell).sort(), ["PowerShell7", "WindowsPowerShell51"]);
for (const shell of preflight.shells) {
  assert.equal(shell.exitCode, 0);
  assert.equal(shell.result.status, "PASS");
  assert.equal(shell.result.completedThrough, 8);
  assert.equal(shell.result.currentPhase, 9);
  assert.equal(shell.result.metadataCommit, preflight.head);
}
assert.equal(git("config", "--get", "remote.origin.url"), preflight.remote);
assert.equal(git("status", "--porcelain=v1", "--untracked-files=all", "--", ":(exclude)docs/phase-plans/prepare-phase009.mjs", ":(exclude)docs/evidence/attempts/Phase009/setup/preflight.json"), "");
for (const input of previous.pinnedInputs) assert.equal(hash(input.path), input.sha256, `Pinned input changed: ${input.path}`);
const checkpoint = state.currentLayoutPhaseSeal;
assert.equal(checkpoint.phase, 8);
assert.equal(hash(checkpoint.evidencePath), checkpoint.evidenceHash);
assert.equal(json(checkpoint.evidencePath).artifactCommit, checkpoint.artifactCommit);
assert.equal(git("rev-parse", `${preflight.head}^`), checkpoint.artifactCommit);
assert.equal(hash("prisma/schema.prisma"), json(checkpoint.evidencePath).details.schemaHash);
assert(!/model AuditLog\b/.test(read("prisma/schema.prisma").toString()));
const previousMigrations = git("ls-files", "prisma/migrations").split(/\r?\n/).filter((file) => file.endsWith("migration.sql"));
assert.equal(previousMigrations.length, 3);
assert(previousMigrations.every((file) => !file.includes("audit_log")));
for (const phase of [6, 7, 8]) {
  const old = state.checkpoints.find((entry) => entry.phase === phase);
  assert(old);
  assert.equal(hash(old.evidencePath), old.evidenceHash);
  assert.equal(json(old.evidencePath).status, "PASS");
}

const newFiles = [
  "docs/phase-plans/prepare-phase009.mjs", "docs/phase-plans/phase009-runtime.mjs",
  "docs/phase-plans/setup-phase009.mjs", "docs/phase-plans/verify-phase009.mjs",
  "docs/phase-plans/phase009-evidence.mjs", "docs/phase-plans/complete-phase009.mjs",
  "docs/phase-plans/audit-log-protection.sql", planPath, receiptPath, "docs/phase009.md",
  "src/server/services/audit-log-service.ts", "src/server/audit-log.ts",
  "tests/lib/audit-log.test.ts", "tests/integration/audit-log.test.ts",
  "tests/phase009/audit-fixture.ts", "tests/phase009/audit-types.ts",
  "tests/phase009/cli-network.mjs", "tests/phase009/evidence-guards.mjs",
];
const generationPath = "docs/evidence/attempts/Phase009/setup/migration-generation.json";
const sourcePaths = [...new Set([
  ...json("docs/phase-plans/Phase008.json").sourcePaths,
  ...git("ls-files", "src", "tests", "prisma").split(/\r?\n/),
  ...previousMigrations, ...newFiles, generationPath,
])].sort();
const specs = [
  ["schema", "tests/integration/audit-log.test.ts", "One Prisma-generated additive migration creates exactly AuditLog, its optional actor relation, five specified indexes, bounded columns/CHECKs and append-only protection. All existing scalar schemas and migration bytes/data remain unchanged, replay/status/generate and drift checks pass."],
  ["append-only", "tests/integration/audit-log.test.ts", "The non-owner, non-superuser runtime role can INSERT/SELECT but cannot UPDATE/DELETE/TRUNCATE, disable/drop triggers or escalate privileges. Protection also rejects mutations after accidental DML grants. Only the actual User FK deletion can null actorId, preserving every other audit field and its email snapshot."],
  ["recursive-redaction", "tests/lib/audit-log.test.ts", "Objects/arrays recursively redact all denylisted camel/snake/kebab and mixed-case keys. Unknown free text cannot enter a structured audit summary. Input is immutable, exceptions expose no values, raw synthetic secrets have zero matches in persisted rows, captured output and archived evidence. IP uses a server HMAC; UA controls are removed."],
  ["transaction", "tests/integration/audit-log.test.ts", "The helper accepts only an interactive Prisma transaction, rejects the global client at compile time and runtime, and returns only id/action/createdAt. Business+audit success counts match; audit DB failure, invalid metadata and business failure roll back both. Concurrent successes remain paired and errors never become best-effort success."],
  ["system-actor", "tests/integration/audit-log.test.ts", "USER and SYSTEM discriminated actors persist correctly; SYSTEM has null actorId/email, a closed systemActor detail value and nullable targetId. Invalid/ambiguous/spoofed actors, registry actions and target combinations fail before insertion."],
  ["lookup", "tests/integration/audit-log.test.ts", "Request/trace IDs originate in an opaque server-generated context and satisfy fixed UUID formats. Exact request, trace, target, actor and action lookups return the expected rows; all five indexes exist and EXPLAIN proves the intended access paths. Empty queries and real DB failure remain distinguishable."],
  ["bounded-metadata", "tests/lib/audit-log.test.ts", "Fixed action/target/ID/email/UA limits and detail depth/node/UTF-8 byte budgets reject excess or non-JSON inputs before insertion. Cycles, accessors, prototypes, sparse arrays and forged contexts cannot bypass validation; a 257-character UA normalizes to 256 without splitting Unicode."],
  ["mutation", "tests/integration/audit-log.test.ts", "An isolated database copy with append-only triggers removed and an isolated source copy with recursive redaction removed must make the original targeted assertions red with actual nonzero exits. Restored copies and the complete eight-group audit suite pass; product and applied migration bytes remain unchanged."],
];
const attemptId = "attempt-1";
const plan = {
  phase: 9, attemptId, producer: "Phase009", consumers: [10, 11, 12, 13, 14, 15, 16, 84, 97, 123],
  scope: "APPEND_ONLY_AUDIT_LOG_AND_SAME_TRANSACTION_BOUNDARY",
  implementationContextId: "codex:/root:Phase009:20260911", sourcePaths,
  requiredCaseIds: specs.map(([key]) => `Phase009:${key}`),
  cases: specs.map(([key, inputPath, expected]) => ({ testCaseId: `Phase009:${key}`, command: `node docs/phase-plans/verify-phase009.mjs --case ${key}`, denominator: 1, inputPath, outputPath: `docs/evidence/attempts/Phase009/${attemptId}/${key}.json`, expected })),
  modificationScope: [...newFiles, "prisma/schema.prisma", "prisma/migrations/", "docs/database.md", "docs/privacy-and-user-data.md", "tests/integration/config-models.test.ts", "tests/phase006/database.integration.ts", "tests/phase008/data-fixture.ts", "docs/evidence/attempts/Phase009/"],
  threshold: { originalThreshold: 8, automatedThreshold: 8, requiredPassRate: 1, waived: false },
  supportingChecks: ["lint", "typecheck", "test", "format-check", "build", "project-layout", "phase003-regression", "phase006-user-regression", "phase007-config-regression", "phase008-data-regression", "evidence-binding", "dependency-versions", "prisma-cli-network-isolation", "secret-and-scope-scan", "validator-regression", "phase009-evidence-guards"],
  migrationPolicy: { name: "audit_log", generatedPathPattern: "prisma/migrations/[0-9]{14}_audit_log/migration.sql", generationReceiptPath: generationPath, preserveGeneratedTimestamp: true, applyOnlyAfterChecks: true },
  decisions: [
    "Only Phase009 is authorized. Root layout, ignored roadmap and historical checkpoints stay intact; admission to Phase010 is not execution authorization.",
    "The card's exact AuditLog field/index contract owns the implementation. Remove the older derived database document's extra actorType column/index suffixes; actor kind is the service input discriminant, not another User role or stored column.",
    "Register the three canonical example actions CONFIG_UPDATE, USER_DISABLE and API_KEY_ROTATE with their existing named target types. Future producers explicitly extend the closed registry; no future table, endpoint, UI or seed is created.",
    "The only mutation exception is PostgreSQL's actual nested FK action nulling a deleted actor reference. The trigger verifies nesting, vanished parent and equality of every other field. Maintenance/ERASE requires a future controlled role/procedure and is unavailable to the app now.",
    "Provide an opaque immutable server-minted request context, bounded UUID correlation, explicit HMAC-key injection and pure UA normalization. Never accept inbound request/trace IDs or raw addresses as audit columns.",
    "Audit detail is a bounded structured summary: recursively replace sensitive-key values with ***, and validate remaining keys and values against safe summary fields. Arbitrary free text, private payloads, cyclic or non-JSON structures fail closed.",
    "Use a Prisma TransactionClient type with forbidden global-client methods plus runtime rejection. Throw safe validation/persistence errors so the caller's transaction must roll back; no best-effort audit path or public mutation repository exists.",
    "Use a labeled loopback-only PostgreSQL17 tmpfs container with separate synthetic migration/runtime roles, no production credentials or provider calls. Mutation copies are independent databases/source fixtures. Audit rows persist for the lifetime of disposable test databases; no test cleanup grants a production deletion bypass.",
    "Extend only earlier database target guards/table inventory expectations required to run Phase006-008 regression against the additive Phase009 schema. Preserve original assertions, thresholds and migration bytes.",
  ],
  previousAttempts: [],
  notApplicable: ["Maintenance/retention/ERASE implementation, audit UI and configuration APIs belong to later producers.", "No production database, real users, real provider traffic or future Phase010 implementation is exercised."],
  costAccounting: { productImplementation: { durationMs: null, measurementStatus: "UNMEASURED" }, infrastructure: { durationMs: null, measurementStatus: "UNMEASURED" }, verification: "Actual per-command durationMs in reports", independentReview: { durationMs: null, measurementStatus: "UNMEASURED" }, evidencePreparation: { durationMs: null, measurementStatus: "UNMEASURED" }, productionRequests: 0, realProviderRequests: 0 },
};
const receipt = {
  layoutVersion: 2, phase: 9, repositoryRoot: ".", projectRoot: ".", roadmapRoot: state.roadmapRoot,
  baselineCommit: state.baselineCommit, executionBaselineCommit: state.executionBaselineCommit,
  phaseStartCommit: preflight.head, manifestHash: state.manifestHash, requestedThrough: 9,
  pinnedInputPolicy: "LOCAL_FILES_WITH_RECORDED_SHA256", checkpointMigration: state.checkpointMigration,
  pinnedInputs: previous.pinnedInputs,
  prerequisites: { ...checkpoint, metadataCommit: preflight.head, schemaPath: "prisma/schema.prisma", schemaHash: hash("prisma/schema.prisma"), migrationPath: previousMigrations.at(-1), migrationHash: hash(previousMigrations.at(-1)), migrations: previousMigrations.map((file) => ({ path: file, sha256: hash(file) })) },
  preflight: { ...preflight, reportPath: preflightPath, reportHash: hash(preflightPath), completedThrough: 8, currentPhase: 9 },
};
write(receiptPath, receipt);
write(planPath, plan);
write(`docs/evidence/attempts/Phase009/${attemptId}/frozen-plan.json`, plan);
console.log(JSON.stringify({ status: "FROZEN", phase: 9, attemptId, cases: plan.cases.length, planHash: hash(planPath), phaseStartCommit: preflight.head }));
