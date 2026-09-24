import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { environment, root as projectRoot } from "../docs/phase-plans/phase018-runtime.mjs";

const root = projectRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = path.join(root, ".scaffold/tools/node_modules/npm/bin/npm-cli.js");
const schemaPath = path.join(root, "src/lib/ai/schemas.ts");
const env = { ...process.env, ...environment() };

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} exited ${result.status}`);
  }
}

const groups = [
  ["phase019", ["nlu/origin", "nlu/destinations", "nlu/date-range"]],
  ["phase020", ["nlu/travelers", "nlu/budget", "nlu/preferences", "nlu/parameter-calls"]],
  ["phase021", ["nlu/constraints", "nlu/missing-fields", "nlu/merge", "nlu/ask", "nlu/process"]],
];

run(["scripts/generate-ai-schemas.mjs", "--check"]);
for (const [name, selectors] of groups) {
  process.stdout.write(`verify-phase021:${name}\n`);
  run([npmCli, "run", "test", "--", ...selectors]);
}
const schemaHash = createHash("sha256").update(fs.readFileSync(schemaPath)).digest("hex");
process.stdout.write(
  `${JSON.stringify({ status: "PASS", schema: "src/lib/ai/schemas.ts", schemaHash, groups: groups.map(([name]) => name) })}\n`,
);
