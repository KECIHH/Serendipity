import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { scanAiBoundary } from "../phase015/import-boundary";
const output = process.argv[process.argv.indexOf("--output") + 1];
assert(output && output !== process.argv[0]);
const violations = scanAiBoundary();
assert.deepEqual(violations, []);
function inventory(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((row) =>
      row.isDirectory()
        ? inventory(path.join(dir, row.name))
        : [path.join(dir, row.name).replaceAll("\\", "/")],
    );
}
const files = inventory("src"),
  routes = files.filter((file) => /\/api\/(?:chat|nlu|plan\/generate)(?:\/|\.)/.test(file));
assert.deepEqual(routes, []);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(
  output,
  JSON.stringify(
    {
      phase: 16,
      status: "PASS",
      filesScanned: files.length,
      violations,
      legacyRouteSources: routes,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
console.log(JSON.stringify({ status: "PASS", filesScanned: files.length, violations: 0 }));
