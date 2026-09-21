import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const run = (file) => spawnSync("npx", ["vitest", "run", file], { cwd: root, encoding: "utf8" });
const mutate = (file, replacement) => {
  const target = path.join(root, file);
  const original = fs.readFileSync(target, "utf8");
  assert.equal(original.indexOf(replacement.from), original.lastIndexOf(replacement.from), `anchor:${file}`);
  fs.writeFileSync(target, original.replace(replacement.from, replacement.to), "utf8");
  try {
    const result = run(replacement.test);
    assert.notEqual(result.status, 0, `NEGATIVE_UNEXPECTEDLY_GREEN:${file}`);
    return { file, test: replacement.test, status: "PASS", observedExitCode: result.status };
  } finally {
    fs.writeFileSync(target, original, "utf8");
  }
};

if (!process.argv.includes("--negative-controls")) throw new Error("Use --negative-controls");
const controls = [
  mutate("src/server/services/nlu/date-parser.ts", {
    from: 'if (/这周末|本周末/.test(value)) {',
    to: 'if (false && /这周末|本周末/.test(value)) {',
    test: "tests/nlu/date-range.test.ts",
  }),
  mutate("src/server/services/nlu/extract-core-entities.ts", {
    from: 'return { city: text, country: "CN", confidence: confidence(score) };',
    to: 'return { city: text, country: "CN" };',
    test: "tests/nlu/origin.test.ts",
  }),
  mutate("src/server/services/nlu/extract-core-entities.ts", {
    from: '.map((item, index) => destination(item.name, index, item.confidence));',
    to: '.map((item, index) => destination(item.name, index, item.confidence)).reverse();',
    test: "tests/nlu/destinations.test.ts",
  }),
];
console.log(JSON.stringify({ status: "PASS", controls, restoredRun: "PASS" }));
