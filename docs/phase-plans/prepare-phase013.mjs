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
  const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const write = (file, value) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
};
const state = json("docs/roadmap-run.json");
const previous = json("docs/phase-plans/Phase012-inputs.json");
const preflightPath = "docs/evidence/attempts/Phase013/setup/preflight.json";
const preflight = json(preflightPath);
const maintenancePath = "docs/checkpoint-migrations/testing-policy-20260912.json";
const maintenance = json(maintenancePath);
const maintenanceCommit = "408f6ae5516069efcaa423cc61ea431e528bd040";
const previousMetadata = "3fa20a8dca445859d94db8dfa1232d16f8a6e07f";
assert.equal(state.currentPhase, 13);
assert.equal(state.completedThrough, 12);
assert.equal(state.executionMode, "NEW_BUILD");
assert.equal(state.operatorMode, "AGENT_ONLY_AUTOMATED_NEW_BUILD");
assert.equal(preflight.phase, 13);
assert.equal(preflight.workingTree, "");
assert.equal(preflight.head, maintenanceCommit);
for (const ref of ["HEAD", "origin/main"]) assert.equal(git("rev-parse", ref), preflight.head);
assert.equal(preflight.remoteHead, preflight.head);
assert.equal(git("branch", "--show-current"), "main");
assert.equal(git("remote", "get-url", "origin"), "https://github.com/KECIHH/Serendipity.git");
assert.equal(
  git("remote", "get-url", "--push", "origin"),
  "https://github.com/KECIHH/Serendipity.git",
);
assert.equal(git("rev-list", "--left-right", "--count", "HEAD...origin/main"), "0\t0");
assert.equal(maintenance.baseMetadataCommit, previousMetadata);
assert.equal(git("rev-parse", maintenanceCommit + "^"), previousMetadata);
assert.equal(git("rev-parse", previousMetadata + "^"), state.currentLayoutPhaseSeal.artifactCommit);
assert.equal(hash(maintenance.policy.path), maintenance.policy.sha256);
assert.equal(maintenance.policy.version, "phase-verification-v1");
assert(!read(maintenance.policy.path).includes(13), "The policy must use LF before hashing");
const maintenanceBinding = {
  path: maintenancePath,
  sha256: hash(maintenancePath),
  commit: maintenanceCommit,
};
const commands = {
  "Windows PowerShell 5.1":
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/validate-phase.ps1 -CompletedThrough 12 -Strict -Json",
  "PowerShell 7":
    "pwsh -NoProfile -File scripts/validate-phase.ps1 -CompletedThrough 12 -Strict -Json",
};
assert.deepEqual(preflight.shells.map((item) => item.shell).sort(), Object.keys(commands).sort());
for (const item of preflight.shells) {
  assert.equal(item.command, commands[item.shell]);
  assert.equal(item.exitCode, 0);
  assert.equal(item.result.status, "PASS");
  assert.equal(item.result.scope, "ROOT_LAYOUT_PHASE_CHECKPOINT_ADMISSION");
  assert.equal(item.result.completedThrough, 12);
  assert.equal(item.result.currentPhase, 13);
  assert.equal(item.result.metadataCommit, previousMetadata);
  assert.equal(item.result.maintenanceHead, maintenanceCommit);
  assert.equal(item.result.admissionOnly, true);
  assert.equal(item.result.artifactCommit, state.currentLayoutPhaseSeal.artifactCommit);
  assert.deepEqual(item.result.checkpointMaintenance, {
    ...maintenanceBinding,
    policy: maintenance.policy,
  });
}
assert.equal(preflight.remoteVerification.exitCode, 0);
assert.equal(preflight.remoteVerification.head, preflight.head);
assert.equal(
  git(
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ":(exclude)" + preflightPath,
    ":(exclude)docs/phase-plans/prepare-phase013.mjs",
  ),
  "",
);
for (const input of previous.pinnedInputs) assert.equal(hash(input.path), input.sha256);
for (const phase of [9, 10, 11, 12]) {
  const checkpoint = state.checkpoints.find((item) => item.phase === phase);
  assert.equal(hash(checkpoint.evidencePath), checkpoint.evidenceHash);
  assert.equal(json(checkpoint.evidencePath).status, "PASS");
}
assert.equal(
  hash("prisma/schema.prisma"),
  json(state.currentLayoutPhaseSeal.evidencePath).details.schemaHash,
);
const migrations = git("ls-files", "prisma/migrations")
  .split(/\r?\n/)
  .filter((file) => file.endsWith("migration.sql"))
  .sort();
assert.equal(migrations.length, 7);

const planPath = "docs/phase-plans/Phase013.json";
const receiptPath = "docs/phase-plans/Phase013-inputs.json";
const generationPath = "docs/evidence/attempts/Phase013/setup/migration-generation.json";
const newFiles = [
  planPath,
  receiptPath,
  "docs/phase013.md",
  "docs/phase-plans/prepare-phase013.mjs",
  "docs/phase-plans/setup-phase013.mjs",
  "docs/phase-plans/phase013-runtime.mjs",
  "docs/phase-plans/verify-phase013.mjs",
  "docs/phase-plans/phase013-evidence.mjs",
  "docs/phase-plans/complete-phase013.mjs",
  "docs/phase-plans/key-rotation-protection.sql",
  "src/server/security/secret-envelope.ts",
  "src/server/admin/api-keys.ts",
  "src/server/admin/api-key-cursor.ts",
  "src/server/admin/key-rotation.ts",
  "src/server/admin/key-reference.ts",
  "src/server/admin/key-candidate-client.ts",
  "src/server/projections/admin-api-key.ts",
  "src/server/admin/logs.ts",
  "src/server/admin/log-cursor.ts",
  "src/lib/admin-api-keys.ts",
  "src/lib/admin-logs.ts",
  "src/app/api/admin/api-keys/route.ts",
  "src/app/api/admin/api-keys/[id]/route.ts",
  "src/app/api/admin/api-keys/[id]/rotate/route.ts",
  "src/app/api/admin/logs/route.ts",
  "src/app/admin/(protected)/api-keys/page.tsx",
  "src/app/admin/(protected)/logs/page.tsx",
  "src/components/admin/api-keys-client.tsx",
  "src/components/admin/logs-client.tsx",
  "src/app/not-found.tsx",
  "src/app/error.tsx",
  "tests/admin/api-keys.integration.test.ts",
  "tests/admin/logs.test.ts",
  "tests/admin/api-keys-client.test.tsx",
  "tests/admin/logs-client.test.tsx",
  "tests/lib/admin-api-keys.test.ts",
  "tests/lib/secret-envelope.test.ts",
  "tests/integration/secret-envelope.test.ts",
  "tests/phase013/api-key-fixture.ts",
  "tests/phase013/api-key-worker.ts",
  "tests/phase013/logs-fixture.ts",
  "tests/phase013/browser.mjs",
  "tests/phase013/cli-network.mjs",
  "tests/phase013/evidence-guards.mjs",
];
const changedFiles = [
  "docs/database.md",
  "docs/api.md",
  "docs/auth.md",
  "docs/admin.md",
  "docs/crypto.md",
  "docs/privacy-and-user-data.md",
  "README.md",
  "prisma/schema.prisma",
  "src/server/admin/command-receipt.ts",
  "src/server/audit-log.ts",
  "src/server/services/audit-log-service.ts",
  "src/server/api-key-envelope.ts",
  "src/components/admin/admin-nav.ts",
  "src/components/layout/admin-shell.tsx",
  "src/app/admin/(protected)/layout.tsx",
  "tests/admin/layout.test.tsx",
  "tests/lib/audit-log.test.ts",
  "tests/lib/api-key-schema.test.ts",
  "tests/integration/api-key-schema.test.ts",
  "tests/integration/config-models.test.ts",
  "tests/integration/admin-login.test.ts",
  "tests/integration/seed.test.ts",
  "tests/lib/seed.test.ts",
  "tests/phase006/database.integration.ts",
  "tests/phase007/config-fixture.ts",
  "tests/phase008/data-fixture.ts",
  "tests/phase009/audit-fixture.ts",
  "tests/phase010/seed-fixture.ts",
  "tests/phase010/api-key-fixture.ts",
  "tests/phase011/auth-fixture.ts",
  "tests/phase012/admin-fixture.ts",
  "tests/phase012/browser.mjs",
  "tests/admin/users.integration.test.ts",
  "src/server/seed-service.ts",
  "vitest.config.ts",
  "vitest.setup.ts",
  "tsconfig.json",
];
const stableSources = [
  "docs/agent-execution-contract.md",
  maintenancePath,
  maintenance.policy.path,
  "docs/project-layout.json",
  "docs/runtime-baseline.json",
  "docs/env-registry.json",
  "scripts/check-project-layout.mjs",
  "scripts/validate-phase.mjs",
  "scripts/validate-phase.ps1",
  "scripts/phase-evidence.mjs",
  "scripts/test-validate-phase.mjs",
  "scripts/checkpoint-history.mjs",
  "scripts/checkpoint-maintenance.mjs",
  "scripts/test-checkpoint-maintenance.mjs",
  "scripts/test-phase-input-paths.mjs",
  "scripts/verify-phase003.mjs",
  "scripts/phase003-evidence.mjs",
  "scripts/generate-api-contract.mjs",
  "scripts/auth-server.mjs",
  "vitest/stubs/server-only.ts",
  "package.json",
  "package-lock.json",
  ".gitattributes",
  ".gitignore",
  ".env.example",
  "eslint.config.mjs",
  "scripts/eslint-env.mjs",
];
const sourcePaths = [
  ...new Set([
    ...git("ls-files", "src", "tests", "prisma").split(/\r?\n/),
    ...newFiles,
    ...changedFiles.filter((file) => fs.existsSync(path.join(root, file))),
    ...stableSources,
    generationPath,
  ]),
]
  .filter(Boolean)
  .sort();
const specs = [
  [
    "create-read",
    "ADMIN creates a generated synthetic key through the real guarded handler and PostgreSQL transaction. The exact v1 envelope decrypts with matching id/provider AAD; GET and POST contain only the ten-field safe DTO with first12 fingerprint characters plus ellipsis. Duplicate normalized plaintext conflicts without a second row; same Idempotency-Key/payload replays its original safe DTO after a fresh service/process, while changed payload returns409 and zero business writes. Plaintext is never cached, stored in React state, or returned; no decrypt/export/reveal endpoint.",
  ],
  [
    "disable-enable",
    "ACTIVE transitions only to DISABLED or REVOKED, DISABLED only to ACTIVE or REVOKED, and REVOKED is terminal. Every real state/name change checks expectedVersion and increments revision with one matching audit in the same transaction; revokedAt is set on revoke. Stale CAS and revoked recovery produce a safe failure with zero business writes. History ciphertext is not replaced or deleted. Ordinary resolution accepts only ACTIVE, so emergency revoke immediately prevents new calls. An isolated removal of the terminal-state guard must turn the original state assertion red.",
  ],
  [
    "rotate-revoke",
    "Reuse AdminCommandReceipt and KeyRotationRun. The production adapter registry has zero Provider references and reads no future table. The contract adapter fixture covers exactly two active references and immutable candidate configs. One idempotency identity prepares one DISABLED key plus discoverable candidates; candidate HTTP tests use the actual bounded safe client with exact version binding, outside database transactions. Failure preserves old key and both activations and reuses the same candidates on retry. A single Serializable transaction rechecks old revision, complete reference set and every activation revision, then enables new key, switches all references, revokes old key, completes receipt and appends audit. Concurrent rotate has one winner, losers never create orphan ACTIVE keys. Reference set/CAS changes and emergency revoke cause409 without restoration. The existing-table-only migration fixes the Phase012 empty-candidate limitation without adding a second ledger or Provider/model/Prompt tables.",
  ],
  [
    "authorization",
    "Every page/API handler first calls requireAdmin and revalidates the current database ADMIN role, ACTIVE status, sessionVersion and session state. Anonymous, USER, DISABLED ADMIN, stale/revoked sessions and missing/invalid CSRF are denied before protected business reads/writes. Nonexistent and unauthorized resource requests do not leak differences. Writes validate exact schema, expectedVersion, Idempotency-Key and normalized payload hash. Isolated removal of requireAdmin must make original authorization assertions fail with a real nonzero test exit.",
  ],
  [
    "crypto-redaction",
    "AES-256-GCM uses a fresh random96-bit IV,128-bit tag and JCS UTF8 AAD {recordId,provider,envelopeVersion}; KeyResolver matches SHA256(decoded32byte ENCRYPTION_KEY). Reuse the Phase010 exact envelope schema and normalized plaintext fingerprint. Cross-schema/service/database round-trip, same-key/different-IV and malformed version/algorithm/keyId/noncanonical base64/length/AAD/tag all have explicit assertions. Internal SECRET_DECRYPT_FAILED maps only to public CONFIG_ERROR. API, pages, DB safe projection, audit, logs, trace, browser HTML/storage and final evidence expose no plaintext, ciphertext, master key or full fingerprint. Audit queries reuse the Phase009 sanitizer, redact nested secrets to*** and render text safely. Isolated AAD and DTO-whitelist removals each must turn original assertions red.",
  ],
  [
    "failure-atomicity",
    "Audit and receipt failure roll back every business change; rotation CAS/audit failures never partially switch either of two activation references and retain identifiable DISABLED candidates. A bounded read-only AuditLog API filters action/target/actor/time and uses an opaque authenticated keyset cursor with default size and maximum100. Tampered cursor, cross-filter cursor, limit>100, oversized filters and database faults fail safely. Error/not-found pages never render arbitrary HTML, stack, request bodies, internal paths or secrets. Real browser checks exercise key create, disable/enable, rotate/revoke, redacted audit navigation, responsive layout and keyboard/focus with zero sensitive output or storage hits. Normal execution is restored and the complete six-scenario collection passes after all isolated mutations.",
  ],
];
const attemptId = "attempt-1";
const supportingChecks = [
  "plan-and-inputs",
  "dependency-versions",
  "format-check",
  "lint",
  "typecheck",
  "test-discovery",
  "phase013-evidence-guards",
  "validator-regression",
  "prisma-cli-network-isolation",
  "migration-schema",
  "api-contract",
  "card-test",
  "test",
  "phase006-user-regression",
  "browser",
  "negative-controls",
  "evidence-binding",
  "secret-and-scope-scan",
  "project-layout",
  "build",
];
const plan = {
  phase: 13,
  attemptId,
  producer: "Phase013",
  consumers: [14, 15, 92, 126],
  scope: "ADMIN_SECRET_LIFECYCLE_AND_REDACTED_AUDIT_READ",
  implementationContextId: "codex:/root:Phase013:20260912",
  testMode: "full",
  testModeReason:
    "Phase013 changes encryption keys, administrator authorization and shared persistence/receipt contracts; phase-verification-v1 section3 mandates full repository regression.",
  crossAttemptReuse: "disabled",
  engineeringRegression: {
    mode: "full",
    baseCommit: maintenanceCommit,
    discovery:
      "Vitest list --json plus exact assertion and suite-set equality with the full run; zero matches/skips/runtime errors fail",
    includes: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    dedicatedCardCommand: "npm run test -- admin/api-keys admin/logs secret-envelope",
    fullCommand: "npm run test",
    sameExecutionMapping:
      "All six business reports bind the one actual dedicated-card Vitest report by exact file and tagged fullName, supplemented by exact crypto/log assertions, real browser output, negative controls and database migration observations. The full report separately proves every discovered current product test; no upstream Phase prepare/verify/complete runner is invoked.",
  },
  sourcePaths,
  requiredCaseIds: specs.map(([key]) => "Phase013:" + key),
  cases: specs.map(([key, expected]) => ({
    testCaseId: "Phase013:" + key,
    command: "node docs/phase-plans/verify-phase013.mjs --all",
    denominator: 1,
    inputPath: "tests/admin/api-keys.integration.test.ts",
    outputPath: "docs/evidence/attempts/Phase013/" + attemptId + "/" + key + ".json",
    expected,
    assertionSelector: {
      file: "tests/admin/api-keys.integration.test.ts",
      tag: "[" + key + "]",
      minimum: 1,
    },
  })),
  modificationScope: [
    ...new Set([
      ...newFiles,
      ...changedFiles,
      "src/server/security/",
      "src/server/admin/",
      "src/server/projections/",
      "src/components/admin/",
      "src/app/admin/",
      "src/app/api/admin/api-keys/",
      "src/app/api/admin/logs/",
      "tests/admin/",
      "tests/phase013/",
      "prisma/migrations/",
      "docs/evidence/attempts/Phase013/",
    ]),
  ],
  threshold: { originalThreshold: 6, automatedThreshold: 6, requiredPassRate: 1, waived: false },
  supportingChecks,
  migrationPolicy: {
    name: "key_rotation_contract",
    generatedPathPattern: "prisma/migrations/[0-9]{14}_key_rotation_contract/migration.sql",
    generationReceiptPath: generationPath,
    protectionPath: "docs/phase-plans/key-rotation-protection.sql",
    mode: "EXISTING_TABLE_SQL_CONTRACT_REPAIR",
    previousMigrationCount: 7,
    newTablesAllowed: false,
    allowedTables: ["AdminCommandReceipt", "KeyRotationRun", "ApiKeyConfig"],
    preserveExistingMigrationBytes: true,
    applyOnlyAfterChecks: true,
    rationale:
      "Phase012's empty candidateIdsJson constraint and limited non-user request hash cannot represent Phase013's required two-reference fixture and immutable candidate/retry identity. Repair only the existing contract; do not manufacture Prisma schema-generation claims for custom trigger SQL.",
  },
  negativeControls: [
    {
      id: "require-admin",
      originalCase: "authorization",
      sourcePath: "src/server/admin/api-keys.ts",
    },
    {
      id: "aad",
      originalCase: "crypto-redaction",
      sourcePath: "src/server/security/secret-envelope.ts",
    },
    {
      id: "terminal-state",
      originalCase: "disable-enable",
      sourcePath: "src/server/admin/api-keys.ts",
    },
    {
      id: "dto-whitelist",
      originalCase: "crypto-redaction",
      sourcePath: "src/server/projections/admin-api-key.ts",
    },
  ],
  decisions: [
    "Authorization is limited to Phase013. Candidate currentPhase14 is not authorization to execute Phase014.",
    "Keep original run baselines, manifest and eight contract hashes. phaseStartCommit is the synchronized maintenance HEAD; prerequisites.metadataCommit remains the original Phase012 metadata.",
    "Use generated synthetic credentials, a task-owned PostgreSQL17 tmpfs container with no network masquerading, loopback-only port, explicit marker and separate migration/runtime roles.",
    "Use the existing requireAdmin, ApiKeyConfig, AdminCommandReceipt, KeyRotationRun, AuditLog sanitizer and AdminShell; no model, Prompt or Provider tables and no future endpoint placeholders.",
    "Retain all prior assertions and all frozen business requirements. Current fixture namespaces and exact migration inventories may extend for013 without rewriting historical Gate/report bytes.",
    "Run cheap source, schema, format, type, discovery, fixture and infrastructure checks before expensive formal acceptance. Product diagnostics are not Gate PASS.",
    "Run the dedicated card test command and full repository command each once for the stable candidate. Real DB/browser/negative checks remain distinct; reuse of prior attempt reports is disabled.",
    "Run destructive security mutations only in copied fixtures. Prove original assertions fail for the intended security reason, restore, then run the original six-scenario collection.",
    "The final independent reviewer must not author the implementation and must bind exact current plan, source and report hashes. Double-shell seal and remote verification follow direct artifact/metadata commits.",
  ],
  previousAttempts: [],
  notApplicable: [
    "Production credentials/traffic, real Provider calls, public deployment, models/Prompts/Provider governance and Phase014+ are not evaluated. Human screen-reader experience is NOT_EVALUATED; browser accessibility is automated. JavaScript strings are not claimed to be memory-zeroed.",
  ],
  costAccounting: {
    productImplementation: { durationMs: null, measurementStatus: "UNMEASURED" },
    infrastructure: { durationMs: null, measurementStatus: "UNMEASURED" },
    verification:
      "Actual command durations, execution counts and database preparation observations in quality.json",
    independentReview: { durationMs: null, measurementStatus: "UNMEASURED" },
    evidencePreparation: { durationMs: null, measurementStatus: "UNMEASURED" },
    productionRequests: 0,
    realProviderRequests: 0,
  },
};
const receipt = {
  layoutVersion: 2,
  phase: 13,
  repositoryRoot: ".",
  projectRoot: ".",
  roadmapRoot: state.roadmapRoot,
  baselineCommit: state.baselineCommit,
  executionBaselineCommit: state.executionBaselineCommit,
  phaseStartCommit: preflight.head,
  manifestHash: state.manifestHash,
  requestedThrough: 13,
  pinnedInputPolicy: "LOCAL_FILES_WITH_RECORDED_SHA256",
  checkpointMigration: state.checkpointMigration,
  pinnedInputs: previous.pinnedInputs,
  checkpointMaintenance: maintenanceBinding,
  validationPolicy: maintenance.policy,
  prerequisites: {
    ...state.currentLayoutPhaseSeal,
    metadataCommit: previousMetadata,
    schemaPath: "prisma/schema.prisma",
    schemaHash: hash("prisma/schema.prisma"),
    migrationPath: migrations.at(-1),
    migrationHash: hash(migrations.at(-1)),
    migrations: migrations.map((file) => ({ path: file, sha256: hash(file) })),
  },
  preflight: { ...preflight, reportPath: preflightPath, reportHash: hash(preflightPath) },
};
write(receiptPath, receipt);
write(planPath, plan);
write("docs/evidence/attempts/Phase013/" + attemptId + "/frozen-plan.json", plan);
console.warn(
  JSON.stringify({
    status: "FROZEN",
    phase: 13,
    attemptId,
    cases: 6,
    testMode: "full",
    planHash: hash(planPath),
    inputHash: hash(receiptPath),
  }),
);
