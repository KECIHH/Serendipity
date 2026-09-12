import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file));
const json = (file) => JSON.parse(read(file));
const hash = (file) => createHash("sha256").update(read(file)).digest("hex");
const git = (...args) =>
  execFileSync("git", ["-c", "core.quotepath=false", ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
};
const state = json("docs/roadmap-run.json");
const previous = json("docs/phase-plans/Phase013-inputs.json");
const preflightPath = "docs/evidence/attempts/Phase014/setup/preflight.json";
const preflight = json(preflightPath);
const start = preflight.head;
assert.equal(state.currentPhase, 14);
assert.equal(state.completedThrough, 13);
assert.equal(state.operatorMode, "AGENT_ONLY_AUTOMATED_NEW_BUILD");
assert.equal(preflight.workingTree, "");
assert.equal(preflight.remoteHead, start);
assert.equal(git("rev-parse", "HEAD"), start);
assert.equal(git("rev-parse", "origin/main"), start);
assert.equal(git("branch", "--show-current"), "main");
assert.equal(git("remote", "get-url", "origin"), preflight.remote);
assert.equal(git("remote", "get-url", "--push", "origin"), preflight.remote);
assert.equal(preflight.shells.length, 2);
for (const shell of preflight.shells) {
  assert.equal(shell.exitCode, 0);
  assert.equal(shell.result.status, "PASS");
  assert.equal(shell.result.completedThrough, 13);
  assert.equal(shell.result.currentPhase, 14);
  assert.equal(shell.result.maintenanceHead, start);
  assert.equal(shell.result.artifactCommit, state.currentLayoutPhaseSeal.artifactCommit);
}
for (const input of previous.pinnedInputs) assert.equal(hash(input.path), input.sha256);
for (const phase of [11, 12, 13]) {
  const checkpoint = state.checkpoints.find((item) => item.phase === phase);
  assert.equal(hash(checkpoint.evidencePath), checkpoint.evidenceHash);
  assert.equal(json(checkpoint.evidencePath).status, "PASS");
}
const metadata = preflight.shells[0].result.metadataCommit;
assert.equal(git("rev-parse", start + "^"), metadata);
assert.equal(git("rev-parse", metadata + "^"), state.currentLayoutPhaseSeal.artifactCommit);
assert.equal(
  git(
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ":(exclude)" + preflightPath,
    ":(exclude)docs/phase-plans/prepare-phase014.mjs",
  ),
  "",
);
const policy = preflight.shells[0].result;
const binding = (name) => {
  const { policy: details, ...receipt } = policy[name];
  assert.equal(hash(receipt.path), receipt.sha256);
  assert.equal(hash(details.path), details.sha256);
  return [receipt, details];
};
const [checkpointMaintenance, validationPolicy] = binding("checkpointMaintenance");
const [executionMaintenance, executionPolicy] = binding("executionMaintenance");
const newFiles = [
  "docs/phase014.md",
  "docs/phase-plans/Phase014.json",
  "docs/phase-plans/Phase014-inputs.json",
  ...["prepare", "setup", "verify", "complete"].map(
    (verb) => `docs/phase-plans/${verb}-phase014.mjs`,
  ),
  "docs/phase-plans/phase014-runtime.mjs",
  "docs/phase-plans/phase014-evidence.mjs",
  "src/lib/admin-settings.ts",
  "src/lib/admin-dashboard.ts",
  "src/server/config/config-registry.ts",
  "src/server/config/config-service.ts",
  "src/server/admin/settings.ts",
  "src/server/admin/dashboard.ts",
  "src/server/admin/readiness.ts",
  "src/server/admin/migration-inventory.ts",
  "src/app/api/admin/settings/route.ts",
  "src/app/api/admin/settings/[key]/route.ts",
  "src/app/api/config/public/route.ts",
  "src/app/api/admin/dashboard/stats/route.ts",
  "src/app/admin/(protected)/settings/page.tsx",
  "src/components/admin/settings-client.tsx",
  "src/components/admin/dashboard-client.tsx",
  "src/components/common/data-table.tsx",
  "src/components/admin/admin-pagination.tsx",
  ...["settings", "dashboard", "security"].map((name) => `tests/admin/${name}.test.ts`),
  "tests/admin/settings-client.test.tsx",
  "tests/admin/dashboard-client.test.tsx",
  "tests/phase014/fixture.ts",
  "tests/phase014/worker.ts",
  "tests/phase014/browser.mjs",
  "tests/phase014/evidence-guards.mjs",
];
const stable = [
  "docs/agent-execution-contract.md",
  "docs/testing-execution-policy.md",
  "docs/development-execution-policy.md",
  checkpointMaintenance.path,
  executionMaintenance.path,
  "docs/project-layout.json",
  "docs/runtime-baseline.json",
  "docs/api.md",
  "docs/database.md",
  "docs/admin.md",
  "docs/privacy-and-user-data.md",
  "docs/ui-design-system.md",
  "docs/env-registry.json",
  "README.md",
  "package.json",
  "package-lock.json",
  ".gitattributes",
  ".gitignore",
  ".env.example",
  "eslint.config.mjs",
  "next.config.ts",
  "vitest.config.ts",
  "vitest.setup.ts",
  "tsconfig.json",
  "vitest/stubs/server-only.ts",
];
const sourcePaths = [
  ...new Set([
    ...git("ls-files", "src", "tests", "prisma", "scripts").split(/\r?\n/),
    ...newFiles,
    ...stable,
  ]),
]
  .filter(Boolean)
  .sort();
const specs = [
  [
    "settings",
    "tests/admin/settings.test.ts",
    "All five groups, exact closed registry and seeded private planner defaults; per-key schema/canonical JSON/unknown fields and keys/invalid JSON/non-finite and bounded values/null semantics/deployment caps. Real authenticated read and PATCH use revision CAS, one CONFIG_UPDATE with before/after hashes and bounded redacted diff plus persistent idempotency receipt in one Serializable transaction. Same updatedAt concurrent writes have one winner; same key/payload replays after restart, changed payload conflicts; failed audit/receipt leaves zero writes.",
  ],
  [
    "public-projection",
    "tests/admin/settings.test.ts",
    "Public GET reads only database isPublic=true AND registry public allowlist; explicit projection excludes private/internal/unknown fields and planner defaults even when DB visibility is corrupted. Public-only ETag/cache policy; private changes and stripped internal values do not change the ETag, visible changes do. Conditional requests return304 without leaking private fields.",
  ],
  [
    "dashboard",
    "tests/admin/dashboard.test.ts",
    "Exact four widgets users/records/configs/recent10 safe audits. Real aggregate success, true empty data, one query failing while three succeed, all queries failing and unavailable DB. Independent bounded queries return discriminated errors, never fabricated zeros. Missing/changed prerequisite migration or missing table blocks readiness and API/UI, including ApiKeyConfig despite no key statistics.",
  ],
  [
    "authorization",
    "tests/admin/security.test.ts",
    "Every new admin route/page uses requireAdmin. Anonymous/USER/DISABLED ADMIN/old or revoked session/CSRF failure are denied before writes. Revalidate the actor under transaction locks and before read responses. Actual HTTP route tests and real browser sessions; exact five live menus, common PageHeader/loading/empty/error and DataTable/AdminPagination reuse, keyboard and375px layout, loading/empty/error/DB failure.",
  ],
  [
    "m3-regression",
    "tests/admin/security.test.ts",
    "Current complete repository regression plus all M3 authentication/login/logout/revocation/user disable/last ACTIVE ADMIN/key lifecycle/immutable audit/config CAS/projection tests. Discover and execute identical nonempty assertion set without skip. Phase011-013 Gate/hash chain unchanged; no model/Prompt/Provider tables, queries or future menu links. Four isolated removals (settings authorization, public allowlist, CAS, audit) make their original fixed assertions fail; restore then run dedicated and full suites. Real build and browser evidence, exact5/5 business denominator; unauthorized writes/private leaks/lost updates/missing audits all zero.",
  ],
];
const plan = {
  phase: 14,
  attemptId: "attempt-1",
  producer: "Phase014",
  consumers: ["Phase015", "M3"],
  scope:
    "SystemConfig administration, foundational dashboard and existing administration UI; authorized through Phase014 only",
  implementationContextId: "codex-native-root-phase014-20260913",
  testMode: "full",
  testModeReason:
    "Phase014 is the manifest M3 milestone and changes public configuration, admin authorization and shared UI. phase-verification-v1 section3 requires full.",
  crossAttemptReuse: "disabled",
  engineeringRegression: {
    mode: "full",
    baseCommit: start,
    discovery:
      "vitest list --json; exact file/fullName equality, all discovered assertions pass without skip",
    dedicatedCardCommand: "npm run test -- admin/settings admin/dashboard admin/security",
    fullCommand: "npm run test",
    includes: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
  },
  sourcePaths,
  requiredCaseIds: specs.map(([key]) => `Phase014:${key}`),
  cases: specs.map(([key, inputPath, expected]) => ({
    testCaseId: `Phase014:${key}`,
    command: "node docs/phase-plans/verify-phase014.mjs --all",
    denominator: 1,
    inputPath,
    outputPath: `docs/evidence/attempts/Phase014/attempt-1/${key}.json`,
    expected,
    assertionSelector: { file: inputPath, tag: `[${key}]`, minimum: 1 },
  })),
  modificationScope: [
    ...new Set([
      ...newFiles,
      "src/",
      "tests/",
      "scripts/",
      ...stable,
      "docs/evidence/attempts/Phase014/",
    ]),
  ],
  threshold: { originalThreshold: 5, automatedThreshold: 5, requiredPassRate: 1, waived: false },
  supportingChecks: [
    "lint",
    "typecheck",
    "format:check",
    "build",
    "full-regression",
    "dedicated-card",
    "prerequisite-migrations",
    "database-failures",
    "browser-a11y",
    "negative-controls",
    "evidence-guards",
    "layout",
    "validator-regression",
  ],
  migrationPolicy: {
    mode: "REUSE_EXISTING",
    preserveExistingMigrationBytes: true,
    newTablesAllowed: false,
  },
  negativeControls: ["require-admin", "public-allowlist", "revision-cas", "audit-atomicity"],
  decisions: [
    "Use existing SystemConfig and AdminCommandReceipt; no new schema is required. Existing migrations remain byte-identical.",
    "Config registry uses the five canonical groups, takes over the three existing private planner defaults and explicitly registers bounded non-secret runtime settings. Missing registry rows are not invented by reads; PATCH targets existing rows only. New keys are introduced with an audited seed/provisioning change and dedicated regression.",
    "The closed AdminSettings DTO contains items only; all currently registered settings are bounded. Growing user/key/audit lists retain their signed keyset pagination, default20/max100; no offset pagination or unregistered DTO fields.",
    "Deployment/environment caps have priority over DB values; UI edits JSON and displays server DTOs only. No AI model/Prompt/Provider/statistics implementation.",
    "Reuse the exact common state/header components; extend PageHeader accessibly where consumers need title focus/description.",
    "Task-owned PostgreSQL17 and locked Playwright; no public runtime requests or production traffic. Mutations only in verified temporary copies; negative controls precede the restored full run.",
    "One independent native reviewer,45minute full/20minute differential budget, actual source and evidence binding; direct artifact/metadata commits, dual-shell seal and origin/main verification. Do not execute Phase015.",
  ],
  previousAttempts: [],
  notApplicable: [
    "Production deployment/traffic, real identities, external Provider calls and human screen-reader evaluation; no authorization for Phase015.",
  ],
  costAccounting: {
    implementation: { durationMs: null, measurementStatus: "UNMEASURED" },
    infrastructure: { durationMs: null, measurementStatus: "UNMEASURED" },
    verification: "Timestamped actual command observations",
    review: "Independent reviewer start/end timestamps",
    productionRequests: 0,
  },
};
const migrations = git("ls-files", "prisma/migrations")
  .split(/\r?\n/)
  .filter((file) => file.endsWith("/migration.sql"));
const receipt = {
  layoutVersion: 2,
  phase: 14,
  repositoryRoot: ".",
  projectRoot: ".",
  roadmapRoot: state.roadmapRoot,
  baselineCommit: state.baselineCommit,
  executionBaselineCommit: state.executionBaselineCommit,
  phaseStartCommit: start,
  manifestHash: state.manifestHash,
  requestedThrough: 14,
  pinnedInputPolicy: "LOCAL_FILES_WITH_RECORDED_SHA256",
  checkpointMigration: state.checkpointMigration,
  pinnedInputs: previous.pinnedInputs,
  checkpointMaintenance,
  validationPolicy,
  executionMaintenance,
  executionPolicy,
  prerequisites: {
    ...state.currentLayoutPhaseSeal,
    metadataCommit: metadata,
    schemaPath: "prisma/schema.prisma",
    schemaHash: hash("prisma/schema.prisma"),
    migrations: migrations.map((file) => ({ path: file, sha256: hash(file) })),
  },
  preflight: { ...preflight, reportPath: preflightPath, reportHash: hash(preflightPath) },
};
write("docs/phase-plans/Phase014-inputs.json", receipt);
write("docs/phase-plans/Phase014.json", plan);
write("docs/evidence/attempts/Phase014/attempt-1/frozen-plan.json", plan);
console.log(
  JSON.stringify({
    status: "FROZEN",
    phase: 14,
    testMode: "full",
    cases: 5,
    planHash: hash("docs/phase-plans/Phase014.json"),
  }),
);
