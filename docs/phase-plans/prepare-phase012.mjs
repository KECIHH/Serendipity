import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const root = process.cwd();
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
  fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
};
const state = json("docs/roadmap-run.json");
const previous = json("docs/phase-plans/Phase011-inputs.json");
const preflightPath = "docs/evidence/attempts/Phase012/setup/preflight.json";
const preflight = json(preflightPath);
assert.equal(state.currentPhase, 12);
assert.equal(state.completedThrough, 11);
assert.equal(state.executionMode, "NEW_BUILD");
assert.equal(state.operatorMode, "AGENT_ONLY_AUTOMATED_NEW_BUILD");
assert.equal(preflight.phase, 12);
assert.equal(preflight.workingTree, "");
assert.equal(git("rev-parse", "HEAD"), preflight.head);
assert.equal(git("rev-parse", "origin/main"), preflight.head);
assert.equal(preflight.remoteHead, preflight.head);
assert.equal(git("branch", "--show-current"), "main");
assert.equal(git("remote", "get-url", "origin"), "https://github.com/KECIHH/Serendipity.git");
assert.equal(git("remote", "get-url", "--push", "origin"), "https://github.com/KECIHH/Serendipity.git");
assert.equal(git("rev-list", "--left-right", "--count", "HEAD...origin/main"), "0\t0");
const commands = {
  "Windows PowerShell 5.1": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/validate-phase.ps1 -CompletedThrough 11 -Strict -Json",
  "PowerShell 7": "pwsh -NoProfile -File scripts/validate-phase.ps1 -CompletedThrough 11 -Strict -Json",
};
assert.deepEqual(preflight.shells.map(item => item.shell).sort(), Object.keys(commands).sort());
for (const item of preflight.shells) {
  assert.equal(item.command, commands[item.shell]);
  assert.equal(item.exitCode, 0);
  assert.equal(item.result.status, "PASS");
  assert.equal(item.result.completedThrough, 11);
  assert.equal(item.result.currentPhase, 12);
  assert.equal(item.result.metadataCommit, preflight.head);
  assert.equal(item.result.artifactCommit, state.currentLayoutPhaseSeal.artifactCommit);
}
assert.equal(git("status", "--porcelain=v1", "--untracked-files=all", "--",
  ":(exclude)docs/evidence/attempts/Phase012/setup/preflight.json",
  ":(exclude)docs/phase-plans/prepare-phase012.mjs"), "");
for (const input of previous.pinnedInputs) assert.equal(hash(input.path), input.sha256);
for (const phase of [5, 6, 7, 9, 10, 11]) {
  const checkpoint = state.checkpoints.find(item => item.phase === phase);
  assert.equal(hash(checkpoint.evidencePath), checkpoint.evidenceHash);
  assert.equal(json(checkpoint.evidencePath).status, "PASS");
}
assert.equal(git("rev-parse", preflight.head + "^"), state.currentLayoutPhaseSeal.artifactCommit);
const gate = json(state.currentLayoutPhaseSeal.evidencePath);
assert.equal(hash("prisma/schema.prisma"), gate.details.schemaHash);
const migrations = git("ls-files", "prisma/migrations").split(/\r?\n/).filter(file => file.endsWith("migration.sql")).sort();
assert.equal(migrations.length, 6);

const planPath = "docs/phase-plans/Phase012.json";
const receiptPath = "docs/phase-plans/Phase012-inputs.json";
const generationPath = "docs/evidence/attempts/Phase012/setup/migration-generation.json";
const newFiles = [
  planPath, receiptPath, "docs/phase012.md",
  "docs/phase-plans/prepare-phase012.mjs", "docs/phase-plans/setup-phase012.mjs",
  "docs/phase-plans/phase012-runtime.mjs", "docs/phase-plans/verify-phase012.mjs",
  "docs/phase-plans/phase012-evidence.mjs", "docs/phase-plans/complete-phase012.mjs",
  "docs/phase-plans/admin-command-protection.sql",
  "src/lib/admin-users.ts", "src/server/admin/users.ts", "src/server/admin/command-receipt.ts",
  "src/server/admin/user-cursor.ts", "src/app/api/admin/users/route.ts",
  "src/app/api/admin/users/[id]/route.ts", "src/app/admin/(public)/login/page.tsx",
  "src/app/admin/(protected)/layout.tsx", "src/app/admin/(protected)/page.tsx",
  "src/app/admin/(protected)/users/page.tsx", "src/components/admin/admin-nav.ts",
  "src/components/admin/users-client.tsx",
  "tests/admin/users.integration.test.ts", "tests/admin/layout.test.tsx",
  "tests/admin/users-client.test.tsx", "tests/phase012/admin-fixture.ts",
  "tests/phase012/admin-worker.ts", "tests/phase012/browser.mjs",
  "tests/phase012/cli-network.mjs", "tests/phase012/evidence-guards.mjs",
];
const changedFiles = [
  "docs/database.md", "docs/api.md", "docs/auth.md", "docs/admin.md",
  "docs/privacy-and-user-data.md", "README.md",
  "prisma/schema.prisma", "src/server/audit-log.ts", "src/server/services/audit-log-service.ts",
  "src/components/layout/admin-shell.tsx", "src/app/admin/layout.tsx",
  "src/app/layout.test.ts", "src/components/common/common-components.test.tsx",
  "tests/lib/auth-guards.test.ts", "tests/phase005/components-fixture.tsx", "tests/phase011/browser.mjs",
  "tests/phase006/database.integration.ts", "tests/phase007/config-fixture.ts",
  "tests/phase008/data-fixture.ts", "tests/phase009/audit-fixture.ts",
  "tests/phase010/seed-fixture.ts", "tests/phase010/api-key-fixture.ts", "tests/phase011/auth-fixture.ts",
  "tests/integration/config-models.test.ts", "tests/integration/audit-log.test.ts",
  "tests/integration/travel-record.test.ts", "tests/integration/chat-message.test.ts",
  "tests/integration/seed.test.ts", "tests/integration/api-key-schema.test.ts",
  "tests/integration/admin-login.test.ts", "tests/lib/audit-log.test.ts",
  "vitest.config.ts", "vitest.setup.ts", "tsconfig.json",
];
const moved = new Set(["src/app/admin/page.tsx", "src/app/admin/login/page.tsx"]);
const sourcePaths = [...new Set([
  ...git("ls-files", "src", "tests", "prisma").split(/\r?\n/).filter(file => !moved.has(file)),
  ...newFiles, ...changedFiles, generationPath, "docs/agent-execution-contract.md",
  "docs/project-layout.json", "docs/runtime-baseline.json", "docs/env-registry.json",
  "scripts/check-project-layout.mjs", "scripts/validate-phase.mjs", "scripts/validate-phase.ps1",
  "scripts/phase-evidence.mjs", "scripts/test-validate-phase.mjs", "scripts/checkpoint-history.mjs",
  "scripts/test-phase-input-paths.mjs", "scripts/verify-phase003.mjs", "scripts/phase003-evidence.mjs",
  "scripts/generate-api-contract.mjs", "scripts/auth-server.mjs",
  "vitest/stubs/server-only.ts", "package.json", "package-lock.json",
  ".gitattributes", ".gitignore", ".env.example", "eslint.config.mjs", "scripts/eslint-env.mjs",
])].filter(Boolean).sort();
const specs = [
  ["list", "Real guarded GET selects only ADMIN_USER_FIELDS and returns exactly id/email/name/avatarUrl/role/status/lastLoginAt/createdAt/revision. Strict role/status/limit/cursor validation, default20/max100, signed opaque cursor bound to actor/filter/sort/read watermark, stable createdAt DESC/id DESC keyset pagination with equal timestamps and no skipped/duplicate records. Tampered, cross-filter/owner and unknown inputs fail safely; empty and unavailable database remain distinct. Query observations prove no passwordHash/sessionVersion/phone or full User retrieval in management projection."],
  ["role-status", "Construct PATCH from the real GET DTO and validate exact URL-id/body/Idempotency-Key schema. In a real Serializable transaction lock target and ACTIVE ADMIN set, reauthorize actor, compare revision before noop. Actual role/status change increments revision and sessionVersion exactly1, revokes every ACTIVE AuthSession at database time and writes exactly one USER_UPDATE audit with safe old/new values and redacted reason. Update/receipt/audit commit atomically; audit or receipt failure rolls everything back. Two clients using one revision yield one success and one409 with the latest identical safe DTO. Same-value with matching CAS returns the DTO without increments/audit; stale CAS still conflicts; lastLoginAt alone never creates a revision conflict. Isolated removal of sessionVersion increment must fail the original delta assertion with a nonzero process result; restored implementation and full original group pass."],
  ["self-protection", "Real authorized requests attempting to change actor role/status return403 FORBIDDEN, with zero changes in User/AuthSession/AdminCommandReceipt/AuditLog. Noop is allowed only after matching CAS. UI disabled controls are never the security boundary."],
  ["last-admin", "Single ACTIVE ADMIN cannot be demoted or disabled, and two distinct authenticated administrators concurrently disabling/demoting the last two cannot strand the installation. Record deterministic concurrency schedule and after-commit ACTIVE ADMIN count>=1. Locks, in-transaction recheck and authorization are real PostgreSQL operations with bounded serialization retries; rejected operations leave zero partial business writes/audits/receipts. Unknown role/status enums are rejected at server and database boundaries."],
  ["session", "Role/status changes invalidate target old cookies on the very next real protected request by both sessionVersion and terminal AuthSession state; all active sessions are revoked with revokedAt while previous terminal rows remain immutable. Noop/replay does not increment versions or revoke other sessions. Stale, disabled and expired principals never reach protected operations; revalidation inside the write transaction closes concurrent actor revocation races."],
  ["authorization-idempotency", "Missing login, USER, DISABLED ADMIN, stale/revoked session, missing/bad CSRF and cross-site Origin cause no protected writes and no resource existence leak. Same domain/key/payload persists one immutable original safe DTO across fresh service and separate process restarts, and concurrent identical requests yield one business update/audit. Same key with different validated payload returns409 and zero additional writes. Generate exactly one additive admin_commands migration for exact AdminCommandReceipt and KeyRotationRun fields/FKs/indexes: terminal response/identity immutable, active rows cannot TTL-delete, terminals retained>=24h and rotation FK retention. Verified fields only enter requestHash; no secret payloads in ledger. Real persisted PREPARING checkpoint/claim supports restart and fencing, rejects stale owner/token updates, and partial rotation preparation failure rolls back candidate+run+receipt without changing old key. No Phase013 key-management endpoint or Phase016 worker/governance model is implemented."],
  ["navigation", "Use only the existing src/components/layout/admin-shell.tsx and a single src/components/admin/admin-nav.ts array containing reachable /admin/users and logout. Static link checker proves every href has a page; longest segment-boundary active match prevents false prefixes. Neutral root admin layout and public login contain no shell; protected /admin redirects deterministically to /admin/users. Real Playwright login, list, filtering, pagination, edit/save, stale409 requiring reselection, logout,375px/desktop, keyboard/focus/collapse and axe checks execute against the isolated database. Same normalized pending/retry request reuses its key; failure retains form intent, sensitive fields never render, no dead future routes or second shell."],
];
const attemptId = "attempt-1";
const plan = {
  phase: 12, attemptId, producer: "Phase012", consumers: [13, 14, 16, 89],
  scope: "PROTECTED_ADMIN_SHELL_AND_CONCURRENCY_SAFE_USER_ADMINISTRATION",
  implementationContextId: "codex:/root:Phase012:20260912", sourcePaths,
  requiredCaseIds: specs.map(([key]) => "Phase012:" + key),
  cases: specs.map(([key, expected]) => ({
    testCaseId: "Phase012:" + key, command: "node docs/phase-plans/verify-phase012.mjs --case " + key,
    denominator: 1, inputPath: key === "navigation" ? "tests/phase012/browser.mjs" : "tests/admin/users.integration.test.ts",
    outputPath: "docs/evidence/attempts/Phase012/" + attemptId + "/" + key + ".json", expected,
  })),
  modificationScope: [...new Set([...newFiles, ...changedFiles, ...moved,
    "src/server/admin/", "src/components/admin/", "src/app/admin/", "src/app/api/admin/users/",
    "tests/admin/", "tests/phase012/", "docs/phase-plans/", "prisma/migrations/",
    "docs/evidence/attempts/Phase012/"])],
  threshold: { originalThreshold: 7, automatedThreshold: 7, requiredPassRate: 1, waived: false },
  supportingChecks: ["lint", "typecheck", "admin-users-layout", "test", "format-check", "build",
    "project-layout", "phase003-regression", "phase006-user-regression", "phase007-config-regression",
    "phase008-data-regression", "phase009-audit-regression", "phase010-seed-regression", "phase011-auth-regression",
    "migration-schema", "api-contract", "evidence-binding", "dependency-versions",
    "prisma-cli-network-isolation", "secret-and-scope-scan", "validator-regression", "phase012-evidence-guards"],
  migrationPolicy: { name: "admin_commands", generatedPathPattern: "prisma/migrations/[0-9]{14}_admin_commands/migration.sql",
    generationReceiptPath: generationPath, preserveGeneratedTimestamp: true, applyOnlyAfterChecks: true },
  decisions: [
    "Only Phase012 is authorized. Candidate currentPhase=13/completedThrough=12 does not authorize execution of Phase013.",
    "Use root repository layout and preserve every local frozen input hash and all Phase000-011 history/checkpoint bytes. The synchronized Phase011 metadata is phaseStartCommit; original run baselines remain unchanged.",
    "Use the existing unique AdminShell and Auth.js handler. Public login moves under a public route group; no future management placeholders or preview bypass.",
    "User list/edit API exposes the nine-field ADMIN_USER_FIELDS projection, with ISO timestamps and {items,nextCursor}. Pagination shows current page/item count, not an invented total absent from keyset response.",
    "Replay is checked after current authorization but before original CAS. Fresh requests compare CAS before noop; failed CAS/self/last-admin transactions roll back the receipt too. Successful noop persists only its safe receipt, without a fabricated change audit.",
    "Receipt replay metadata is conveyed without adding fields to the exact AdminUser response. Raw key/reason secrets/session values never enter ledger or evidence.",
    "Use task-owned PostgreSQL17 tmpfs, network masquerading disabled, loopback publish, explicit marker and separate migration/runtime roles. Use public.auth_now() for deterministic session and receipt time.",
    "Create only Phase012 ledger/checkpoint infrastructure; empty candidate tags until future adapters exist. No real provider calls, Phase013 key actions, or Phase016 task tables.",
    "Keep all upstream assertions; adapt only explicit new schema inventories/disposable namespace/current admin routing in current-source regressions. Historical gates and historical report bytes remain immutable.",
    "Run mutations in isolated copies; the real sessionVersion increment delta assertion must turn red even if independent AuthSession revocation also denies the cookie.",
  ],
  previousAttempts: [],
  notApplicable: ["Production traffic, real identities, external provider operations, public deployment, Phase013 key-management UI/API, Phase014 dashboard, Phase015 governance and Phase016 worker are not evaluated. Human screen-reader experience is NOT_EVALUATED; browser accessibility is automated."],
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
  layoutVersion: 2, phase: 12, repositoryRoot: ".", projectRoot: ".", roadmapRoot: state.roadmapRoot,
  baselineCommit: state.baselineCommit, executionBaselineCommit: state.executionBaselineCommit,
  phaseStartCommit: preflight.head, manifestHash: state.manifestHash, requestedThrough: 12,
  pinnedInputPolicy: "LOCAL_FILES_WITH_RECORDED_SHA256", checkpointMigration: state.checkpointMigration,
  pinnedInputs: previous.pinnedInputs,
  prerequisites: { ...state.currentLayoutPhaseSeal, metadataCommit: preflight.head,
    schemaPath: "prisma/schema.prisma", schemaHash: hash("prisma/schema.prisma"),
    migrationPath: migrations.at(-1), migrationHash: hash(migrations.at(-1)),
    migrations: migrations.map(file => ({ path: file, sha256: hash(file) })),
  },
  preflight: { ...preflight, originMain: preflight.head, branch: "main", remote: "https://github.com/KECIHH/Serendipity.git",
    ahead: 0, behind: 0, reportPath: preflightPath, reportHash: hash(preflightPath), completedThrough: 11, currentPhase: 12 },
};
write(receiptPath, receipt);
write(planPath, plan);
write("docs/evidence/attempts/Phase012/" + attemptId + "/frozen-plan.json", plan);
console.warn(JSON.stringify({ status: "FROZEN", phase: 12, attemptId, cases: 7, planHash: hash(planPath) }));
