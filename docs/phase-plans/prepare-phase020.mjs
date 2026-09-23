import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as runtime from "./phase018-runtime.mjs";
import { dedicatedCommand, ids, planPath, receiptPath, requireInputs, requirePlan, startCommit } from "./phase020-evidence.mjs";

const { command, environment, fixtureFiles, git, hash, json, read, root, sourceFiles, write } = runtime;
const attemptId = process.argv[2] ?? "attempt-1";
assert.match(attemptId, /^attempt-\d+$/);
const directory = `docs/evidence/attempts/Phase020/${attemptId}`;
assert(!fs.existsSync(path.join(root, directory, "frozen-plan.json")), "ATTEMPT_ALREADY_FROZEN");
if (!fs.existsSync(path.join(root, receiptPath))) {
  const previous = json("docs/phase-plans/Phase019-inputs.json");
  const state = json("docs/roadmap-run.json");
  assert.equal(state.completedThrough, 19);
  const receipt = { ...previous, phase: 20, phaseStartCommit: startCommit, requestedThrough: 20, prerequisites: { ...state.checkpoints.at(-1), metadataCommit: startCommit }, preflight: { mode: "NEW_PHASE020", head: git(["rev-parse", "HEAD"]).trim(), originMain: git(["rev-parse", "origin/main"]).trim(), porcelain: git(["status", "--porcelain=v1", "--untracked-files=all"]).trim(), branch: git(["branch", "--show-current"]).trim() }, recovery: null };
  delete receipt.recovery;
  requireInputs(receipt, { hash, git, json });
  write(receiptPath, receipt);
}
requireInputs(json(receiptPath), { hash, git, json });
const sources = [...new Set([...sourceFiles(), ...fixtureFiles(), receiptPath, "docs/testing-execution-policy.md", "docs/development-execution-policy.md", "docs/agent-execution-contract.md", "docs/project-constitution.md", "docs/phase-plans/phase018-runtime.mjs", "docs/phase-plans/phase018-evidence.mjs", "docs/phase-plans/Phase019.json", "docs/phase-plans/Phase019-inputs.json", ...["prepare", "verify", "complete"].map((name) => `docs/phase-plans/${name}-phase020.mjs`), "docs/phase-plans/phase020-evidence.mjs", "docs/phase-plans/Phase020.json", ".gitattributes", ".gitignore", ".prettierignore", ".prettierrc.json", "eslint.config.mjs", "next.config.ts", "postcss.config.mjs"])].sort();
const scratch = `.scaffold/phase020/${attemptId}-discovery.json`;
const collected = command(process.execPath, ["node_modules/vitest/vitest.mjs", "list", "--json", scratch], { env: environment(), timeoutMs: 180000 });
assert.equal(collected.exitCode, 0, collected.stderr);
const discovery = json(scratch);
const rows = discovery.map((row) => ({ file: path.relative(root, row.file).replaceAll("\\", "/"), fullName: row.name.replaceAll(" > ", " ") }));
const requiredTitles = {
  "Phase020:travelers": ["带爸妈不证明老人年龄", "情侣标记两名年龄明确的成人", "一家三口只确定总数", "毕业旅行四个人不猜测年龄组"],
  "Phase020:budget": ["预算一万转为十进制字符串且不猜测币种", "人均3000元区分人均和币种", "预算低一点映射预算等级", "预算未提及保持空预算"],
  "Phase020:preferences": ["拍照日出归一化为摄影", "不想太累进入避免项", "美食和 City Walk 保持枚举并去重", "无特殊偏好返回空数组"],
  "Phase020:guarded-calls": ["guarded call: 带爸妈人均预算和美食", "guarded call: 情侣预算一万不猜测币种"],
};
const bindings = Object.fromEntries(Object.entries(requiredTitles).map(([id, titles]) => [id, titles.map((title) => {
  const matches = rows.filter((row) => row.fullName.endsWith(title));
  assert.equal(matches.length, 1, `REQUIRED_TITLE:${title}`);
  return matches[0];
})]));
for (const [id, value] of Object.entries(bindings)) assert(value.length >= (id.endsWith("guarded-calls") ? 2 : 4), id);
write(`${directory}/frozen-discovery.json`, discovery);
const cases = [
  ["travelers", "tests/nlu/travelers.test.ts", 4, "Parents do not prove elder age; couple, family and graduation counts stay consistent."],
  ["budget", "tests/nlu/budget.test.ts", 4, "Chinese amounts become canonical decimals and currency stays null unless explicit."],
  ["preferences", "tests/nlu/preferences.test.ts", 4, "Interests normalize to the frozen vocabulary and avoid remains an array."],
  ["guarded-calls", "tests/nlu/parameter-calls.test.ts", 2, "The two required mixed sentences resolve through the guarded parameter prompt."],
  ["negative-controls", "docs/phase-plans/verify-phase020.mjs", 3, "Amount, elder and avoid mutations each fail one targeted assertion before restoration."],
].map(([name, inputPath, denominator, expected], index) => ({ testCaseId: ids[index], command: index < 4 ? dedicatedCommand : "node docs/phase-plans/verify-phase020.mjs --negative-controls", denominator, inputPath, outputPath: `${directory}/${name}.json`, expected }));
const previousAttempts = fs.existsSync(path.join(root, planPath)) ? (() => { const previous = json(planPath); return [...(previous.previousAttempts ?? []), { attemptId: previous.attemptId, planPath: `docs/evidence/attempts/Phase020/${previous.attemptId}/frozen-plan.json`, planHash: hash(planPath), status: "FAIL" }]; })() : [];
const plan = { phase: 20, attemptId, producer: "Phase020", consumers: ["Phase021", "Phase022", "Phase023", "Phase024"], scope: "Parse travelers, budget and preferences into partial TravelRequirement fields without merging a snapshot.", implementationContextId: "codex-native-root-phase020-20260923", phaseStartCommit: startCommit, testMode: "full", testModeReason: "Parameter extraction changes the shared nlu.extract prompt activation and AI call boundary, so repository-wide regression is required.", crossAttemptReuse: "disabled", engineeringRegression: { mode: "full", baseCommit: startCommit, fullCommand: "npm run test", dedicatedCardCommand: dedicatedCommand, discovery: "vitest list --json; exact file/fullName equality, no skipped or zero tests" }, requiredCaseIds: ids, cases, threshold: { originalThreshold: 12, automatedThreshold: 12, requiredPassRate: 1, waived: false }, negativeControls: ["amount-parser-removal", "elder-removal", "avoid-removal"], sourcePaths: sources, fixtureSourcePaths: fixtureFiles(), modificationScope: ["src/server/services/nlu/", "tests/nlu/", "tests/phase016/chat-session.test.ts", "docs/phase-plans/Phase020.json", receiptPath, "docs/phase-plans/prepare-phase020.mjs", "docs/phase-plans/verify-phase020.mjs", "docs/phase-plans/complete-phase020.mjs", "docs/phase-plans/phase020-evidence.mjs", "docs/evidence/attempts/Phase020/"], notApplicable: ["No API/UI, requirement merge, readiness, recommendation, payment, live price lookup, private credentials or production provider."], previousAttempts, supportingChecks: ["schema", "typecheck", "lint", "format", "layout", "whitespace", "guards", "build", "full-regression", "dedicated-card", "negative-controls", "secret-scan"], assertionBindings: bindings, discoverySnapshot: { path: `${directory}/frozen-discovery.json`, sha256: hash(`${directory}/frozen-discovery.json`), discovered: discovery.length }, executionFreeze: { frozenAt: new Date().toISOString(), crossAttemptReuse: "disabled" } };
requirePlan(plan, { hash, json });
write(planPath, plan, false);
write(`${directory}/frozen-plan.json`, read(planPath));
write(`${directory}/source-basis.json`, { planHash: hash(planPath), sourceHashes: Object.fromEntries(sources.map((file) => [file, hash(file)])) });
console.log(JSON.stringify({ status: "FROZEN", attemptId, discovered: discovery.length, sources: sources.length }));
