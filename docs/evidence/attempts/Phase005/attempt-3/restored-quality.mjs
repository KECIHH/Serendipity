import assert from "node:assert/strict";
import {
  plan, planPath, directory, hash, write, npm, command, startServer, httpMatrix,
} from "../../../../phase-plans/phase005-runtime.mjs";

const scriptPath = "docs/evidence/attempts/Phase005/attempt-3/restored-quality.mjs";
assert.equal(plan.attemptId, "attempt-3");
const sourceHashes = Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(file)]));
const commands = [];
for (const name of ["lint", "format:check", "test", "build", "typecheck", "verify:phase003"]) {
  commands.push(await npm(["run", name]));
}
commands.push(await command("node scripts/check-project-layout.mjs", ["scripts/check-project-layout.mjs"]));
const server = await startServer("production");
let rows;
try { rows = await httpMatrix(server.baseUrl, [["/admin", 404], ["/admin/settings", 404], ["/", 200]]); }
finally { await server.stop(); }
for (const [file, expected] of Object.entries(sourceHashes)) assert.equal(hash(file), expected);
write(`${directory}/restored-quality.json`, {
  status: "PASS", phase: 5, attemptId: plan.attemptId, planPath, planHash: hash(planPath),
  scriptPath, scriptHash: hash(scriptPath), sourceHashes, commands, rows, server: server.observation,
  requiredQualityCommands: { numerator: 6, denominator: 6 }, productionMatrix: { numerator: 3, denominator: 3 },
  isolation: "SYNTHETIC_LOCAL_PROCESS_AFTER_ALL_TEMPORARY_MUTATIONS_RESTORED", productionTraffic: false,
  generatedAt: new Date().toISOString(),
});
console.warn(JSON.stringify({ status: "RESTORED_QUALITY_PASS", commands: 6, productionPaths: 3 }));
