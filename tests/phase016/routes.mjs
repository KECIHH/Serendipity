import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const output = process.argv[process.argv.indexOf("--output") + 1];
assert(output && output !== process.argv[0]);
const reservation = net.createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`,
  startedAt = new Date().toISOString();
const server = spawn(
  process.execPath,
  ["--import", "tsx", "scripts/auth-server.mjs", "--port", String(port)],
  {
    env: { ...process.env, AUTH_URL: origin, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let ready = false,
  closed = false;
server.stdout.on("data", (chunk) => {
  if (chunk.toString().includes("Serendipity listening")) ready = true;
});
server.stderr.on("data", () => {});
server.on("exit", () => {
  closed = true;
});
try {
  const until = Date.now() + 30000;
  while (!ready) {
    assert(!closed && Date.now() < until, "Compiled Next server did not start");
    await delay(100);
  }
  const rows = [];
  for (const route of [
    "/api/chat",
    "/api/nlu/parse",
    "/api/nlu/extract",
    "/api/plan/generate",
    "/api/session/anonymous",
    "/api/travel-records/synthetic/commands",
  ])
    for (const method of ["GET", "POST"]) {
      const response = await fetch(origin + route, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      });
      await response.arrayBuffer();
      assert.equal(response.status, 404, `${method} ${route}`);
      rows.push({ method, path: route, status: response.status });
    }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(
    output,
    JSON.stringify(
      {
        phase: 16,
        status: "PASS",
        startedAt,
        finishedAt: new Date().toISOString(),
        realNextHttp: true,
        synthetic: true,
        productionTraffic: false,
        requests: rows.length,
        legacyRoutes: 0,
        prematureRoutes: 0,
        rows,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({ status: "PASS", requests: rows.length, legacyRoutes: 0, prematureRoutes: 0 }),
  );
} finally {
  server.kill("SIGKILL");
  const until = Date.now() + 5000;
  while (!closed && Date.now() < until) await delay(25);
  assert(closed, "Fixture server did not stop");
}
