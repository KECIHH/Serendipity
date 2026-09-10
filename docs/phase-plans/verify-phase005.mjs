import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { format as prettierFormat, resolveConfig } from "prettier";
import { requireHashCoverage, requireReportBinding } from "../../scripts/phase-evidence.mjs";
import {
  root,
  plan,
  planPath,
  receiptPath,
  directory,
  read,
  json,
  hash,
  sha,
  write,
  git,
  command,
  npm,
  inventory,
  copyFixture,
  removeFixture,
  startServer,
  httpMatrix,
} from "./phase005-runtime.mjs";
import { browserLayout } from "../../tests/phase005/browser.mjs";

const sourceHashes = () => Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(file)]));
const suiteDefinitions = {
  "unit-format": ["src/lib/format.test.ts", 14],
  "unit-json": ["src/lib/json.test.ts", 4],
  "unit-api-response": ["src/lib/api-response.test.ts", 6],
  "unit-common-components": ["src/components/common/common-components.test.tsx", 8],
  "unit-layout": ["src/app/layout.test.ts", 2],
  "unit-middleware": ["src/middleware.test.ts", 8],
};
const productionRows = [
  ["/admin", 404],
  ["/admin/settings", 404],
  ["/", 200],
];

function parseTests(observation) {
  const start = observation.stdout.search(/\{\s*"numTotalTestSuites"/);
  assert(start >= 0, "Vitest did not emit its actual JSON report");
  return JSON.parse(observation.stdout.slice(start, observation.stdout.lastIndexOf("}") + 1));
}

async function runTests(file, minimum, cwd = root, expected = 0) {
  const observation = await npm(["run", "test", "--", ...(file ? [file] : []), "--reporter=json"], {
    cwd,
    expected: null,
  });
  const result = parseTests(observation);
  if (expected === 0) {
    if (observation.exitCode !== 0) {
      const error = new Error("Vitest failed");
      error.observation = observation;
      throw error;
    }
    assert.equal(result.success, true);
    assert.equal(result.numFailedTests, 0);
    assert.equal(result.numPendingTests, 0);
    assert(result.numPassedTests >= minimum);
    assert.equal(result.numPassedTests, result.numTotalTests);
    if (file)
      assert(result.testResults.some((test) => test.name.replaceAll("\\", "/").endsWith(file)));
    else
      for (const [requiredFile] of Object.values(suiteDefinitions))
        assert(
          result.testResults.some((test) => test.name.replaceAll("\\", "/").endsWith(requiredFile)),
          `Uncollected test file: ${requiredFile}`,
        );
  } else {
    assert(
      Number.isInteger(observation.exitCode) && observation.exitCode > 0,
      "Mutation did not fail",
    );
    assert(result.numFailedTests > 0, "Mutation failed before actual test assertions ran");
  }
  return {
    observation,
    testCount: result.numTotalTests,
    passed: result.numPassedTests,
    failed: result.numFailedTests,
    files: result.testResults.map((test) => ({
      file: path.relative(cwd, test.name).replaceAll("\\", "/"),
      status: test.status,
      assertions: test.assertionResults.map(({ fullName, status }) => ({ fullName, status })),
    })),
  };
}

function exportedNames(file) {
  const ast = ts.createSourceFile(
    file,
    read(file).toString(),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return ast.statements.flatMap((node) => {
    if (!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
      return [];
    if (node.name) return [node.name.text];
    return ts.isVariableStatement(node)
      ? node.declarationList.declarations.map((entry) => entry.name.getText(ast))
      : [];
  });
}

function structure() {
  const receipt = json(receiptPath);
  for (const file of plan.sourcePaths)
    assert(fs.existsSync(path.join(root, file)), `Missing source: ${file}`);
  const expectedExports = {
    "src/lib/format.ts": [
      "formatDateRange",
      "formatDuration",
      "formatMoney",
      "formatCostEstimate",
      "truncate",
    ],
    "src/lib/json.ts": ["safeJsonParse", "stableStringify"],
    "src/lib/api-response.ts": [
      "ApiResponse",
      "ApiError",
      "ApiErrorCode",
      "ok",
      "fail",
      "isApiError",
    ],
    "src/middleware.ts": ["isAdminPath", "middleware", "config"],
    "src/components/common/loading-state.tsx": ["LoadingState"],
    "src/components/common/empty-state.tsx": ["EmptyState"],
    "src/components/common/error-state.tsx": ["ErrorState"],
    "src/components/common/page-header.tsx": ["PageHeader"],
    "src/components/layout/site-header.tsx": ["SiteHeader"],
    "src/components/layout/admin-shell.tsx": ["AdminShell"],
  };
  for (const [file, names] of Object.entries(expectedExports))
    for (const name of names) assert(exportedNames(file).includes(name), `${file} export ${name}`);
  const directories = [
    "src/components/layout",
    "src/components/common",
    "src/components/travel",
    "src/components/chat",
    "src/components/admin",
    "src/lib/ai",
    "src/server/services",
    "src/types",
    "prisma",
  ];
  for (const folder of directories) assert.equal(read(`${folder}/.gitkeep`).byteLength, 0);
  for (const folder of directories.slice(2))
    assert.deepEqual(inventory(folder), [`${folder}/.gitkeep`]);
  const protectedFiles = [
    "src/lib/utils.ts",
    "src/lib/env.ts",
    "src/lib/env-schema.ts",
    "src/lib/env-cli.ts",
    "src/lib/env.test.ts",
    "src/instrumentation.ts",
    "src/components/ui/button.tsx",
    "src/app/globals.css",
    "eslint.config.mjs",
    "vitest.config.ts",
  ];
  for (const file of protectedFiles)
    assert.equal(
      hash(file),
      sha(git(["show", `${receipt.phaseStartCommit}:${file}`], null)),
      `Protected source changed: ${file}`,
    );
  assert.equal(
    read("scripts/verify-phase003.mjs").toString(),
    git(["show", `${receipt.phaseStartCommit}:scripts/verify-phase003.mjs`]).replace(
      'const homePagePath = "src/app/page.tsx";',
      'const homePagePath = "src/app/(site)/page.tsx";',
    ),
  );
  assert.equal(
    hash("src/app/(site)/page.tsx"),
    sha(git(["show", `${receipt.phaseStartCommit}:src/app/page.tsx`], null)),
  );
  assert.equal(hash("tests/phase005/fixtures/phase003-home.tsx"), hash("src/app/(site)/page.tsx"));
  assert(!fs.existsSync(path.join(root, "src/lib/utils")));
  assert(!fs.existsSync(path.join(root, "src/app/page.tsx")));
  assert(!inventory("src/app/admin").some((file) => /\/page\.[jt]sx?$/.test(file)));
  assert(
    !/href|next\/link|router\s*\.\s*push/.test(
      read("src/components/layout/admin-shell.tsx").toString(),
    ),
  );
  const types = ["ApiErrorCode", "ApiError", "ApiResponse"];
  for (const name of types) {
    const definitions = inventory("src")
      .filter((file) => /\.tsx?$/.test(file) && !file.includes(".test."))
      .filter((file) => new RegExp(`(?:type|interface)\\s+${name}\\b`).test(read(file).toString()));
    assert.deepEqual(definitions, ["src/lib/api-response.ts"]);
  }
  const errorSource = read("src/components/common/error-state.tsx").toString();
  assert.match(errorSource, /^["']use client["'];\n/);
  for (const file of ["loading-state", "empty-state", "page-header"])
    assert(!/["']use client["']/.test(read(`src/components/common/${file}.tsx`).toString()));
  for (const file of inventory("src/components/common").concat(
    inventory("src/components/layout"),
  )) {
    if (!file.endsWith("tsx") || file.includes(".test.")) continue;
    assert(!/#[0-9a-fA-F]{3,8}\b|(?:rgb|hsl|oklch)\s*\(|process\.env/.test(read(file).toString()));
  }
  const api = read("docs/api.md").toString();
  const errors = JSON.parse(api.match(/"errors":\s*(\{[^\n]*?\})/)[1]);
  const apiSource = read("src/lib/api-response.ts").toString();
  const literalCodes = [...apiSource.matchAll(/^\s*"([A-Z_]+)",?$/gm)].map((match) => match[1]);
  assert.deepEqual(literalCodes.sort(), Object.keys(errors).sort());
  const readme = read("README.md").toString();
  for (const title of ["目录约定", "公共组件", "后台访问闸门"])
    assert(readme.includes(`## ${title}`));
  for (const folder of directories) assert(readme.includes(`${folder}/`));
  assert(/Phase011[\s\S]*404[\s\S]*不存在本地绕过变量/.test(readme));
  const changes = git(["diff", "--name-only", receipt.phaseStartCommit])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  for (const file of changes)
    assert(
      plan.modificationScope.some((scope) =>
        scope.endsWith("/") ? file.startsWith(scope) : file === scope,
      ),
      `Unexpected modification: ${file}`,
    );
  return {
    directories,
    exports: expectedExports,
    protectedFiles,
    apiErrorCodes: Object.keys(errors),
    originalHomepageHash: hash("tests/phase005/fixtures/phase003-home.tsx"),
  };
}

async function dependencyGeneration() {
  const setupPath = "docs/evidence/attempts/Phase005/setup/shadcn-sonner.json";
  const rawPath = "docs/evidence/attempts/Phase005/setup/sonner.generated.tsx";
  const setup = json(setupPath);
  assert.equal(setup.command, "npx --yes shadcn@3.2.1 add sonner");
  assert.equal(setup.exitCode, 0);
  assert.equal(setup.generatedSourceHash, hash(rawPath));
  const options = await resolveConfig(path.join(root, "src/components/ui/sonner.tsx"));
  assert.equal(
    await prettierFormat(read(rawPath).toString(), { ...options, parser: "typescript" }),
    read("src/components/ui/sonner.tsx").toString(),
  );
  const pkg = json("package.json"),
    lock = json("package-lock.json"),
    baseline = json("docs/runtime-baseline.json");
  assert.equal(baseline.runtimePolicy.shadcn, "3.2.1");
  assert.deepEqual(pkg.devDependencies, setup.beforeDevDependencies);
  const additions = Object.keys(pkg.dependencies)
    .filter((name) => !Object.hasOwn(setup.beforeDependencies, name))
    .sort();
  assert.deepEqual(additions, ["next-themes", "sonner"]);
  for (const [name, version] of Object.entries(setup.beforeDependencies))
    assert.equal(pkg.dependencies[name], version);
  for (const name of additions) {
    const version = pkg.dependencies[name];
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.equal(lock.packages[""]["dependencies"][name], version);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
    assert.equal(baseline.dependencyVersions[name], version);
    assert.equal(
      baseline.registry.find((entry) => entry.name === name).integrity,
      lock.packages[`node_modules/${name}`].integrity,
    );
  }
  const before = JSON.parse(
    git(["show", `${json(receiptPath).phaseStartCommit}:docs/runtime-baseline.json`]),
  );
  for (const key of Object.keys(before))
    if (!["registry", "dependencyVersions", "dependencyAdditions"].includes(key))
      assert.deepEqual(baseline[key], before[key]);
  const artifacts = [setupPath, rawPath].map((file) => ({ path: file, sha256: hash(file) }));
  return {
    command: setup,
    dependencies: Object.fromEntries(additions.map((name) => [name, pkg.dependencies[name]])),
    artifacts,
  };
}

const mutationDefinitions = {
  "negative-remove-return": [
    "src/middleware.ts",
    "src/middleware.test.ts",
    (text) => text.replace("return new NextResponse(null, { status: 404 });", ""),
  ],
  "negative-middleware-next": [
    "src/middleware.ts",
    "src/middleware.test.ts",
    (text) => text.replace("new NextResponse(null, { status: 404 })", "NextResponse.next()"),
  ],
  "negative-env-bypass": [
    "src/middleware.ts",
    "src/middleware.test.ts",
    (text) =>
      text.replace(
        "return new NextResponse",
        'if (process.env.ALLOW_ADMIN === "true") return NextResponse.next();\n  return new NextResponse',
      ),
  ],
  "negative-query-bypass": [
    "src/middleware.ts",
    "src/middleware.test.ts",
    (text) =>
      text.replace(
        "return new NextResponse",
        'if (_request.nextUrl.searchParams.get("preview") === "true") return NextResponse.next();\n  return new NextResponse',
      ),
  ],
  "negative-cookie-bypass": [
    "src/middleware.ts",
    "src/middleware.test.ts",
    (text) =>
      text.replace(
        "return new NextResponse",
        'if (_request.cookies.get("admin")?.value === "true") return NextResponse.next();\n  return new NextResponse',
      ),
  ],
  "negative-matcher": [
    "src/middleware.ts",
    "src/middleware.test.ts",
    (text) => text.replace('["/admin", "/admin/:path*"]', '["/admin"]'),
  ],
  "negative-toaster": [
    "src/app/(site)/layout.tsx",
    "src/app/layout.test.ts",
    (text) =>
      'import { Toaster } from "@/components/ui/sonner";\n' +
      text.replace("<SiteHeader />", "<SiteHeader /><Toaster />"),
  ],
  "negative-duration": [
    "src/lib/format.ts",
    "src/lib/format.test.ts",
    (text) => text.replace(" || durationMinutes < 0", ""),
  ],
  "negative-stringify": [
    "src/lib/json.ts",
    "src/lib/json.test.ts",
    (text) => text.replace("return serialize(value);", "return JSON.stringify(value);"),
  ],
  "negative-locale": [
    "src/lib/json.ts",
    "src/lib/json.test.ts",
    (text) => text.replace("a < b ? -1 : a > b ? 1 : 0", "a.localeCompare(b)"),
  ],
  "negative-alert": [
    "src/components/common/error-state.tsx",
    "src/components/common/common-components.test.tsx",
    (text) => text.replace('role="alert"', ""),
  ],
};

async function negative(name) {
  const fixture = copyFixture(name);
  const [file, suite, mutate] = mutationDefinitions[name];
  const target = path.join(fixture, file);
  const original = fs.readFileSync(target);
  let passed = false;
  try {
    const before = await runTests(suite, 1, fixture);
    const mutated = mutate(original.toString());
    assert.notEqual(mutated, original.toString(), `Mutation had no effect: ${name}`);
    fs.writeFileSync(target, mutated);
    const red = await runTests(suite, 1, fixture, 1);
    const failedAssertions = red.files.flatMap((entry) =>
      entry.assertions.filter((test) => test.status === "failed").map((test) => test.fullName),
    );
    if (/middleware|remove-return|bypass/.test(name))
      assert(failedAssertions.some((title) => title.includes("admin")));
    let productionRed;
    if (name === "negative-matcher") {
      const build = await npm(["run", "build"], { cwd: fixture });
      const server = await startServer("production", fixture);
      try {
        const response = await fetch(`${server.baseUrl}/admin/settings`);
        const body = await response.text();
        assert.equal(response.status, 404);
        assert(
          body.length > 0,
          "The intentionally uncovered subroute must expose the native nonempty missing-page response",
        );
        const assertion = await command(
          "production matcher mutation must fail empty-body HTTP assertion",
          [path.join(root, "tests/phase005/browser.mjs"), "--http-only", server.baseUrl],
          { expected: null },
        );
        assert(Number.isInteger(assertion.exitCode) && assertion.exitCode > 0);
        assert.match(assertion.stderr, /admin\/settings.*empty/);
        productionRed = {
          build,
          assertion,
          bodyBytes: Buffer.byteLength(body),
          server: server.observation,
        };
      } finally {
        await server.stop();
      }
    }
    fs.writeFileSync(target, original);
    const restored = await runTests(suite, 1, fixture);
    let productionRestored;
    if (name === "negative-matcher") {
      const build = await npm(["run", "build"], { cwd: fixture });
      const server = await startServer("production", fixture);
      try {
        productionRestored = {
          build,
          rows: await httpMatrix(server.baseUrl, productionRows),
          server: server.observation,
        };
      } finally {
        await server.stop();
      }
    }
    assert.equal(sha(fs.readFileSync(target)), sha(original));
    assert.equal(hash(file), sha(original), "Mutation polluted the real product source");
    passed = true;
    return {
      fixtureIsolation: "TEMPORARY_COPY",
      mutatedFile: file,
      originalHash: sha(original),
      mutationHash: sha(mutated),
      before,
      red,
      failedAssertions,
      restored,
      ...(productionRed ? { productionRed, productionRestored } : {}),
    };
  } finally {
    fs.writeFileSync(target, original);
    if (passed) removeFixture(fixture);
  }
}

function evidenceBinding() {
  const receipt = json(receiptPath);
  for (const input of receipt.pinnedInputs)
    assert.equal(hash(input.path), input.sha256, `Pinned input drift: ${input.path}`);
  assert.equal(receipt.phase, 5);
  assert.equal(receipt.preflight.completedThrough, 4);
  assert.equal(receipt.phaseStartCommit, receipt.preflight.originMain);
  const sources = sourceHashes();
  const item = plan.cases.find((entry) => entry.testCaseId === "Phase005:structure");
  const fixture = {
    testCaseId: item.testCaseId,
    command: item.command,
    status: "PASS",
    exitCode: 0,
    numerator: item.denominator,
    denominator: item.denominator,
    inputPath: item.inputPath,
    inputHash: hash(item.inputPath),
    planHash: hash(planPath),
    sourceHashes: sources,
  };
  requireReportBinding(fixture, item, hash(planPath), plan.sourcePaths, hash);
  const corruptions = [
    (report) => {
      report.planHash = "0".repeat(64);
    },
    (report) => {
      report.inputHash = "0".repeat(64);
    },
    (report) => {
      report.sourceHashes[plan.sourcePaths[0]] = "0".repeat(64);
    },
    (report) => {
      report.denominator += 1;
    },
    (report) => {
      delete report.sourceHashes[plan.sourcePaths[0]];
    },
  ];
  for (const corrupt of corruptions) {
    const changed = structuredClone(fixture);
    corrupt(changed);
    assert.throws(() =>
      requireReportBinding(changed, item, hash(planPath), plan.sourcePaths, hash),
    );
  }
  return {
    verifiedLocalInputs: receipt.pinnedInputs.length,
    sourceCount: plan.sourcePaths.length,
    corruptionsRejected: corruptions.length,
    fixtureMode: "SYNTHETIC_REPORT_BINDING_NOT_PRODUCT_EVIDENCE",
  };
}

async function evaluate(name) {
  if (name in suiteDefinitions) return await runTests(...suiteDefinitions[name]);
  if (name in mutationDefinitions) return await negative(name);
  if (name === "structure") return structure();
  if (name === "dependency-generation") return await dependencyGeneration();
  if (name === "evidence-binding") return evidenceBinding();
  if (name === "test") return await runTests(null, 40);
  if (["lint", "typecheck", "build"].includes(name))
    return { observation: await npm(["run", name]) };
  if (name === "phase003-regression") return { observation: await npm(["run", "verify:phase003"]) };
  if (name === "format-check")
    return {
      observations: [
        await npm(["run", "format:check"]),
        await command("prettier --check Phase005 tooling and browser fixtures", [
          "node_modules/prettier/bin/prettier.cjs",
          "--ignore-path",
          ".gitignore",
          "--check",
          "docs/phase-plans/*phase005*.mjs",
          "tests/phase005/**/*.{mjs,tsx}",
        ]),
      ],
    };
  if (name === "production-middleware" || name === "browser-layout") {
    const server = await startServer("production");
    try {
      const details =
        name === "browser-layout"
          ? await browserLayout(server.baseUrl)
          : { rows: await httpMatrix(server.baseUrl, productionRows) };
      return { ...details, server: server.observation };
    } finally {
      await server.stop();
    }
  }
  if (name === "development-middleware") {
    const fixture = copyFixture("dev");
    let passed = false;
    try {
      const server = await startServer("development", fixture);
      try {
        const rows = await httpMatrix(server.baseUrl, [
          ["/admin", 404],
          ["/admin/login", 404],
        ]);
        passed = true;
        return { rows, server: server.observation, fixtureIsolation: "TEMPORARY_COPY" };
      } finally {
        await server.stop();
      }
    } finally {
      if (passed) removeFixture(fixture);
    }
  }
  throw new Error(`Unknown case: ${name}`);
}

async function runCase(item) {
  assert(
    !fs.existsSync(path.join(root, directory, "attempt.json")),
    "This attempt failed; preserve it and retry",
  );
  assert(
    !fs.existsSync(path.join(root, item.outputPath)),
    "Immutable report exists; use a new attempt",
  );
  const before = sourceHashes();
  try {
    const details = await evaluate(item.testCaseId.slice("Phase005:".length));
    requireHashCoverage(before, plan.sourcePaths, hash, "STABLE_RUN_SOURCE");
    const report = {
      testCaseId: item.testCaseId,
      command: item.command,
      status: "PASS",
      exitCode: 0,
      numerator: item.denominator,
      denominator: item.denominator,
      inputPath: item.inputPath,
      inputHash: hash(item.inputPath),
      planHash: hash(planPath),
      sourceHashes: before,
      simulation: true,
      productionTraffic: false,
      details,
    };
    write(item.outputPath, report);
    console.warn(
      JSON.stringify({
        testCaseId: item.testCaseId,
        status: "PASS",
        numerator: item.denominator,
        denominator: item.denominator,
      }),
    );
  } catch (error) {
    write(`${directory}/attempt.json`, {
      phase: 5,
      attemptId: plan.attemptId,
      status: "FAIL",
      artifactCommit: null,
      failedCase: item.testCaseId,
      failure: error.stack,
      observation: error.observation ?? null,
      sourceHashes: before,
      planHash: hash(planPath),
      generatedAt: new Date().toISOString(),
    });
    throw error;
  }
}

async function main() {
  const requested = process.argv[process.argv.indexOf("--case") + 1];
  const cases = process.argv.includes("--all")
    ? plan.cases
    : plan.cases.filter((item) => item.testCaseId === `Phase005:${requested}`);
  assert(cases.length > 0, "Use --all or --case CASE_ID");
  // A route move invalidates the previous build's .next/types; regenerate them
  // before typechecking while keeping the frozen case identities unchanged.
  const typecheck = cases.find((item) => item.testCaseId === "Phase005:typecheck");
  const ordered = cases.filter((item) => item !== typecheck);
  if (typecheck) {
    const buildIndex = ordered.findIndex((item) => item.testCaseId === "Phase005:build");
    ordered.splice(buildIndex >= 0 ? buildIndex + 1 : 0, 0, typecheck);
  }
  for (const item of ordered) await runCase(item);
  if (process.argv.includes("--all")) {
    for (const item of plan.cases)
      requireReportBinding(json(item.outputPath), item, hash(planPath), plan.sourcePaths, hash);
    console.warn(
      JSON.stringify({
        status: "PASS",
        requiredCases: plan.cases.length,
        independentReviewPending: true,
      }),
    );
  }
}

main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
