import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as runtime from "./phase018-runtime.mjs";
import { businessDenominators, dedicatedCommand, ids, negatives, planPath, receiptPath, requireInputs, requirePlan, startCommit } from "./phase022-evidence.mjs";

const { command, environment, fixtureFiles, git, hash, json, read, root, sourceFiles, write } = runtime;
const attemptId = process.argv[2] ?? "attempt-1";
assert.match(attemptId, /^attempt-\d+$/);
const directory = `docs/evidence/attempts/Phase022/${attemptId}`;
assert(!fs.existsSync(path.join(root, directory, "frozen-plan.json")), "ATTEMPT_ALREADY_FROZEN");
if (!fs.existsSync(path.join(root, receiptPath))) {
  const previous = json("docs/phase-plans/Phase021-inputs.json");
  const state = json("docs/roadmap-run.json");
  assert.equal(state.completedThrough, 21);
  const receipt = {
    ...previous,
    phase: 22,
    phaseStartCommit: startCommit,
    requestedThrough: 22,
    prerequisites: { ...state.checkpoints.at(-1), metadataCommit: startCommit },
    preflight: {
      mode: "NEW_PHASE022",
      head: git(["rev-parse", "HEAD"]).trim(),
      originMain: git(["rev-parse", "origin/main"]).trim(),
      porcelain: git(["status", "--porcelain=v1", "--untracked-files=all"]).trim(),
      branch: git(["branch", "--show-current"]).trim(),
    },
  };
  delete receipt.recovery;
  requireInputs(receipt, { hash, git, json });
  write(receiptPath, receipt);
}
requireInputs(json(receiptPath), { hash, git, json });
const sources = [...new Set([
  ...sourceFiles(),
  ...fixtureFiles(),
  receiptPath,
  "docs/testing-execution-policy.md",
  "docs/development-execution-policy.md",
  "docs/agent-execution-contract.md",
  "docs/project-constitution.md",
  "docs/phase-plans/phase018-runtime.mjs",
  "docs/phase-plans/phase018-evidence.mjs",
  "docs/phase-plans/Phase021.json",
  "docs/phase-plans/Phase021-inputs.json",
  ...["prepare", "verify", "complete"].map((name) => `docs/phase-plans/${name}-phase022.mjs`),
  "docs/phase-plans/phase022-evidence.mjs",
  "docs/phase-plans/Phase022.json",
  ".gitattributes",
  ".gitignore",
  ".prettierignore",
  ".prettierrc.json",
  "eslint.config.mjs",
  "next.config.ts",
  "postcss.config.mjs",
])].sort();
const scratch = `.scaffold/phase022/${attemptId}-discovery.json`;
const collected = command(process.execPath, ["node_modules/vitest/vitest.mjs", "list", "--json", scratch], { env: environment(), timeoutMs: 180000 });
assert.equal(collected.exitCode, 0, collected.stderr);
const discovery = json(scratch);
const rows = discovery.map((row) => ({ file: path.relative(root, row.file).replaceAll("\\", "/"), fullName: row.name.replaceAll(" > ", " ") }));
const requiredTitles = {
  "Phase022:unit": ["单元：解析需求、生成完整概要并通过草稿校验"],
  "Phase022:integration": ["集成：两个目的地保持原顺序且不折叠成字符串"],
  "Phase022:reverse-destinations": ["反向：空目的地拒绝且不生成默认值", "反向：多目的地折叠成字符串时拒绝"],
  "Phase022:reverse-conflict": ["反向：与需求冲突的偏好不得进入概要"],
  "Phase022:reverse-schema": ["反向：删除草稿必需字段时校验失败"],
};
const bindings = Object.fromEntries(Object.entries(requiredTitles).map(([id, titles]) => [id, titles.map((title) => {
  const matches = rows.filter((row) => row.fullName.endsWith(title));
  assert.equal(matches.length, 1, `REQUIRED_TITLE:${title}`);
  return matches[0];
})]));
for (const [id, value] of Object.entries(bindings)) assert.equal(value.length, requiredTitles[id].length, id);
write(`${directory}/frozen-discovery.json`, discovery);
const cases = [
  ["unit", "src/server/services/planner-service.test.ts", businessDenominators[0], "A standard requirement yields a bound summary draft and handoff without planJson."],
  ["integration", "src/server/services/planner-service.test.ts", businessDenominators[1], "Two destinations stay ordered and are not folded into one string."],
  ["reverse-destinations", "src/server/services/planner-service.test.ts", businessDenominators[2], "Empty destinations and a folded destination string fail before any model call."],
  ["reverse-conflict", "src/server/services/planner-service.test.ts", businessDenominators[3], "Wording that conflicts with the requirement is rejected."],
  ["reverse-schema", "src/server/services/planner-service.test.ts", businessDenominators[4], "A summary draft missing a required field fails schema validation."],
  ["negative-controls", "docs/phase-plans/verify-phase022.mjs", negatives.length, "Empty, folded, conflicting and schema mutations each fail one assertion."],
].map(([name, inputPath, denominator, expected], index) => ({
  testCaseId: ids[index],
  command: index < businessDenominators.length ? dedicatedCommand : "node docs/phase-plans/verify-phase022.mjs --negative-controls",
  denominator,
  inputPath,
  outputPath: `${directory}/${name}.json`,
  expected,
}));
const threshold = businessDenominators.reduce((total, value) => total + value, 0);
const plan = {
  phase: 22,
  attemptId,
  producer: "Phase022",
  consumers: ["Phase023", "Phase024"],
  scope: "Generate a TravelPlanSummaryDraft and planner handoff from an admitted TravelRequirement.",
  implementationContextId: "grok-native-root-phase022-20260925",
  phaseStartCommit: startCommit,
  testMode: "full",
  testModeReason: "No verified affected-test selector exists, and summary generation consumes the shared TravelRequirement contract plus the activated planner.generate prompt.",
  crossAttemptReuse: "disabled",
  engineeringRegression: {
    mode: "full",
    baseCommit: startCommit,
    fullCommand: "npm run test",
    dedicatedCardCommand: dedicatedCommand,
    discovery: "vitest list --json; exact file/fullName equality, no skipped or zero tests",
  },
  requiredCaseIds: ids,
  cases,
  threshold: { originalThreshold: threshold, automatedThreshold: threshold, requiredPassRate: 1, waived: false },
  negativeControls: negatives.map((item) => item.id),
  sourcePaths: sources,
  fixtureSourcePaths: fixtureFiles(),
  modificationScope: [
    "src/server/services/planner-service.ts",
    "src/server/services/planner-service.test.ts",
    "src/lib/ai/prompts/planner-generate.ts",
    "docs/phase-plans/Phase022.json",
    receiptPath,
    "docs/phase-plans/prepare-phase022.mjs",
    "docs/phase-plans/verify-phase022.mjs",
    "docs/phase-plans/complete-phase022.mjs",
    "docs/phase-plans/phase022-evidence.mjs",
    "docs/evidence/attempts/Phase022/",
  ],
  notApplicable: ["No daily itinerary, TravelPlanVersion, result page, map, live provider or production traffic."],
  previousAttempts: [],
  supportingChecks: ["schema", "typecheck", "lint", "format", "layout", "whitespace", "build", "full-regression", "dedicated-card", "negative-controls", "secret-scan"],
  assertionBindings: bindings,
  discoverySnapshot: { path: `${directory}/frozen-discovery.json`, sha256: hash(`${directory}/frozen-discovery.json`), discovered: discovery.length },
  executionFreeze: { frozenAt: new Date().toISOString(), crossAttemptReuse: "disabled" },
};
requirePlan(plan, { hash, json });
write(planPath, plan, false);
write(`${directory}/frozen-plan.json`, read(planPath));
write(`${directory}/source-basis.json`, { planHash: hash(planPath), sourceHashes: Object.fromEntries(sources.map((file) => [file, hash(file)])) });
console.log(JSON.stringify({ status: "FROZEN", attemptId, discovered: discovery.length, sources: sources.length, threshold }));
