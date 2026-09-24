import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as runtime from "./phase018-runtime.mjs";
import { dedicatedCommand, ids, planPath, receiptPath, requireInputs, requirePlan, startCommit } from "./phase021-evidence.mjs";

const { command, environment, fixtureFiles, git, hash, json, read, root, sourceFiles, write } = runtime;
const attemptId = process.argv[2] ?? "attempt-1";
assert.match(attemptId, /^attempt-\d+$/);
const directory = `docs/evidence/attempts/Phase021/${attemptId}`;
assert(!fs.existsSync(path.join(root, directory, "frozen-plan.json")), "ATTEMPT_ALREADY_FROZEN");
if (!fs.existsSync(path.join(root, receiptPath))) {
  const previous = json("docs/phase-plans/Phase020-inputs.json");
  const state = json("docs/roadmap-run.json");
  assert.equal(state.completedThrough, 20);
  const receipt = { ...previous, phase: 21, phaseStartCommit: startCommit, requestedThrough: 21, prerequisites: { ...state.checkpoints.at(-1), metadataCommit: startCommit }, preflight: { mode: "NEW_PHASE021", head: git(["rev-parse", "HEAD"]).trim(), originMain: git(["rev-parse", "origin/main"]).trim(), porcelain: git(["status", "--porcelain=v1", "--untracked-files=all"]).trim(), branch: git(["branch", "--show-current"]).trim() }, recovery: null };
  delete receipt.recovery;
  requireInputs(receipt, { hash, git, json });
  write(receiptPath, receipt);
}
requireInputs(json(receiptPath), { hash, git, json });
const sources = [...new Set([...sourceFiles(), ...fixtureFiles(), receiptPath, "docs/testing-execution-policy.md", "docs/development-execution-policy.md", "docs/agent-execution-contract.md", "docs/project-constitution.md", "docs/phase-plans/phase018-runtime.mjs", "docs/phase-plans/phase018-evidence.mjs", "docs/phase-plans/Phase020.json", "docs/phase-plans/Phase020-inputs.json", ...["prepare", "verify", "complete"].map((name) => `docs/phase-plans/${name}-phase021.mjs`), "docs/phase-plans/phase021-evidence.mjs", "docs/phase-plans/Phase021.json", "scripts/verify-phase021.mjs", ".gitattributes", ".gitignore", ".prettierignore", ".prettierrc.json", "eslint.config.mjs", "next.config.ts", "postcss.config.mjs"])].sort();
const scratch = `.scaffold/phase021/${attemptId}-discovery.json`;
const collected = command(process.execPath, ["node_modules/vitest/vitest.mjs", "list", "--json", scratch], { env: environment(), timeoutMs: 180000 });
assert.equal(collected.exitCode, 0, collected.stderr);
const discovery = json(scratch);
const rows = discovery.map((row) => ({ file: path.relative(root, row.file).replaceAll("\\", "/"), fullName: row.name.replaceAll(" > ", " ") }));
const requiredTitles = {
  "Phase021:constraints": ["新疆自驾标记自驾且不猜测海外", "武功山徒步标记徒步", "飞去日本在国家明确时标记海外", "高铁去云南标记高铁且国内"],
  "Phase021:missing": ["缺少目的地是阻断项", "缺少时间在精确模式阻断", "自驾但安全能力未知时阻断", "预算缺失但可先规划"],
  "Phase021:merge": ["首轮输入", "第二轮补充时间", "覆盖目的地", "数组 add 去重", "数组 remove", "显式 clear", "同 patch 重放", "stale baseRevision"],
  "Phase021:ask": ["3个缺失生成3个问题", "5个缺失只生成3个问题", "blocking优先"],
  "Phase021:process": ["从一句话到追问回答后生成完整 JSON", "quick模式江西上饶可规划且precise追问日期", "取消后下游调用为零且缺目的地阻断"],
};
const bindings = Object.fromEntries(Object.entries(requiredTitles).map(([id, titles]) => [id, titles.map((title) => {
  const matches = rows.filter((row) => row.fullName.endsWith(title));
  assert.equal(matches.length, 1, `REQUIRED_TITLE:${title}`);
  return matches[0];
})]));
for (const [id, value] of Object.entries(bindings)) assert.equal(value.length, requiredTitles[id].length, id);
write(`${directory}/frozen-discovery.json`, discovery);
const cases = [
  ["constraints", "tests/nlu/constraints.test.ts", 4, "Self-driving, hiking and overseas flags follow deterministic mapping."],
  ["missing", "tests/nlu/missing-fields.test.ts", 4, "Blocking, normal and optional gaps follow the frozen readiness policy."],
  ["merge", "tests/nlu/merge.test.ts", 8, "Patches keep the prior snapshot immutable and recalculate missing fields."],
  ["ask", "tests/nlu/ask.test.ts", 3, "At most three natural questions are shown, with blocking fields first."],
  ["process", "tests/nlu/process.test.ts", 3, "One guarded pass merges a requirement and derives confirmation status."],
  ["negative-controls", "docs/phase-plans/verify-phase021.mjs", 4, "Self-driving, destination blocking, missing recalculation and question limit mutations each fail one assertion."],
].map(([name, inputPath, denominator, expected], index) => ({ testCaseId: ids[index], command: index < 5 ? dedicatedCommand : "node docs/phase-plans/verify-phase021.mjs --negative-controls", denominator, inputPath, outputPath: `${directory}/${name}.json`, expected }));
const previousAttempts = fs.existsSync(path.join(root, planPath)) ? (() => { const previous = json(planPath); return [...(previous.previousAttempts ?? []), { attemptId: previous.attemptId, planPath: `docs/evidence/attempts/Phase021/${previous.attemptId}/frozen-plan.json`, planHash: hash(planPath), status: "FAIL" }]; })() : [];
const plan = { phase: 21, attemptId, producer: "Phase021", consumers: ["Phase022", "Phase023", "Phase024", "Phase027"], scope: "Recognize constraints, missing fields and merge multi-turn TravelRequirement snapshots.", implementationContextId: "grok-native-root-phase021-20260924", phaseStartCommit: startCommit, testMode: "full", testModeReason: "Constraint extraction changes the shared nlu.extract prompt activation and requirement merge boundary, so repository-wide regression is required.", crossAttemptReuse: "disabled", engineeringRegression: { mode: "full", baseCommit: startCommit, fullCommand: "npm run test", dedicatedCardCommand: dedicatedCommand, discovery: "vitest list --json; exact file/fullName equality, no skipped or zero tests" }, requiredCaseIds: ids, cases, threshold: { originalThreshold: 22, automatedThreshold: 22, requiredPassRate: 1, waived: false }, negativeControls: ["self-driving-removal", "destination-blocking-removal", "missing-recalc-removal", "question-limit-removal"], sourcePaths: sources, fixtureSourcePaths: fixtureFiles(), modificationScope: ["src/server/services/nlu/", "src/lib/ai/prompts/nlu-ask-missing.ts", "tests/nlu/", "scripts/verify-phase021.mjs", "package.json", "docs/phase-plans/Phase021.json", receiptPath, "docs/phase-plans/prepare-phase021.mjs", "docs/phase-plans/verify-phase021.mjs", "docs/phase-plans/complete-phase021.mjs", "docs/phase-plans/phase021-evidence.mjs", "docs/evidence/attempts/Phase021/"], notApplicable: ["No NLU API, follow-up UI, itinerary generation, maps, live transport, payment or production provider."], previousAttempts, supportingChecks: ["schema", "typecheck", "lint", "format", "layout", "whitespace", "guards", "build", "full-regression", "dedicated-card", "negative-controls", "secret-scan"], assertionBindings: bindings, discoverySnapshot: { path: `${directory}/frozen-discovery.json`, sha256: hash(`${directory}/frozen-discovery.json`), discovered: discovery.length }, executionFreeze: { frozenAt: new Date().toISOString(), crossAttemptReuse: "disabled" } };
requirePlan(plan, { hash, json });
write(planPath, plan, false);
write(`${directory}/frozen-plan.json`, read(planPath));
write(`${directory}/source-basis.json`, { planHash: hash(planPath), sourceHashes: Object.fromEntries(sources.map((file) => [file, hash(file)])) });
console.log(JSON.stringify({ status: "FROZEN", attemptId, discovered: discovery.length, sources: sources.length }));
