import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Static route and duplicate-implementation scan. It starts no server and writes no row. */
const output = process.argv[process.argv.indexOf("--output") + 1];
assert(output && output !== process.argv[0], "OUTPUT_REQUIRED");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function inventory(relative) {
  const start = path.join(root, relative);
  if (!fs.existsSync(start)) return [];
  return fs.readdirSync(start, { withFileTypes: true }).flatMap((entry) => {
    const child = `${relative}/${entry.name}`;
    return entry.isDirectory() ? inventory(child) : [child];
  });
}

const results = [];
function check(name, operation) {
  operation();
  results.push({ name, status: "PASS" });
}

check("no legacy src/pages router", () => {
  assert.equal(fs.existsSync(path.join(root, "src/pages")), false, "LEGACY_PAGES_ROUTER");
  assert.equal(fs.existsSync(path.join(root, "src/server/api")), false, "LEGACY_SERVER_API");
});

check("exactly one admin ai-debug page and three registered handlers", () => {
  const pages = inventory("src/app/admin").filter((file) =>
    file.endsWith("/ai-debug/page.tsx"),
  );
  assert.deepEqual(pages, ["src/app/admin/(protected)/ai-debug/page.tsx"], "DEBUG_PAGE_COUNT");
  const handlers = inventory("src/app/api/admin/ai-debug").filter((file) =>
    file.endsWith("route.ts"),
  );
  assert.deepEqual(handlers.sort(), [
    "src/app/api/admin/ai-debug/runs/[id]/route.ts",
    "src/app/api/admin/ai-debug/stream/route.ts",
    "src/app/api/admin/ai-debug/test/route.ts",
  ]);
});

check("forbidden legacy and premature routes stay absent", () => {
  const routes = inventory("src/app/api").map((file) => file.replace(/^src\/app/, ""));
  for (const forbidden of [
    "/api/chat",
    "/api/nlu/parse",
    "/api/nlu/extract",
    "/api/plan/generate",
  ])
    assert(!routes.some((route) => route.startsWith(`${forbidden}/`)), `FORBIDDEN_ROUTE:${forbidden}`);
});

check("the Mock provider stays a single class and factory", () => {
  const definitions = inventory("src")
    .filter((file) => /\.tsx?$/.test(file))
    .flatMap((file) => {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      return [...text.matchAll(/class\s+(\w*Mock\w*Provider)/g)].map((match) => `${file}:${match[1]}`);
    });
  assert.deepEqual(definitions, ["src/server/ai/mock-provider.ts:MockAiProvider"], "MOCK_IMPLEMENTATION");
});

check("the debug surface never selects a deployment, provider or secret from the client", () => {
  const client = fs.readFileSync(path.join(root, "src/components/admin/ai-debug-client.tsx"), "utf8");
  assert(
    client.includes("JSON.stringify({ promptKey, variables: parsedVariables, failureProfile })"),
    "CLIENT_REQUEST_BODY",
  );
  for (const forbidden of ["baseUrl", "secretRef", "apiKey", "systemPrompt", "encryptedKey"])
    assert(!client.includes(forbidden), `CLIENT_SELECTION:${forbidden}`);
  // Deployment identity may only be displayed as a read-only version summary.
  assert.equal((client.match(/deploymentId/g) ?? []).length, 1, "CLIENT_DEPLOYMENT_READONLY");
  const dto = fs.readFileSync(path.join(root, "src/lib/ai-debug.ts"), "utf8");
  assert(dto.includes('REQUEST_KEYS = ["promptKey", "variables", "failureProfile"]'), "DTO_KEYS");
});

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(
  output,
  JSON.stringify(
    {
      phase: 18,
      status: "PASS",
      realNextHttp: false,
      synthetic: true,
      productionTraffic: false,
      caseCount: results.length,
      legacyRoutes: 0,
      prematureRoutes: 0,
      duplicateMockImplementations: 0,
      results,
      finishedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
console.log(JSON.stringify({ status: "PASS", caseCount: results.length }));
