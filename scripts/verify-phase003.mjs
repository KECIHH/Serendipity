import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import postcss from "postcss";
import {
  requirePhase003Artifacts,
  requirePhase003Bootstrap,
  requirePhase003EvidenceFixture,
  requirePhase003SupportingCommands,
  requirePhase003SupplementalHashes,
} from "./phase003-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file, base = root) => fs.readFileSync(path.join(base, file));
const json = (file, base = root) => JSON.parse(read(file, base));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const baseline = json("docs/runtime-baseline.json");
const planPath = "docs/phase-plans/Phase003.json";
const plan = json(planPath);
// Phase005 may move the bootstrap page by changing only this consumer path.
const homePagePath = "src/app/page.tsx";
const temporaryParent = fs.realpathSync(os.tmpdir());
const toolRoot = path.join(root, ".scaffold/tools");
const npmCli = process.env.npm_execpath ?? path.join(toolRoot, "node_modules/npm/bin/npm-cli.js");
const requiredScripts = Object.freeze({
  dev: "next dev",
  build: "next build",
  start: "next start",
  lint: "eslint . --max-warnings 0",
  typecheck: "tsc --noEmit",
  "verify:phase003": "node scripts/verify-phase003.mjs",
});
const tokenValues = Object.freeze({
  "--color-brand-500": "#047857",
  "--color-brand-600": "#065f46",
  "--color-surface": "#ffffff",
  "--color-surface-muted": "#fafafa",
  "--color-border-subtle": "#e4e4e7",
  "--font-sans":
    'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
  "--radius-card": "0.5rem",
  "--shadow-card": "0 1px 2px 0 rgb(0 0 0 / 0.05)",
  "--spacing-gutter": "1rem",
  "--breakpoint-wide": "64rem",
});
const observations = [];

function environment(extra = {}) {
  const env = { ...process.env };
  const inheritedPath = env.Path ?? env.PATH;
  for (const key of Object.keys(env))
    if (/^(npm_config_|next_private_test_version$|path$|node_env$|psmodulepath$)/i.test(key))
      delete env[key];
  return {
    ...env,
    Path: `${path.join(toolRoot, "node_modules/.bin")}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${inheritedPath}`,
    NPM_CONFIG_USERCONFIG: path.join(toolRoot, "npmrc"),
    NPM_CONFIG_GLOBALCONFIG: path.join(toolRoot, "global-npmrc"),
    NPM_CONFIG_CACHE: path.join(toolRoot, "cache"),
    NEXT_TELEMETRY_DISABLED: "1",
    CI: "1",
    PLAYWRIGHT_BROWSERS_PATH: path.join(toolRoot, "browsers"),
    ...extra,
  };
}

function command(label, executable, args, cwd = root, expected = 0, extraEnv = {}) {
  const start = performance.now();
  const result = spawnSync(executable, args, {
    cwd,
    env: environment(extraEnv),
    windowsHide: true,
    encoding: "utf8",
    timeout: 900_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const observation = {
    label,
    executable,
    arguments: args,
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: Math.round(performance.now() - start),
    error: result.error?.message ?? null,
  };
  observations.push(observation);
  if (expected !== null)
    assert.equal(
      result.status,
      expected,
      `${label}: ${observation.stdout}\n${observation.stderr}\n${observation.error ?? ""}`,
    );
  return observation;
}

function writeExclusive(file, value) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function inventory(directory, prefix = "") {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => ![".git", ".scaffold", "node_modules"].includes(entry.name))
    .flatMap((entry) => {
      assert(!entry.isSymbolicLink(), `Unexpected source symlink: ${entry.name}`);
      const file = path.posix.join(prefix, entry.name);
      return entry.isDirectory() ? inventory(path.join(directory, entry.name), file) : [file];
    });
}

function ast(file) {
  return ts.createSourceFile(
    file,
    read(file).toString(),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}
function collect(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  ts.forEachChild(node, (child) => {
    collect(child, predicate, found);
  });
  return found;
}
function cssTrees() {
  const directory = path.join(root, ".next/static/css");
  const paths = inventory(directory).filter((file) => file.endsWith(".css"));
  assert(paths.length > 0, "Production CSS is missing; run npm run build first");
  return paths.map((file) => ({
    file: `.next/static/css/${file}`,
    bytes: read(`.next/static/css/${file}`),
    tree: postcss.parse(read(`.next/static/css/${file}`).toString()),
  }));
}

function removeFixture(directory) {
  const resolved = fs.realpathSync(directory);
  assert.equal(path.dirname(resolved), temporaryParent, "Unsafe cleanup parent");
  assert(path.basename(resolved).startsWith("serendipity-phase003-"), "Unsafe cleanup target");
  for (const junction of ["node_modules", ".scaffold/tools"]) {
    const target = path.join(resolved, junction);
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function ignoreCheck() {
  const fixture = fs.mkdtempSync(path.join(temporaryParent, "serendipity-phase003-ignore-"));
  let passed = false;
  try {
    fs.copyFileSync(path.join(root, ".gitignore"), path.join(fixture, ".gitignore"));
    fs.writeFileSync(path.join(fixture, "empty-gitconfig"), "");
    const env = {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(fixture, "empty-gitconfig"),
    };
    command("ignore-fixture-init", "git", ["init", "--initial-branch=main"], fixture, 0, env);
    const probes = [
      "node_modules/package/index.js",
      ".next/static/css/output.css",
      "out/index.html",
      "coverage/lcov.info",
      "server.log",
      ".env",
      ".env.local",
      ".env.production.local",
      "next-env.d.ts",
      "tsconfig.tsbuildinfo",
    ];
    const observed = command(
      "ignore-probes-without-global-config",
      "git",
      ["check-ignore", "--no-index", "--", ...probes],
      fixture,
      0,
      env,
    )
      .stdout.trim()
      .split(/\r?\n/);
    assert.deepEqual(observed, probes);
    command(
      "lockfile-is-not-ignored",
      "git",
      ["check-ignore", "--no-index", "--", "package-lock.json"],
      fixture,
      1,
      env,
    );
    passed = true;
    return { probes, globalIgnoreUsed: false };
  } finally {
    if (passed) removeFixture(fixture);
  }
}

const core = [
  () => {
    const pkg = json("package.json");
    const lock = json("package-lock.json");
    for (const [name, value] of Object.entries(requiredScripts))
      assert.equal(pkg.scripts[name], value, `Frozen script changed: ${name}`);
    for (const value of [pkg.name, lock.name, lock.packages[""].name])
      assert.equal(value, "serendipity");
    return { scriptNames: Object.keys(pkg.scripts), namesMatch: true, ignore: ignoreCheck() };
  },
  () => {
    const pkg = json("package.json");
    const lock = json("package-lock.json");
    const manifest = json(baseline.manifestPath);
    assert.equal(hash(read(baseline.manifestPath)), baseline.manifestHash);
    assert.deepEqual(baseline.runtimePolicy, manifest.runtimePolicy);
    for (const group of ["dependencies", "devDependencies"])
      for (const [name, version] of Object.entries(pkg[group] ?? {})) {
        assert.match(
          version,
          /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
          `Dependency must be exact: ${name}=${version}`,
        );
        assert.equal(lock.packages[""][group][name], version, `Root lock mismatch: ${name}`);
        assert.equal(
          lock.packages[`node_modules/${name}`].version,
          version,
          `Resolved lock mismatch: ${name}`,
        );
      }
    assert.equal(process.versions.node, manifest.runtimePolicy.node);
    assert.equal(
      command("actual-node-version", process.execPath, ["--version"]).stdout.trim(),
      `v${manifest.runtimePolicy.node}`,
    );
    assert.equal(
      command("actual-npm-version", process.execPath, [npmCli, "--version"]).stdout.trim(),
      manifest.runtimePolicy.npm,
    );
    const npx = path.join(toolRoot, "node_modules/npm/bin/npx-cli.js");
    for (const [name, policyKey] of [
      ["create-next-app", "createNextApp"],
      ["shadcn", "shadcn"],
    ]) {
      assert.equal(
        command(`actual-${name}-version`, process.execPath, [
          npx,
          "--offline",
          "--yes",
          `${name}@${manifest.runtimePolicy[policyKey]}`,
          "--version",
        ]).stdout.trim(),
        manifest.runtimePolicy[policyKey],
      );
      assert.equal(baseline.observedVersions[policyKey], manifest.runtimePolicy[policyKey]);
    }
    for (const [name, key, group] of [
      ["next", "next", "dependencies"],
      ["eslint-config-next", "eslintConfigNext", "devDependencies"],
    ]) {
      assert.equal(pkg[group][name], manifest.runtimePolicy[key]);
      assert.equal(baseline.observedVersions[key], manifest.runtimePolicy[key]);
      assert.equal(
        lock.packages[`node_modules/${name}`].integrity,
        baseline.registry.find((entry) => entry.name === name).integrity,
      );
    }
    assert.equal(pkg.dependencies["lucide-react"], baseline.lucideReact);
    assert.equal(pkg.devDependencies.shadcn, manifest.runtimePolicy.shadcn);
    assert.equal(pkg.overrides?.next?.postcss, "8.5.28");
    const nextPostcss =
      lock.packages["node_modules/next/node_modules/postcss"] ??
      lock.packages["node_modules/postcss"];
    assert.equal(nextPostcss.version, "8.5.28");
    assert.equal(
      nextPostcss.integrity,
      baseline.registry.find((entry) => entry.name === "postcss").integrity,
    );
    assert.equal(baseline.observedVersions.node, `v${manifest.runtimePolicy.node}`);
    assert.equal(baseline.observedVersions.npm, manifest.runtimePolicy.npm);
    assert.equal(lock.lockfileVersion, baseline.lockfileVersion);
    assert.equal(lock.lockfileVersion, 3);
    const receipt = json(baseline.auditReceiptPath);
    const audit = JSON.parse(receipt.stdout);
    assert.equal(receipt.exitCode, 0);
    assert(!audit.error, "Audit service returned an error");
    assert.equal(audit.metadata.vulnerabilities.high, 0);
    assert.equal(audit.metadata.vulnerabilities.critical, 0);
    return {
      exactDependencies:
        Object.keys(pkg.dependencies).length + Object.keys(pkg.devDependencies).length,
      runtimePolicy: manifest.runtimePolicy,
      lockfileVersion: lock.lockfileVersion,
      audit: audit.metadata.vulnerabilities,
    };
  },
  () => {
    assert.equal(json("package.json").devDependencies.tailwindcss.split(".")[0], "4");
    for (const file of ["tailwind.config.ts", "tailwind.config.js"])
      assert(!fs.existsSync(path.join(root, file)), file);
    const config = ts.parseConfigFileTextToJson(
      "tsconfig.json",
      read("tsconfig.json").toString(),
    ).config;
    assert.equal(config.compilerOptions.strict, true);
    assert(
      !/ignoreBuildErrors\s*:\s*true|ignoreDuringBuilds\s*:\s*true/.test(
        read("next.config.ts").toString(),
      ),
    );
    for (const file of inventory(path.join(root, "src")))
      if (/\.[cm]?[jt]sx?$/.test(file))
        assert(!read(`src/${file}`).includes(Buffer.from("@ts-nocheck")));
    return { tailwindMajor: 4, strictTypeScript: true, buildErrorBypasses: false };
  },
  () => {
    const tree = postcss.parse(read("src/app/globals.css").toString());
    const imports = [];
    const declarations = new Map();
    tree.walkAtRules("import", (rule) => imports.push(rule.params));
    assert(imports.includes('"tailwindcss"'), "Active Tailwind CSS import is required");
    tree.walkAtRules("theme", (rule) =>
      rule.walkDecls((declaration) => {
        if (Object.hasOwn(tokenValues, declaration.prop)) {
          assert(!declarations.has(declaration.prop), `Duplicate token: ${declaration.prop}`);
          declarations.set(declaration.prop, declaration.value);
        }
      }),
    );
    const normalizeWhitespace = (value) =>
      value
        ?.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\s+/g, (match, quoted) => quoted ?? " ")
        .trim();
    for (const [name, value] of Object.entries(tokenValues))
      assert.equal(
        normalizeWhitespace(declarations.get(name)),
        normalizeWhitespace(value),
        `Missing/changed theme token: ${name}`,
      );
    const text = tree.toString();
    for (const required of [
      "box-sizing: border-box",
      "overflow-x: clip",
      "body",
      "a",
      "font-family: var(--font-sans)",
    ])
      assert(text.includes(required), required);
    return { tokenCount: declarations.size, tokens: Object.fromEntries(declarations) };
  },
  () => {
    const components = json("components.json");
    assert.equal(components.aliases.ui, "@/components/ui");
    assert.equal(components.aliases.utils, "@/lib/utils");
    assert.equal(components.aliases.components, "@/components");
    assert.equal(components.tailwind.css, "src/app/globals.css");
    return { aliases: components.aliases, css: components.tailwind.css };
  },
  () => {
    const exportsName = (file, name) =>
      collect(
        ast(file),
        (node) =>
          (ts.isFunctionDeclaration(node) &&
            node.name?.text === name &&
            node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) ||
          (ts.isExportSpecifier(node) && node.name.text === name),
      ).length > 0;
    assert(exportsName("src/lib/utils.ts", "cn"));
    assert(exportsName("src/components/ui/button.tsx", "Button"));
    return { cnExported: true, buttonExported: true };
  },
  () => {
    const page = ast(homePagePath);
    const imports = collect(page, ts.isImportDeclaration);
    const buttonImport = imports.find(
      (node) => node.moduleSpecifier.text === "@/components/ui/button",
    );
    assert(
      buttonImport?.importClause?.namedBindings?.elements.some(
        (node) => node.name.text === "Button",
      ),
      "Import Button from the unique UI module",
    );
    const jsx = collect(page, ts.isJsxElement);
    const heading = jsx.find((node) => node.openingElement.tagName.getText(page) === "h1");
    const button = jsx.find((node) => node.openingElement.tagName.getText(page) === "Button");
    const jsxText = (node) =>
      node.children
        .filter(ts.isJsxText)
        .map((child) => child.text)
        .join("")
        .trim();
    assert(heading && jsxText(heading) === "Serendipity · 际遇");
    assert(button && jsxText(button) === "开始规划", "Render the shadcn Button");
    const classNames = collect(page, ts.isJsxAttribute)
      .filter((node) => node.name.text === "className")
      .map((node) => node.initializer?.text ?? "")
      .join(" ")
      .split(/\s+/);
    for (const name of [
      "bg-brand-500",
      "rounded-card",
      "shadow-card",
      "p-gutter",
      "wide:max-w-5xl",
    ])
      assert(classNames.includes(name), name);
    const metadata = collect(
      ast("src/app/layout.tsx"),
      (node) => ts.isVariableDeclaration(node) && node.name.getText() === "metadata",
    )[0];
    const title = metadata?.initializer?.properties?.find(
      (node) => node.name.getText() === "title",
    );
    assert.equal(title?.initializer?.text, "Serendipity · 际遇");
    assert(
      !collect(page, (node) => ts.isJsxAttribute(node) && /^on[A-Z]/.test(node.name.text)).length,
      "Bootstrap page must not bind business handlers",
    );
    for (const node of collect(page, ts.isJsxOpeningElement))
      assert(!["form", "input", "textarea"].includes(node.tagName.getText(page)));
    return {
      pagePath: homePagePath,
      heading: jsxText(heading),
      button: jsxText(button),
      title: title.initializer.text,
      bootstrapOnly: true,
    };
  },
  () => {
    const sheets = cssTrees();
    const selectors = new Set();
    for (const { tree } of sheets)
      tree.walkRules((rule) => rule.selectors.forEach((selector) => selectors.add(selector)));
    for (const selector of [".bg-brand-500", ".rounded-card", ".p-gutter"])
      assert(selectors.has(selector), `Compiled selector missing: ${selector}`);
    return {
      css: sheets.map(({ file, bytes }) => ({
        path: file,
        sha256: hash(bytes),
        bytes: bytes.length,
      })),
      selectors: [".bg-brand-500", ".rounded-card", ".p-gutter"],
    };
  },
  () => {
    const sheets = cssTrees();
    const media = [];
    const wide = (rule) =>
      rule.type === "atrule" &&
      rule.name === "media" &&
      /\(\s*(?:width\s*>=|min-width\s*:)\s*64rem\s*\)/.test(rule.params);
    for (const { tree } of sheets)
      tree.walkRules((rule) => {
        if (!rule.selector.includes(".wide\\:max-w-5xl")) return;
        for (let parent = rule.parent; parent; parent = parent.parent)
          if (wide(parent)) media.push({ query: parent.params, selector: rule.selector });
        rule.walkAtRules("media", (child) => {
          if (wide(child)) media.push({ query: child.params, selector: rule.selector });
        });
      });
    assert(media.length > 0, "wide:max-w-5xl must be emitted inside an active 64rem breakpoint");
    return { wideMediaRules: media };
  },
];

function phase003ComponentScope(base = root) {
  const generated = json(
    "docs/evidence/attempts/Phase003/setup/bootstrap.json",
    base,
  ).generatedButton;
  assert.equal(
    hash(read(generated.path, base)),
    generated.sha256,
    "Generated Button implementation must remain unchanged in Phase003",
  );
  assert.deepEqual(
    inventory(path.join(base, "src/components/ui")),
    ["button.tsx"],
    "Phase003 allows only the rendered Button UI component",
  );
  return { generatedButtonHash: generated.sha256, onlyGeneratedButton: true };
}

function phase003ProductScope(base = root) {
  const excluded = [
    ".env",
    ".env.local",
    ".env.example",
    "src/lib/env.ts",
    "src/server",
    "src/app/admin",
    "src/app/api",
    "prisma",
    "src/middleware.ts",
    "vitest.config.ts",
  ];
  for (const file of excluded)
    assert(!fs.existsSync(path.join(base, file)), `Future-phase file: ${file}`);
  const pkg = json("package.json", base);
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }))
    assert(
      !/^(prettier|vitest|@testing-library\/|jsdom|prisma|@prisma\/|framer-motion)/.test(name),
      `Future-phase dependency: ${name}`,
    );
  for (const file of inventory(path.join(base, "src")).filter((file) => /\.[jt]sx?$/.test(file)))
    assert(
      !/process\.env|AI_API_KEY|AI_BASE_URL|AI_MODEL|AI_MOCK/.test(
        read(`src/${file}`, base).toString(),
      ),
      "No runtime env/AI readers in Phase003",
    );
  return {
    excludedPaths: excluded,
    futureDependenciesExcluded: true,
    runtimeEnvReadersExcluded: true,
  };
}

function checks(indices = core.map((_, index) => index)) {
  return indices.map((index) => {
    try {
      const details = core[index]();
      console.warn(`[${index + 1}] PASS`);
      return { assertion: index + 1, status: "PASS", details };
    } catch (error) {
      console.warn(`[${index + 1}] FAIL: ${error.message}`);
      return { assertion: index + 1, status: "FAIL", error: error.message };
    }
  });
}

function copyFixture({ installed = true, built = true } = {}) {
  const fixture = fs.mkdtempSync(path.join(temporaryParent, "serendipity-phase003-fixture-"));
  const paths = [
    ".gitignore",
    "package.json",
    "package-lock.json",
    "components.json",
    "next.config.ts",
    "tsconfig.json",
    "postcss.config.mjs",
    "eslint.config.mjs",
    "src",
    "public",
    "scripts/verify-phase003.mjs",
    "scripts/phase003-evidence.mjs",
    planPath,
    "docs/phase-plans/Phase003-inputs.json",
    "docs/runtime-baseline.json",
    "docs/evidence/attempts/Phase003/setup/bootstrap.json",
    baseline.auditReceiptPath,
    baseline.manifestPath,
  ];
  for (const file of paths) {
    const target = path.join(fixture, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(root, file), target, { recursive: true, errorOnExist: true, force: false });
  }
  if (installed)
    fs.symlinkSync(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "junction");
  fs.mkdirSync(path.join(fixture, ".scaffold"));
  fs.symlinkSync(toolRoot, path.join(fixture, ".scaffold/tools"), "junction");
  if (built)
    fs.cpSync(path.join(root, ".next/static/css"), path.join(fixture, ".next/static/css"), {
      recursive: true,
    });
  return fixture;
}

function verifyFixture(fixture, label, expected, failures = [], only) {
  const args = [npmCli, "run", "verify:phase003", ...(only ? ["--", "--check", String(only)] : [])];
  const result = command(label, process.execPath, args, fixture, expected);
  const line = result.stdout.split(/\r?\n/).find((text) => text.startsWith("PHASE003_ASSERTIONS "));
  assert(line, "Verifier did not produce an assertion report");
  const report = JSON.parse(line.slice("PHASE003_ASSERTIONS ".length));
  for (const number of failures)
    assert(
      report.some((entry) => entry.assertion === number && entry.status === "FAIL"),
      `Expected assertion ${number} to fail`,
    );
  if (expected === 0) assert(report.every((entry) => entry.status === "PASS"));
  return {
    exitCode: result.exitCode,
    assertions: report.map(({ assertion, status }) => ({ assertion, status })),
  };
}

function buildFixture(fixture, label, expected = 0) {
  const output = path.join(fixture, ".next");
  if (fs.existsSync(output)) {
    assert.equal(path.dirname(fs.realpathSync(fixture)), temporaryParent);
    assert(path.basename(fixture).startsWith("serendipity-phase003-"));
    assert.equal(fs.realpathSync(output), output);
    fs.rmSync(output, { recursive: true, force: true });
  }
  return command(label, process.execPath, [npmCli, "run", "build"], fixture, expected);
}

async function negative(name) {
  const fixture = copyFixture();
  let passed = false;
  try {
    const before = verifyFixture(fixture, "baseline-green", 0);
    const definitions = {
      "negative-tailwind-import": {
        file: "src/app/globals.css",
        change: (text) => text.replace('@import "tailwindcss";', '/* @import "tailwindcss"; */'),
        failures: [4, 8],
        rebuild: true,
      },
      "negative-brand-token": {
        file: "src/app/globals.css",
        change: (text) => text.replace(/^\s*--color-brand-500:[^;]+;\r?\n/m, ""),
        failures: [8],
        rebuild: true,
      },
      "negative-native-button": {
        file: "src/app/page.tsx",
        change: (text) =>
          text
            .replace(/^import \{ Button \} from "@\/components\/ui\/button";\r?\n/m, "")
            .replace(/<Button\b[^>]*>/g, "<button>")
            .replaceAll("</Button>", "</button>"),
        failures: [7],
      },
      "negative-version-range": {
        file: "package.json",
        change: (text) => {
          const pkg = JSON.parse(text);
          pkg.dependencies.next = `^${pkg.dependencies.next}`;
          return `${JSON.stringify(pkg, null, 2)}\n`;
        },
        failures: [2],
      },
    };
    const definition = definitions[name];
    const target = path.join(fixture, definition.file);
    const original = fs.readFileSync(target);
    const mutated = definition.change(original.toString());
    assert.notEqual(mutated, original.toString(), "Mutation had no effect");
    fs.writeFileSync(target, mutated);
    let build;
    if (definition.rebuild) build = buildFixture(fixture, "mutated-fresh-build", null);
    const red = verifyFixture(fixture, "mutation-red", 1, definition.failures);
    fs.writeFileSync(target, original);
    if (definition.rebuild) buildFixture(fixture, "restored-fresh-build");
    const restored = verifyFixture(fixture, "restored-green", 0);
    assert.equal(hash(fs.readFileSync(target)), hash(original));
    passed = true;
    return {
      fixtureIsolation: "TEMPORARY_COPY",
      mutatedPath: definition.file,
      before,
      mutatedBuildExitCode: build?.exitCode ?? null,
      red,
      restored,
      originalHash: hash(original),
      rootProductUnchanged: true,
    };
  } finally {
    if (passed) removeFixture(fixture);
    else observations.push({ retainedFixture: fixture });
  }
}

async function portFree() {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(3000, "127.0.0.1", () => server.close(resolve));
  });
}

async function withDev(callback) {
  await portFree();
  const child = spawn(process.execPath, [npmCli, "run", "dev", "--", "--hostname", "127.0.0.1"], {
    cwd: root,
    env: environment(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const started = Date.now();
  let ready = false;
  try {
    while (Date.now() - started < 120_000) {
      assert(child.exitCode === null, `Dev process exited before readiness: ${stdout}\n${stderr}`);
      try {
        const result = await fetch("http://127.0.0.1:3000/", { signal: AbortSignal.timeout(4000) });
        if (result.status === 200) {
          ready = true;
          break;
        }
      } catch {
        /* Readiness retries are bounded and recorded. */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(ready, `Dev readiness timed out: ${stdout}\n${stderr}`);
    return await callback();
  } finally {
    if (child.exitCode === null)
      command("release-owned-dev-process-tree", "taskkill.exe", [
        "/PID",
        String(child.pid),
        "/T",
        "/F",
      ]);
    observations.push({
      label: "controlled-dev-server",
      executable: process.execPath,
      arguments: [npmCli, "run", "dev", "--", "--hostname", "127.0.0.1"],
      pid: child.pid,
      ready,
      stdout,
      stderr,
      controlledTermination: true,
    });
    await portFree();
  }
}

async function browserCheck(name, artifactPrefix) {
  const { chromium } = await import(
    pathToFileURL(path.join(toolRoot, "node_modules/playwright/index.mjs")).href
  );
  return withDev(async () => {
    const executablePath = path.join(toolRoot, "browsers/chromium-1193/chrome-win/chrome.exe");
    const browser = await chromium.launch({ executablePath, headless: true });
    const browserVersion = browser.version();
    assert.equal(browserVersion, baseline.browser.chromiumVersion);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    const requests = [];
    const consoleErrors = [];
    const pageErrors = [];
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const local = ["127.0.0.1", "localhost"].includes(url.hostname);
      requests.push({ method: route.request().method(), url: url.href, local });
      if (local) await route.continue();
      else await route.abort();
    });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const artifacts = [];
    const layouts = [];
    try {
      await page.goto("http://127.0.0.1:3000/", { waitUntil: "networkidle" });
      assert.equal(await page.title(), "Serendipity · 际遇");
      assert.equal((await page.locator("h1").innerText()).trim(), "Serendipity · 际遇");
      assert.equal(await page.getByRole("button", { name: "开始规划", exact: true }).count(), 1);
      const widths = name === "responsive-layout" ? [375, 1280] : [1280];
      for (const width of widths) {
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        });
        const layout = await page.evaluate(() => {
          const container = document.querySelector(".bg-brand-500");
          const style = getComputedStyle(container);
          const rect = container.getBoundingClientRect();
          return {
            viewportWidth: innerWidth,
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            bodyScrollWidth: document.body.scrollWidth,
            container: {
              x: rect.x,
              width: rect.width,
              right: rect.right,
              background: style.backgroundColor,
              maxWidth: style.maxWidth,
            },
            brandToken: getComputedStyle(document.documentElement)
              .getPropertyValue("--color-brand-500")
              .trim(),
            overflow: [...document.querySelectorAll("main *")]
              .filter((element) => {
                const r = element.getBoundingClientRect();
                return r.left < -1 || r.right > innerWidth + 1;
              })
              .map((element) => element.tagName),
          };
        });
        assert.equal(layout.container.background, "rgb(4, 120, 87)");
        assert.equal(layout.brandToken, "#047857");
        assert(layout.scrollWidth <= layout.clientWidth);
        assert(layout.bodyScrollWidth <= width);
        assert.deepEqual(layout.overflow, []);
        if (width === 1280) {
          assert.equal(layout.container.maxWidth, "1024px");
          assert.equal(layout.container.width, 1024);
        }
        layouts.push(layout);
        const screenshot = `${artifactPrefix}-${width}.png`;
        const dom = `${artifactPrefix}-${width}.html`;
        assert(!fs.existsSync(path.join(root, screenshot)));
        assert(!fs.existsSync(path.join(root, dom)));
        await page.screenshot({
          path: path.join(root, screenshot),
          fullPage: true,
          animations: "disabled",
        });
        fs.writeFileSync(path.join(root, dom), `${await page.content()}\n`, { flag: "wx" });
        artifacts.push(
          ...[screenshot, dom].map((file) => ({ path: file, sha256: hash(read(file)) })),
        );
      }
      await page.keyboard.press("Tab");
      await page.waitForFunction(
        () => {
          const element = document.activeElement;
          if (!(element instanceof HTMLButtonElement) || !element.matches(":focus-visible"))
            return false;
          const style = getComputedStyle(element);
          return (
            Number.parseFloat(style.outlineWidth) >= 2 &&
            style.outlineOffset === "2px" &&
            style.boxShadow === "rgb(255, 255, 255) 0px 0px 0px 2px"
          );
        },
        undefined,
        { timeout: 5000 },
      );
      const focus = await page.evaluate(() => {
        const element = document.activeElement;
        const style = getComputedStyle(element);
        return {
          label: element.textContent.trim(),
          focusVisible: element.matches(":focus-visible"),
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          outlineOffset: style.outlineOffset,
          outlineColor: style.outlineColor,
          boxShadow: style.boxShadow,
        };
      });
      assert.equal(focus.label, "开始规划");
      assert.equal(focus.focusVisible, true);
      assert.equal(focus.outlineStyle, "solid");
      assert(Number.parseFloat(focus.outlineWidth) >= 2);
      assert.equal(focus.outlineOffset, "2px");
      assert.equal(focus.outlineColor, "rgb(3, 105, 161)");
      assert.equal(
        focus.boxShadow,
        "rgb(255, 255, 255) 0px 0px 0px 2px",
        "Focus needs a visible 2px white separation",
      );
      const focusScreenshot = `${artifactPrefix}-focus-1280.png`;
      const focusDom = `${artifactPrefix}-focus-1280.html`;
      assert(!fs.existsSync(path.join(root, focusScreenshot)));
      assert(!fs.existsSync(path.join(root, focusDom)));
      await page.screenshot({
        path: path.join(root, focusScreenshot),
        fullPage: true,
        animations: "disabled",
      });
      fs.writeFileSync(path.join(root, focusDom), `${await page.content()}\n`, { flag: "wx" });
      artifacts.push(
        ...[focusScreenshot, focusDom].map((file) => ({ path: file, sha256: hash(read(file)) })),
      );
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(consoleErrors, []);
      assert.equal(requests.filter((request) => !request.local).length, 0);
      return {
        browserVersion,
        playwrightVersion: baseline.browser.playwrightVersion,
        executableHash: hash(fs.readFileSync(executablePath)),
        layouts,
        artifacts,
        focus,
        requests,
        pageErrors,
        consoleErrors,
        publicRequests: 0,
        verificationScope: "AUTOMATED_BROWSER_ASSERTIONS",
        humanScreenReaderExperience: "NOT_EVALUATED",
      };
    } finally {
      await context.close();
      await browser.close();
    }
  });
}

function runtimeMutations() {
  const fixture = copyFixture();
  let passed = false;
  try {
    verifyFixture(fixture, "runtime-baseline-green", 0, [], 2);
    const pkgPath = path.join(fixture, "package.json");
    const original = fs.readFileSync(pkgPath);
    const pkg = JSON.parse(original);
    pkg.dependencies.next = "15.5.2";
    fs.writeFileSync(pkgPath, JSON.stringify(pkg));
    const downgrade = verifyFixture(fixture, "reject-exact-next-downgrade", 1, [2], 2);
    fs.writeFileSync(pkgPath, original);
    const baselinePath = path.join(fixture, "docs/runtime-baseline.json");
    const originalBaseline = fs.readFileSync(baselinePath);
    const changed = JSON.parse(originalBaseline);
    changed.observedVersions.createNextApp = "15.5.2";
    fs.writeFileSync(baselinePath, JSON.stringify(changed));
    const mismatch = verifyFixture(fixture, "reject-cli-framework-mismatch", 1, [2], 2);
    fs.writeFileSync(baselinePath, originalBaseline);
    const restored = verifyFixture(fixture, "runtime-restored-green", 0, [], 2);
    passed = true;
    return { downgrade, mismatch, restored };
  } finally {
    if (passed) removeFixture(fixture);
  }
}

function evidenceBindingRegression() {
  const directory = `docs/evidence/attempts/Phase003/${plan.attemptId}`;
  const browserReports = plan.cases
    .filter((item) => /:(browser-title|responsive-layout)$/.test(item.testCaseId))
    .map((item) => json(item.outputPath));
  const fileHash = (file) => hash(read(file));
  const attachmentPaths = requirePhase003Artifacts(browserReports, fileHash, directory);
  const bootstrap = json("docs/evidence/attempts/Phase003/setup/bootstrap.json");
  const bootstrapResult = requirePhase003Bootstrap(bootstrap, {
    hashFile: fileHash,
    readJson: json,
  });
  const fixture = requirePhase003EvidenceFixture(plan.evidenceRegressionFixture, {
    hashFile: fileHash,
    readJson: json,
  });
  const {
    plan: previousPlan,
    directory: previousDirectory,
    support: recordedSupport,
    reports: recordedReports,
  } = fixture;
  const supportOptions = {
    plan: previousPlan,
    directory: previousDirectory,
    reports: recordedReports,
    readJson: json,
  };
  const supportResult = requirePhase003SupportingCommands(recordedSupport, supportOptions);
  const rejections = [];
  const reject = (name, action, pattern) => {
    let failure;
    try {
      action();
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof Error, `${name}: corrupted evidence was accepted`);
    assert.match(failure.message, pattern);
    rejections.push({ name, rejected: true, reason: failure.message });
  };
  const selected = attachmentPaths.find((file) => file.endsWith(".png"));
  reject(
    "changed-screenshot",
    () =>
      requirePhase003Artifacts(
        browserReports,
        (file) => (file === selected ? "0".repeat(64) : fileHash(file)),
        directory,
      ),
    /ATTACHED_ARTIFACT/,
  );
  reject(
    "missing-screenshot",
    () =>
      requirePhase003Artifacts(
        browserReports,
        (file) => {
          if (file === selected) throw new Error("ENOENT: missing screenshot fixture");
          return fileHash(file);
        },
        directory,
      ),
    /ENOENT/,
  );
  const missingAttachment = structuredClone(browserReports);
  missingAttachment[0].details.artifacts.pop();
  reject(
    "omitted-attachment-reference",
    () => requirePhase003Artifacts(missingAttachment, fileHash, directory),
    /ATTACHED_ARTIFACT/,
  );
  const supplemental = { supplementalReportHashes: { [selected]: fileHash(selected) } };
  requirePhase003SupplementalHashes(supplemental, fileHash);
  reject(
    "changed-review-supplement",
    () => requirePhase003SupplementalHashes(supplemental, () => "0".repeat(64)),
    /SUPPLEMENTAL_HASH/,
  );
  reject(
    "changed-bootstrap-command",
    () =>
      requirePhase003Bootstrap(bootstrap, {
        hashFile: (file) =>
          file === bootstrap.commands[0].outputPath ? "0".repeat(64) : fileHash(file),
        readJson: json,
      }),
    /BOOTSTRAP_COMMAND/,
  );
  reject(
    "empty-supporting-commands",
    () => requirePhase003SupportingCommands({ ...recordedSupport, commands: [] }, supportOptions),
    /SUPPORT_COMMANDS/,
  );
  reject(
    "missing-case-command",
    () =>
      requirePhase003SupportingCommands(
        { ...recordedSupport, commands: recordedSupport.commands.slice(0, -1) },
        supportOptions,
      ),
    /SUPPORT_CASE_COVERAGE/,
  );
  reject(
    "wrong-case-count",
    () =>
      requirePhase003SupportingCommands(
        { ...recordedSupport, actualCaseCount: 16 },
        supportOptions,
      ),
    /SUPPORT_CASE_COUNT/,
  );
  const failedCommand = structuredClone(recordedSupport);
  failedCommand.commands[0].exitCode = 1;
  reject(
    "failed-supporting-command",
    () => requirePhase003SupportingCommands(failedCommand, supportOptions),
    /SUPPORT_COMMANDS/,
  );
  reject(
    "changed-raw-command",
    () =>
      requirePhase003SupportingCommands(recordedSupport, {
        ...supportOptions,
        readJson: (file) =>
          file.endsWith("/command-01.json")
            ? { ...json(file), stdout: "changed fixture output" }
            : json(file),
      }),
    /SUPPORT_RAW_RECORD/,
  );
  const noInstall = structuredClone(recordedReports);
  noInstall.find((report) => report.testCaseId === "Phase003:verifier-regression").observations =
    [];
  reject(
    "missing-isolated-npm-ci",
    () =>
      requirePhase003SupportingCommands(recordedSupport, { ...supportOptions, reports: noInstall }),
    /SUPPORT_NPM_CI/,
  );
  return {
    attachmentFiles: attachmentPaths.length,
    bootstrap: bootstrapResult,
    supportingCommandSchema: supportResult,
    immutableSchemaFixture: previousPlan.attemptId,
    fixtureIsCurrentProductAcceptance: false,
    mutationMode: "IN_MEMORY_ONLY",
    rejections,
  };
}

function regression() {
  const fixture = copyFixture({ installed: false, built: false });
  let passed = false;
  try {
    const configFile = path.join(fixture, ".scaffold/empty-gitconfig");
    fs.writeFileSync(configFile, "");
    const env = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: configFile };
    const git = (label, args, expected = 0) => command(label, "git", args, fixture, expected, env);
    git("fixture-init", ["init", "--initial-branch=main"]);
    for (const [key, value] of [
      ["user.name", "Serendipity Fixture"],
      ["user.email", "fixture@serendipity.invalid"],
      ["core.autocrlf", "false"],
      ["core.hooksPath", ".git/hooks"],
      ["commit.gpgsign", "false"],
    ])
      git("fixture-local-config", ["config", "--local", key, value]);
    const tracked = inventory(fixture).filter(
      (file) =>
        !file.startsWith(".git/") &&
        !file.startsWith(".scaffold/") &&
        !file.startsWith(`${json("docs/project-layout.json").roadmapRoot}/`),
    );
    git("fixture-stage-only-sources", ["add", "--", ...tracked]);
    git("fixture-check-whitespace", ["diff", "--cached", "--check"]);
    git("fixture-source-checkpoint", ["commit", "-m", "fixture: phase003 sources"]);
    command("clean-install-npm-ci", process.execPath, [npmCli, "ci", "--no-fund"], fixture, 0, env);
    command("clean-install-lint", process.execPath, [npmCli, "run", "lint"], fixture, 0, env);
    buildFixture(fixture, "clean-install-production-build");
    command(
      "clean-install-typecheck",
      process.execPath,
      [npmCli, "run", "typecheck"],
      fixture,
      0,
      env,
    );
    const initial = verifyFixture(fixture, "clean-install-nine-assertions", 0);
    assert.equal(
      git("clean-after-ci-and-build", ["status", "--porcelain=v1", "-uall"]).stdout.trim(),
      "",
    );
    const pkgPath = path.join(fixture, "package.json");
    const original = fs.readFileSync(pkgPath);
    const pkg = JSON.parse(original);
    Object.assign(pkg.scripts, {
      test: "vitest run",
      format: "prettier --write .",
      "format:check": "prettier --check .",
    });
    fs.writeFileSync(pkgPath, JSON.stringify(pkg));
    const futureScripts = verifyFixture(fixture, "future-scripts-accepted", 0);
    const futureFiles = {
      ".env.example": "# Isolated Phase003 compatibility fixture; no configured values.\n",
      "src/lib/env.ts": "export const fixtureEnvironment = process.env.NODE_ENV;\n",
      "vitest.config.ts": "export default {};\n",
      "src/components/ui/phase003-regression-fixture.tsx":
        "export const fixtureComponent = null;\n",
    };
    for (const [file, contents] of Object.entries(futureFiles)) {
      const target = path.join(fixture, file);
      assert(!fs.existsSync(target));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents, { flag: "wx" });
    }
    const futureFilesAccepted = verifyFixture(fixture, "future-files-and-env-reader-accepted", 0);
    assert.throws(() => phase003ProductScope(fixture), /Future-phase file/);
    assert.throws(() => phase003ComponentScope(fixture), /only the rendered Button/);
    const formattedOriginals = new Map();
    const formatting = [];
    for (const file of [
      homePagePath,
      "src/app/layout.tsx",
      "src/components/ui/button.tsx",
      "src/lib/utils.ts",
    ]) {
      const originalBytes = read(file, fixture);
      formattedOriginals.set(file, originalBytes);
      const source = ts.createSourceFile(
        file,
        originalBytes.toString(),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const printed = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(source);
      fs.writeFileSync(path.join(fixture, file), printed);
      formatting.push({
        path: file,
        beforeHash: hash(originalBytes),
        afterHash: hash(Buffer.from(printed)),
      });
    }
    const cssPath = "src/app/globals.css";
    const originalCss = read(cssPath, fixture);
    formattedOriginals.set(cssPath, originalCss);
    const cssTree = postcss.parse(originalCss.toString());
    cssTree.walkDecls("--font-sans", (declaration) => {
      declaration.value = declaration.value.replace(/,\s+/g, ",\n    ");
    });
    fs.writeFileSync(path.join(fixture, cssPath), cssTree.toString());
    formatting.push({
      path: cssPath,
      beforeHash: hash(originalCss),
      afterHash: hash(read(cssPath, fixture)),
    });
    assert(
      formatting.every((entry) => entry.beforeHash !== entry.afterHash),
      "Formatting fixtures must change real bytes",
    );
    const formatted = verifyFixture(fixture, "formatting-and-future-files-nine-assertions", 0);
    assert.throws(() => phase003ComponentScope(fixture), /Generated Button implementation/);
    for (const [file, bytes] of formattedOriginals)
      fs.writeFileSync(path.join(fixture, file), bytes);
    for (const file of Object.keys(futureFiles)) fs.unlinkSync(path.join(fixture, file));
    phase003ComponentScope(fixture);
    phase003ProductScope(fixture);
    delete pkg.scripts.build;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg));
    const noBuild = verifyFixture(fixture, "removed-build-rejected", 1, [1]);
    pkg.scripts.build = requiredScripts.build;
    pkg.scripts.typecheck = "tsc";
    fs.writeFileSync(pkgPath, JSON.stringify(pkg));
    const wrongTypecheck = verifyFixture(fixture, "changed-typecheck-rejected", 1, [1]);
    fs.writeFileSync(pkgPath, original);
    const restored = verifyFixture(fixture, "script-fixture-restored", 0);
    assert.equal(
      git("restored-clean-checkpoint", ["status", "--porcelain=v1", "-uall"]).stdout.trim(),
      "",
    );
    const prior = json(
      "docs/evidence/attempts/Phase003/checkpoint-recovery/existing-regressions-2.json",
    );
    assert.equal(prior.status, "PASS");
    assert.equal(prior.caseCount, 52);
    for (const [file, expected] of Object.entries(prior.testedSourceHashes))
      assert.equal(hash(read(file)), expected, `Upstream regression source drift: ${file}`);
    const evidenceBindings = evidenceBindingRegression();
    passed = true;
    return {
      initial,
      futureScripts,
      futureFilesAccepted,
      formatted,
      formatting,
      phase003ScopeStillEnforced: true,
      noBuild,
      wrongTypecheck,
      restored,
      evidenceBindings,
      cleanWorktree: true,
      globalGitIgnoreUsed: false,
      upstreamCheckpointCases: prior.caseCount,
      upstreamCheckpointObservations: prior.observationCount,
    };
  } finally {
    if (passed) removeFixture(fixture);
    else observations.push({ retainedFixture: fixture });
  }
}

async function runCase(name) {
  const item = plan.cases.find((candidate) => candidate.testCaseId === `Phase003:${name}`);
  assert(item, `Unknown case: ${name}`);
  assert(!fs.existsSync(path.join(root, item.outputPath)), "Case output exists; use a new attempt");
  const begin = performance.now();
  let details;
  if (name.startsWith("assertion-")) {
    const index = Number(name.slice("assertion-".length)) - 1;
    const result = checks([index])[0];
    assert.equal(result.status, "PASS", result.error);
    details = result.details;
    if (index === 0)
      assert.deepEqual(
        Object.keys(json("package.json").scripts).sort(),
        Object.keys(requiredScripts).sort(),
        "Phase003 Gate requires exactly six scripts",
      );
    if (index === 1) details.runtimeMutations = runtimeMutations();
    if (index === 5) details.phase003Scope = phase003ComponentScope();
    if (index === 6) details.phase003Scope = phase003ProductScope();
    if (index === 7) {
      const fixture = copyFixture({ built: false });
      let passed = false;
      try {
        verifyFixture(fixture, "missing-next-output-rejected", 1, [8], 8);
        passed = true;
      } finally {
        if (passed) removeFixture(fixture);
      }
    }
  } else if (name.startsWith("negative-")) details = await negative(name);
  else if (name === "dev-http")
    details = await withDev(async () => {
      const result = command("dev-curl-http-200", "curl.exe", [
        "-s",
        "-o",
        "NUL",
        "-w",
        "%{http_code}",
        "http://localhost:3000/",
      ]);
      assert.equal(result.stdout.trim(), "200");
      return { httpStatus: 200, url: "http://localhost:3000/", processReleaseRequired: true };
    });
  else if (["browser-title", "responsive-layout"].includes(name))
    details = await browserCheck(name, item.outputPath.replace(/\.json$/, ""));
  else details = regression();
  const sourceHashes = Object.fromEntries(plan.sourcePaths.map((file) => [file, hash(read(file))]));
  writeExclusive(item.outputPath, {
    testCaseId: item.testCaseId,
    command: item.command,
    status: "PASS",
    exitCode: 0,
    numerator: item.denominator,
    denominator: item.denominator,
    inputPath: item.inputPath,
    inputHash: hash(read(item.inputPath)),
    planHash: hash(read(planPath)),
    sourceHashes,
    environment: "ISOLATED_SYNTHETIC",
    productionTraffic: false,
    durationMs: Math.round(performance.now() - begin),
    observations,
    details,
  });
  console.warn(
    JSON.stringify({ status: "PASS", testCaseId: item.testCaseId, outputPath: item.outputPath }),
  );
}

try {
  const caseIndex = process.argv.indexOf("--case");
  const checkIndex = process.argv.indexOf("--check");
  if (caseIndex >= 0) await runCase(process.argv[caseIndex + 1]);
  else {
    const indices = checkIndex >= 0 ? [Number(process.argv[checkIndex + 1]) - 1] : undefined;
    if (indices)
      assert(indices.every((index) => Number.isInteger(index) && index >= 0 && index < 9));
    const results = checks(indices);
    console.warn(`PHASE003_ASSERTIONS ${JSON.stringify(results)}`);
    if (results.some((result) => result.status !== "PASS")) process.exitCode = 1;
  }
} catch (error) {
  const attemptPath = `docs/evidence/attempts/Phase003/${plan.attemptId}/attempt.json`;
  if (process.argv.includes("--case") && !fs.existsSync(path.join(root, attemptPath)))
    writeExclusive(attemptPath, {
      phase: 3,
      attemptId: plan.attemptId,
      status: "FAIL",
      artifactCommit: null,
      failure: error.stack,
      observations,
      planHash: hash(read(planPath)),
      generatedAt: new Date().toISOString(),
    });
  console.error(error.stack);
  process.exitCode = 1;
}
