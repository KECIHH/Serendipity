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
    cwd: root, encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const write = (file, value) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
};

const state = json("docs/roadmap-run.json");
const previous = json("docs/phase-plans/Phase010-inputs.json");
const preflightPath = "docs/evidence/attempts/Phase011/setup/preflight.json";
const preflight = json(preflightPath);
assert.equal(state.currentPhase, 11);
assert.equal(state.completedThrough, 10);
assert.equal(preflight.phase, 11);
assert.equal(preflight.workingTree, "");
assert.equal(git("rev-parse", "HEAD"), preflight.head);
assert.equal(git("rev-parse", "origin/main"), preflight.head);
assert.equal(preflight.remoteHead, preflight.head);
assert.equal(git("branch", "--show-current"), "main");
assert.equal(git("remote", "get-url", "origin"), "https://github.com/KECIHH/Serendipity.git");
assert.equal(git("remote", "get-url", "--push", "origin"), "https://github.com/KECIHH/Serendipity.git");
assert.equal(git("rev-list", "--left-right", "--count", "HEAD...origin/main"), "0\t0");
const shellCommands = {
  "Windows PowerShell 5.1": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/validate-phase.ps1 -CompletedThrough 10 -Strict -Json",
  "PowerShell 7": "pwsh -NoProfile -File scripts/validate-phase.ps1 -CompletedThrough 10 -Strict -Json",
};
assert.deepEqual(preflight.shells.map((shell) => shell.shell).sort(), Object.keys(shellCommands).sort());
for (const shell of preflight.shells) {
  assert.equal(shell.command, shellCommands[shell.shell]);
  assert.equal(shell.exitCode, 0);
  assert.equal(shell.result.status, "PASS");
  assert.equal(shell.result.completedThrough, 10);
  assert.equal(shell.result.currentPhase, 11);
  assert.equal(shell.result.metadataCommit, preflight.head);
  assert.equal(shell.result.artifactCommit, state.currentLayoutPhaseSeal.artifactCommit);
}
assert.equal(git("status", "--porcelain=v1", "--untracked-files=all", "--",
  ":(exclude)docs/evidence/attempts/Phase011/setup/preflight.json",
  ":(exclude)docs/phase-plans/prepare-phase011.mjs"), "");
for (const input of previous.pinnedInputs) assert.equal(hash(input.path), input.sha256);
for (const phase of [6, 9, 10]) {
  const checkpoint = state.checkpoints.find((entry) => entry.phase === phase);
  assert.equal(hash(checkpoint.evidencePath), checkpoint.evidenceHash);
  assert.equal(json(checkpoint.evidencePath).status, "PASS");
}
assert.equal(git("rev-parse", `${preflight.head}^`), state.currentLayoutPhaseSeal.artifactCommit);
const previousGate = json(state.currentLayoutPhaseSeal.evidencePath);
assert.equal(hash("prisma/schema.prisma"), previousGate.details.schemaHash);
const migrations = git("ls-files", "prisma/migrations").split(/\r?\n/).filter((file) => file.endsWith("migration.sql")).sort();
assert.equal(migrations.length, 5);

const planPath = "docs/phase-plans/Phase011.json";
const receiptPath = "docs/phase-plans/Phase011-inputs.json";
const generationPath = "docs/evidence/attempts/Phase011/setup/migration-generation.json";
const newFiles = [
  planPath, receiptPath, "docs/phase011.md",
  "docs/phase-plans/prepare-phase011.mjs", "docs/phase-plans/phase011-runtime.mjs",
  "docs/phase-plans/setup-phase011.mjs", "docs/phase-plans/verify-phase011.mjs",
  "docs/phase-plans/phase011-evidence.mjs", "docs/phase-plans/complete-phase011.mjs",
  "docs/phase-plans/auth-session-protection.sql",
  "src/server/auth/credentials-service.ts", "src/server/auth/login-throttle.ts",
  "src/server/auth/session-service.ts", "src/server/auth/errors.ts", "src/server/auth/types.ts",
  "src/server/auth/clock.ts", "src/server/auth/auth-config.ts", "src/server/auth/auth-handler.ts",
  "src/server/auth/cookie.ts", "src/server/auth/require-admin.ts", "src/server/auth/guards.ts",
  "src/server/auth/trusted-client.ts", "src/server/ingress.ts", "scripts/auth-server.mjs",
  "src/app/api/auth/[...nextauth]/route.ts", "src/app/admin/page.tsx",
  "src/app/admin/login/page.tsx", "src/app/(site)/login/page.tsx",
  "src/components/auth/login-form.tsx", "src/components/auth/logout-button.tsx",
  "tests/lib/auth-services.test.ts", "tests/lib/auth-http.test.ts", "tests/lib/auth-guards.test.ts",
  "tests/lib/admin-login-ui.test.tsx", "tests/lib/auth-ingress.test.ts",
  "tests/integration/admin-login.test.ts", "tests/phase011/auth-fixture.ts",
  "tests/phase011/auth-types.ts", "tests/phase011/auth-worker.ts", "tests/phase011/browser.mjs",
  "tests/phase011/cli-network.mjs", "tests/phase011/evidence-guards.mjs",
];
const changedFiles = [
  "package.json", "package-lock.json", "README.md", ".env.example",
  "docs/runtime-baseline.json", "prisma/schema.prisma", "prisma/seed.ts",
  "src/lib/env-schema.ts", "src/lib/env-cli.ts", "src/lib/env.ts", "src/lib/env.test.ts",
  "src/server/auth.ts", "src/server/audit-log.ts", "src/server/services/audit-log-service.ts",
  "src/server/seed-input.ts", "src/server/services/seed-service.ts",
  "src/app/admin/layout.tsx", "src/middleware.ts", "src/middleware.test.ts", "src/app/layout.test.ts",
  "docs/env-registry.json", "docs/auth.md", "docs/api.md", "docs/database.md",
  "docs/privacy-and-user-data.md", "docs/hosting.md",
  "scripts/verify-phase003.mjs", "scripts/phase003-evidence.mjs",
  "tests/phase006/database.integration.ts", "tests/phase007/config-fixture.ts",
  "tests/phase008/data-fixture.ts", "tests/phase009/audit-fixture.ts",
  "tests/phase010/seed-fixture.ts", "tests/phase010/api-key-fixture.ts",
  "tests/integration/config-models.test.ts", "tests/integration/audit-log.test.ts",
  "tests/integration/travel-record.test.ts", "tests/integration/chat-message.test.ts",
  "tests/integration/seed.test.ts", "tests/integration/api-key-schema.test.ts",
  "tests/lib/audit-log.test.ts", "tests/lib/seed.test.ts",
];
const sourcePaths = [...new Set([
  ...git("ls-files", "src", "tests", "prisma").split(/\r?\n/), ...newFiles, ...changedFiles,
  generationPath, "docs/agent-execution-contract.md", "docs/project-layout.json",
  "scripts/check-project-layout.mjs", "scripts/validate-phase.mjs", "scripts/validate-phase.ps1",
  "scripts/phase-evidence.mjs", "scripts/test-validate-phase.mjs", "scripts/checkpoint-history.mjs",
  "scripts/test-phase-input-paths.mjs", "vitest.config.ts", "vitest.setup.ts", "vitest/stubs/server-only.ts",
  "tsconfig.json", ".gitattributes", ".gitignore", "eslint.config.mjs", "scripts/eslint-env.mjs",
])].filter(Boolean).sort();
const specs = [
  ["valid-login", "The real Phase010 create-only seed creates an isolated ACTIVE ADMIN from generated command credentials. The single Auth.js Credentials handler authenticates through normalizeEmailV1 and bcryptjs cost12; transactionally re-reads current passwordHash, role, status and sessionVersion before lastLoginAt, LOGIN_SUCCESS, RESERVED-to-SUCCEEDED and AuthSession creation commit. Audit or concurrent security-state change prevents partial writes and session issuance. Cookie is Auth.js signed/encrypted HttpOnly, SameSite=Lax, path /, Secure outside loopback and absolutely expires after 43200 seconds without sliding renewal; it contains only a random opaque token envelope and database stores only SHA-256. Exactly one generated additive auth_session_login_attempt migration introduces the two exact models, hash/TTL/state checks, indexes and immutable terminal-state protections while preserving all five prior migrations and existing data."],
  ["uniform-failure", "Unknown email, wrong password, USER at ADMIN entry and DISABLED ADMIN each perform exactly one real bcrypt comparison, with a fixed startup dummy hash for absent accounts, and expose identical HTTP status, response bytes and header sets with the message 邮箱或密码错误. Validate UTF-8 email/password size boundaries before bcrypt truncation can occur; client role, userId and sessionVersion are ignored. A frozen controlled timing rubric records sample count/order and group distributions and rejects exploitable account-group differences. Internal audited reason codes differ safely without raw email, IP, password, cookie or token in failure logs or evidence."],
  ["dual-throttle", "PostgreSQL AuthLoginAttempt alone is authoritative. Under lexicographically ordered IP/account advisory transaction locks, reserve one row after counting the rolling 900-second window of FAILED and unexpired RESERVED; account request 6 and IP request 21 return identical 429 plus Retry-After without bucket disclosure. Both dimensions work independently, concurrent requests never exceed either threshold, success does not clear prior failures, reservation completion is idempotent and terminal history is immutable. Retry-After reflects the earliest relevant window/reservation release and an injected database clock proves recovery; a crashed reservation becomes EXPIRED only after its 60-second TTL. Lock removal and account-bucket removal must be observable by original concurrent/account assertions."],
  ["persistence-proxy", "Recreate the service and use a separate process against the same isolated PostgreSQL database to prove failed attempts and reservations persist. Default address resolution ignores client Forwarded/X-Forwarded-For and derives the client address from the real socket through verified internal ingress metadata; missing, malformed, replayed or forged internal metadata fails closed. Only explicitly configured trusted proxy fixtures may resolve a forwarded chain. Equivalent addresses normalize to one HMAC key; neither raw IP nor canonical email is persisted in attempts or failed audits. Throttle, audit and database failures reject admission rather than admitting unlimited traffic."],
  ["session-revocation", "Each request rechecks AuthSession ACTIVE, absolute expiry, audience and User canonical email, ACTIVE status, ADMIN role and identical sessionVersion using real database reads. Current-session logout uses an idempotent database CAS; sessionVersion increment, role demotion, disablement, revoked/expired row and elapsed expiry make old cookies invalid on the very next request. No raw token exists in database, forbidden audience escalation fails, lastSeenAt never extends expiry, and runtime-role SQL attempts cannot change immutable identities, historical login outcomes or restore terminal sessions."],
  ["guards", "The protected page, Route Handler wrapper and Server Action wrapper invoke requireAdmin before every protected resource read/write. Missing, USER, revoked, stale-version, disabled and unavailable-database principals produce typed 401/403 or safe unavailable failures and cause zero protected business queries/writes. Valid ADMIN reaches the protected operation exactly once. Every current management handler/action is covered; middleware and client claims cannot authorize. CSRF token, fixed allowed Origin and Fetch Metadata checks precede cookie-authorized writes without introducing unregistered business endpoints."],
  ["routing-logout", "Real HTTP and Playwright exercise /admin/login and the sole /api/auth/[...nextauth] handler, unauthenticated admin redirect, successful /admin temporary page with logout, USER login through the shared credentials service and logout closure without 404 or redirect loops. The neutral admin layout has no protected navigation on login. Preview environment variables, query parameters and cookies never bypass authorization. Reject malicious callback URLs, cross-site requests and missing/invalid CSRF; preserve Secure and absolute expiry through session reads. Logout revokes the database before clearing cookies; database failure still clears the browser cookie but returns a safe failure and never claims server revocation. Save credential-free screenshot/DOM hashes and deterministic accessibility/keyboard observations."],
  ["mutation", "Only isolated source copies remove database AuthSession revalidation, sessionVersion revalidation, unknown-account dummy comparison, account bucket and advisory locking separately. The original corresponding fixed product assertions must actually fail with nonzero process exit and the expected security regression, never an import/setup/type error. Restore the unmodified implementation and rerun the original targeted assertions and full auth/admin-login tests green. Record baseline, mutated-source hashes, low-level exits, failed assertion names and restored results; production worktree and applied migration bytes remain unchanged."],
];
const attemptId = "attempt-1";
const plan = {
  phase: 11, attemptId, producer: "Phase011", consumers: [12, 13, 14, 82, 83, 84],
  scope: "ADMIN_CREDENTIALS_PERSISTENT_DUAL_THROTTLE_AND_DATABASE_AUTHORIZATION",
  implementationContextId: "codex:/root:Phase011:20260911", sourcePaths,
  requiredCaseIds: specs.map(([key]) => `Phase011:${key}`),
  cases: specs.map(([key, expected]) => ({
    testCaseId: `Phase011:${key}`, command: `node docs/phase-plans/verify-phase011.mjs --case ${key}`,
    denominator: 1, inputPath: "tests/integration/admin-login.test.ts",
    outputPath: `docs/evidence/attempts/Phase011/${attemptId}/${key}.json`, expected,
  })),
  modificationScope: [...new Set([...newFiles, ...changedFiles,
    "src/server/auth/", "src/app/admin/", "src/app/(site)/login/", "src/app/api/auth/",
    "src/components/auth/", "prisma/migrations/", "tests/phase011/", "docs/evidence/attempts/Phase011/",
  ])],
  threshold: { originalThreshold: 8, automatedThreshold: 8, requiredPassRate: 1, waived: false },
  supportingChecks: ["lint", "typecheck", "auth-admin-login", "test", "format-check", "build",
    "project-layout", "phase003-regression", "phase006-user-regression", "phase007-config-regression",
    "phase008-data-regression", "phase009-audit-regression", "phase010-seed-regression",
    "migration-schema", "evidence-binding", "dependency-versions", "prisma-cli-network-isolation",
    "secret-and-scope-scan", "validator-regression", "phase011-evidence-guards"],
  migrationPolicy: {
    name: "auth_session_login_attempt", generatedPathPattern: "prisma/migrations/[0-9]{14}_auth_session_login_attempt/migration.sql",
    generationReceiptPath: generationPath, preserveGeneratedTimestamp: true, applyOnlyAfterChecks: true,
  },
  decisions: [
    "Only Phase011 is authorized. A successful candidate sets completedThrough=11/currentPhase=12 and nextPhaseExecutionAuthorized=false; Phase012 is not executed.",
    "Preserve the current root layout, all local pinned-input hashes, checkpoint-import binding and Phase000-010 Gate/history bytes. The synchronized Phase010 metadata is phaseStartCommit; original run baselines are inherited unchanged.",
    "Auth.js is the unique Credentials handler for ADMIN and USER audiences. Pin next-auth and its actual core version in package-lock/runtime-baseline before verification; retain the existing bcryptjs 3.0.2 cost12 baseline. No business login aliases or registration implementation are introduced.",
    "Use the Phase002 rolling 900-second failed/reserved window and 60-second reservation TTL. Reaching account5 or IP20 denies subsequent admission until enough counted rows release; Retry-After is derived from the relevant release times, not an in-memory reset or successful-account reset.",
    "Use a task-owned PostgreSQL17 tmpfs container with an isolated network, explicit database run marker and separate migration/runtime roles. public.auth_now() is the shared database clock; only the isolated database owner may replace it for a fixed-clock fixture, never a request or runtime role.",
    "A Node ingress takes socket.remoteAddress, overwrites untrusted internal metadata and signs a bounded request context. Fixed server Origin and trusted-proxy configuration own redirects, CSRF and Secure; arbitrary Host/forwarding headers are not authentication inputs.",
    "Preserve earlier domain assertions while extending their exact disposable namespace, migrations/table/enum inventories and audit action registry for Phase011. The Phase003 current-startup contract may evolve to launch the required ingress with equivalent bootstrap regressions; historical Gate artifacts remain immutable.",
    "Use real SQL, bcrypt, Auth.js HTTP and browser flows for business verification. Test-only factories expose real Prisma connections and deterministic observations; they do not replace authentication services with mocks. Generated secrets stay under ignored .scaffold and every raw output is scanned before archival.",
  ],
  previousAttempts: [],
  notApplicable: ["No production traffic, real identities, public deployment, registration, account-management mutations or future governance model implementation is exercised. Human screen-reader experience is NOT_EVALUATED; browser accessibility is automated."],
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
  layoutVersion: 2, phase: 11, repositoryRoot: ".", projectRoot: ".", roadmapRoot: state.roadmapRoot,
  baselineCommit: state.baselineCommit, executionBaselineCommit: state.executionBaselineCommit,
  phaseStartCommit: preflight.head, manifestHash: state.manifestHash, requestedThrough: 11,
  pinnedInputPolicy: "LOCAL_FILES_WITH_RECORDED_SHA256", checkpointMigration: state.checkpointMigration,
  pinnedInputs: previous.pinnedInputs,
  prerequisites: {
    ...state.currentLayoutPhaseSeal, metadataCommit: preflight.head, schemaPath: "prisma/schema.prisma",
    schemaHash: hash("prisma/schema.prisma"), migrationPath: migrations.at(-1), migrationHash: hash(migrations.at(-1)),
    migrations: migrations.map((file) => ({ path: file, sha256: hash(file) })),
    seedPath: "prisma/seed.ts", seedHash: hash("prisma/seed.ts"),
  },
  preflight: { ...preflight, originMain: preflight.head, branch: "main",
    remote: "https://github.com/KECIHH/Serendipity.git", ahead: 0, behind: 0,
    reportPath: preflightPath, reportHash: hash(preflightPath), completedThrough: 10, currentPhase: 11 },
};
write(receiptPath, receipt);
write(planPath, plan);
write(`docs/evidence/attempts/Phase011/${attemptId}/frozen-plan.json`, plan);
console.warn(JSON.stringify({ status: "FROZEN", phase: 11, attemptId, cases: 8, planHash: hash(planPath) }));
