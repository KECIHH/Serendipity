import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const registryMarkers = ["<!-- api-registry:start -->", "<!-- api-registry:end -->"];
export const columns = [
  "operationId",
  "method",
  "path",
  "auth",
  "request",
  "response",
  "errors",
  "idempotency",
  "cas",
  "producerPhase",
];
export const forbiddenRoutes = ["/api/nlu/parse", "/api/nlu/extract", "/api/plan/generate"];

export function validateRegistry(manifest) {
  const ids = new Set();
  const routes = new Set();
  const routeShapes = new Set();
  assert.ok(Array.isArray(manifest.apiRegistry), "manifest.apiRegistry must be an array");
  for (const operation of manifest.apiRegistry) {
    for (const column of columns)
      assert.ok(
        operation[column] !== undefined && operation[column] !== "",
        `${operation.operationId}: missing ${column}`,
      );
    assert.ok(
      Array.isArray(operation.errors) && operation.errors.length,
      `${operation.operationId}: errors must be explicit`,
    );
    assert.ok(
      operation.errors.every((code) => /^[A-Z][A-Z0-9_]+$/.test(code)),
      `API_INVALID_ERROR: ${operation.operationId}`,
    );
    assert.equal(
      new Set(operation.errors).size,
      operation.errors.length,
      `API_DUPLICATE_ERROR: ${operation.operationId}`,
    );
    assert.ok(
      Number.isInteger(operation.producerPhase) &&
        operation.producerPhase >= 0 &&
        operation.producerPhase <= 137,
      "Invalid producerPhase",
    );
    assert.ok(
      ["GET", "POST", "PATCH", "PUT", "DELETE"].includes(operation.method),
      `API_INVALID_METHOD: ${operation.operationId}`,
    );
    assert.match(operation.operationId, /^[A-Za-z][A-Za-z0-9.-]*$/, "API_INVALID_OPERATION_ID");
    assert.ok(
      ["NONE", "COOKIE_REUSE", "HEADER_OWNER_OPERATION"].includes(operation.idempotency),
      `API_INVALID_IDEMPOTENCY: ${operation.operationId}`,
    );
    assert.ok(
      typeof operation.auth === "string" && operation.auth.trim(),
      `API_INVALID_AUTH: ${operation.operationId}`,
    );
    assert.ok(!ids.has(operation.operationId), `API_DUPLICATE_OPERATION: ${operation.operationId}`);
    const key = `${operation.method} ${operation.path}`;
    assert.ok(!routes.has(key), `API_DUPLICATE_ENDPOINT: ${key}`);
    assert.ok(!forbiddenRoutes.includes(operation.path), `API_FORBIDDEN_ROUTE: ${key}`);
    assert.equal(
      operation.sourceContract,
      `roadmapRoot/Phase${String(operation.producerPhase).padStart(3, "0")}.md`,
      `${key}: API_PRODUCER_MISMATCH`,
    );
    assert.equal(operation.contractRef, "projectRoot/docs/api.md", `API_CONTRACT_OWNER: ${key}`);
    assert.match(
      operation.path,
      /^\/api(?:\/(?:[A-Za-z0-9.-]+|\{[A-Za-z][A-Za-z0-9]*\}))+$/,
      "Noncanonical API path",
    );
    const routeShape = `${operation.method} ${operation.path.replace(/\{[^}]+\}/g, "{}")}`;
    assert.ok(!routeShapes.has(routeShape), `API_DUPLICATE_ROUTE_SHAPE: ${key}`);
    const parameters = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    assert.equal(
      new Set(parameters).size,
      parameters.length,
      `API_DUPLICATE_PATH_PARAMETER: ${key}`,
    );
    const evolution = operation.evolvesAt || [];
    assert.ok(
      Array.isArray(evolution) &&
        evolution.every(
          (phase) => Number.isInteger(phase) && phase > operation.producerPhase && phase <= 137,
        ),
      `API_INVALID_EVOLUTION: ${key}`,
    );
    assert.equal(new Set(evolution).size, evolution.length, `API_DUPLICATE_EVOLUTION: ${key}`);
    ids.add(operation.operationId);
    routes.add(key);
    routeShapes.add(routeShape);
  }
  assert.equal(manifest.apiPolicy.authority, "apiRegistry", "API_REGISTRY_AUTHORITY");
  assert.deepEqual(
    manifest.apiPolicy.authFramework,
    {
      producerPhase: 11,
      handler: "Auth.js GET/POST /api/auth/[...nextauth]",
      businessAliasAllowed: false,
    },
    "API_FRAMEWORK_BOUNDARY",
  );
  assert.deepEqual(
    manifest.apiPolicy.idempotency.scope,
    ["serverDerivedOwner", "operationId", "resourceId"],
    "API_IDEMPOTENCY_SCOPE",
  );
  assert.equal(
    manifest.apiPolicy.idempotency.minimumRetentionHours,
    24,
    "API_IDEMPOTENCY_RETENTION",
  );
  assert.equal(
    manifest.apiPolicy.idempotency.activeOperationNeverExpires,
    true,
    "API_ACTIVE_RECEIPT_RETENTION",
  );
  assert.equal(
    manifest.apiPolicy.idempotency.domainReceiptsRetainedWithAggregate,
    true,
    "API_DOMAIN_RECEIPT_RETENTION",
  );
  assert.equal(manifest.apiPolicy.publicDenial.httpStatus, 404, "API_PUBLIC_DENIAL");
  assert.equal(manifest.apiPolicy.publicDenial.code, "NOT_FOUND", "API_PUBLIC_DENIAL");
  assert.deepEqual(
    manifest.apiPolicy.publicDenial.reasons,
    ["absent", "unauthorized", "revoked", "expired", "feature-disabled"],
    "API_PUBLIC_DENIAL_REASONS",
  );
  assert.equal(
    manifest.apiPolicy.errorPolicy.operationErrorsAreAdditional,
    true,
    "API_COMMON_ERROR_BOUNDARY",
  );
  return { registryCount: ids.size, duplicateEndpoints: 0 };
}

export function loadRegistry(root) {
  const layout = JSON.parse(readFileSync(path.join(root, "docs/project-layout.json"), "utf8"));
  const inputs = JSON.parse(
    readFileSync(path.join(root, "docs/phase-plans/Phase002-inputs.json"), "utf8"),
  );
  const manifestRelativePath = `${layout.roadmapRoot}/docs/roadmap-execution-manifest.json`;
  const pins = new Map(
    inputs.pinnedInputs.map((input) => [input.path.replaceAll("\\", "/"), input]),
  );
  assert.equal(pins.size, inputs.pinnedInputs.length, "API_DUPLICATE_INPUT_PIN");
  const readPinned = (relativePath) => {
    const pin = pins.get(relativePath);
    assert.ok(pin, `API_INPUT_PIN_MISSING: ${relativePath}`);
    const bytes = readFileSync(path.join(root, relativePath));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      pin.sha256,
      `API_INPUT_HASH_DRIFT: ${relativePath}`,
    );
    return bytes;
  };
  const manifestPath = path.join(root, manifestRelativePath);
  const manifestBytes = readPinned(manifestRelativePath);
  const manifestHash = createHash("sha256").update(manifestBytes).digest("hex");
  assert.equal(inputs.manifestHash, manifestHash, "API_MANIFEST_HASH_DRIFT");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  validateRegistry(manifest);
  const producerInputs = [
    ...new Set([
      11,
      ...manifest.apiRegistry.flatMap((operation) => [
        operation.producerPhase,
        ...(operation.evolvesAt || []),
      ]),
    ]),
  ];
  for (const phase of producerInputs)
    readPinned(`${layout.roadmapRoot}/Phase${String(phase).padStart(3, "0")}.md`);
  return { manifest, manifestPath, manifestHash, producerInputCount: producerInputs.length };
}

function cell(value) {
  const plain = Array.isArray(value) ? value.join(", ") : String(value);
  return plain.replaceAll("|", "&#124;").replaceAll("\r", "").replaceAll("\n", "<br>");
}

export function renderRegistry(manifest) {
  const sorted = [...manifest.apiRegistry].sort((a, b) =>
    a.operationId.localeCompare(b.operationId, "en"),
  );
  return [
    registryMarkers[0],
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...sorted.map(
      (operation) => `| ${columns.map((column) => cell(operation[column])).join(" | ")} |`,
    ),
    registryMarkers[1],
  ].join("\n");
}

export function checkGeneratedRegistry(root, { write = false } = {}) {
  const { manifest, manifestPath, manifestHash, producerInputCount } = loadRegistry(root);
  const apiPath = path.join(root, "docs/api.md");
  const document = readFileSync(apiPath, "utf8");
  const [startMarker, endMarker] = registryMarkers;
  assert.equal(
    document.split(startMarker).length,
    2,
    "Exactly one registry start marker is required",
  );
  assert.equal(document.split(endMarker).length, 2, "Exactly one registry end marker is required");
  const start = document.indexOf(startMarker);
  const end = document.indexOf(endMarker) + endMarker.length;
  assert.ok(end > start, "Invalid registry marker order");
  const expected = renderRegistry(manifest);
  if (write)
    writeFileSync(apiPath, document.slice(0, start) + expected + document.slice(end), "utf8");
  else
    assert.equal(
      document.slice(start, end),
      expected,
      "API_GENERATED_TABLE_DRIFT: regenerate from the pinned manifest",
    );
  return {
    registryCount: manifest.apiRegistry.length,
    duplicateEndpoints: 0,
    manifestPath,
    manifestHash,
    producerInputCount,
    columns: [...columns],
    producerPhases: [...new Set(manifest.apiRegistry.map((item) => item.producerPhase))].sort(
      (a, b) => a - b,
    ),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const rootIndex = process.argv.indexOf("--root");
    const root =
      rootIndex < 0
        ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
        : path.resolve(process.argv[rootIndex + 1]);
    const write = process.argv.includes("--write");
    assert.ok(write !== process.argv.includes("--check"), "Use exactly one of --check or --write");
    console.warn(JSON.stringify(checkGeneratedRegistry(root, { write }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
