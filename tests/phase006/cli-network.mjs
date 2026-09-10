import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  root,
  directory,
  command,
  environment,
  hash,
  write,
  prismaCli,
} from "../../docs/phase-plans/phase006-runtime.mjs";

assert.equal(environment().CHECKPOINT_DISABLE, "1");
const guard = path.join(root, "tests/phase006/cli-network-guard.cjs").replaceAll("\\", "/");
assert(!guard.includes('"'));
const reports = [];
for (const label of ["disabled", "mutation-enable-checkpoint"]) {
  const fixture = path.join(root, ".scaffold/phase006/network", path.basename(directory), label);
  fs.mkdirSync(fixture, { recursive: true });
  const log = path.join(fixture, "network.jsonl");
  fs.writeFileSync(log, "", { flag: "wx" });
  const cache = path.join(fixture, "cache");
  fs.mkdirSync(cache, { recursive: true });
  const extra = {
    NODE_OPTIONS: `--require "${guard}"`,
    PHASE006_NETWORK_LOG: log,
    APPDATA: cache,
    LOCALAPPDATA: cache,
    XDG_CACHE_HOME: cache,
    // Keep the telemetry endpoint at its library default. The preload blocks public I/O.
    PRISMA_TELEMETRY_ENDPOINT: undefined,
  };
  if (label === "mutation-enable-checkpoint") {
    extra.CHECKPOINT_DISABLE = "";
    extra.CHECKPOINT_DISABLE_TELEMETRY = "1";
  }
  const result = await command(
    `Prisma validate with inherited network guard: ${label}`,
    [prismaCli, "validate", "--schema", path.join(root, "prisma/schema.prisma")],
    { cwd: fixture, env: extra },
  );
  // Checkpoint forks are detached; allow their bounded startup/exit to reach the append-only log.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const events = fs
    .readFileSync(log, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const publicAttempts = events.filter(
    (event) => event.kind === "request" && event.blockedBeforeNetwork,
  );
  const children = events.filter(
    (event) => event.kind === "process" && event.pid !== events[0].pid,
  );
  assert(events.some((event) => event.kind === "process" && event.program === "index.js"));
  if (label === "disabled") {
    assert.deepEqual(publicAttempts, [], "The normal helper must prevent public requests");
    assert.deepEqual(children, [], "Prisma must not launch its checkpoint child when disabled");
  } else {
    assert(children.length > 0, "The probe must observe the real forked child");
    assert(
      publicAttempts.some((event) => event.hostname === "checkpoint.prisma.io"),
      "The guard must detect the actual checkpoint request when the switch is removed",
    );
  }
  reports.push({ label, result, events, publicAttempts, childProcesses: children.length });
}
write(`${directory}/cli-network.json`, {
  status: "PASS",
  guardPath: "tests/phase006/cli-network-guard.cjs",
  guardHash: hash("tests/phase006/cli-network-guard.cjs"),
  prismaCliHash: hash("node_modules/prisma/build/index.js"),
  reports,
  publicRequestsCompleted: 0,
  productionTraffic: false,
  scope: "ACTUAL_PRISMA_CLI_AND_FORKED_CHECKPOINT_PROCESS",
});
console.warn(JSON.stringify({ status: "PASS", probes: reports.length, productionTraffic: false }));
