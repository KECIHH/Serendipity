import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file));
const json = (file) => JSON.parse(read(file));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const plan = json("docs/phase-plans/Phase003.json");
const input = json("docs/phase-plans/Phase003-inputs.json");
const setup = "docs/evidence/attempts/Phase003/setup";
const toolsRoot = path.join(root, ".scaffold/tools");
const npmCli = path.join(toolsRoot, "node_modules/npm/bin/npm-cli.js");
const npxCli = path.join(toolsRoot, "node_modules/npm/bin/npx-cli.js");
const commands = [];
const resume = process.argv.includes("--resume");
if (resume) {
  assert(plan.previousAttempts.length > 0, "Resume requires an archived failed attempt");
  for (const file of fs
    .readdirSync(path.join(root, setup))
    .filter((file) => /^\d+-.*\.json$/.test(file))
    .sort()) {
    const record = json(`${setup}/${file}`);
    commands.push({
      command: [record.executable, ...record.arguments].join(" "),
      exitCode: record.exitCode,
      outputPath: `${setup}/${file}`,
      outputHash: sha256(read(`${setup}/${file}`)),
    });
  }
}
const env = { ...process.env };
const inheritedPath = env.Path ?? env.PATH;
for (const key of Object.keys(env)) {
  if (
    /^(npm_config_|next_private_test_version$|node_env$|node_tls_reject_unauthorized$|path$|appdata$|localappdata$|xdg_config_home$)/i.test(
      key,
    )
  )
    delete env[key];
}
Object.assign(env, {
  Path: `${path.join(toolsRoot, "node_modules/.bin")}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${inheritedPath}`,
  NPM_CONFIG_USERCONFIG: path.join(toolsRoot, "npmrc"),
  NPM_CONFIG_GLOBALCONFIG: path.join(toolsRoot, "global-npmrc"),
  NPM_CONFIG_CACHE: path.join(toolsRoot, "cache"),
  XDG_CONFIG_HOME: path.join(toolsRoot, "config"),
  APPDATA: path.join(toolsRoot, "appdata"),
  LOCALAPPDATA: path.join(toolsRoot, "local"),
  NEXT_TELEMETRY_DISABLED: "1",
  CI: "1",
});

function write(file, value) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function run(label, executable, args, cwd = root) {
  const startedAt = new Date().toISOString();
  const begin = performance.now();
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 900_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const record = {
    label,
    executable,
    arguments: args,
    cwd,
    startedAt,
    durationMs: Math.round(performance.now() - begin),
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message ?? null,
  };
  const outputPath = `${setup}/${String(commands.length + 1).padStart(2, "0")}-${label}.json`;
  write(outputPath, record);
  commands.push({
    command: [executable, ...args].join(" "),
    exitCode: result.status,
    outputPath,
    outputHash: sha256(read(outputPath)),
  });
  console.warn(
    JSON.stringify({ label, exitCode: result.status, durationMs: record.durationMs, outputPath }),
  );
  assert.equal(result.status, 0, `${label}: ${record.stderr || record.stdout || record.error}`);
  return record;
}

function files(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    assert(!entry.isSymbolicLink(), `Unexpected generated symlink: ${entry.name}`);
    const relative = path.posix.join(prefix, entry.name);
    return entry.isDirectory() ? files(path.join(directory, entry.name), relative) : [relative];
  });
}

function pinPackage() {
  const pkg = json("package.json");
  const lock = json("package-lock.json");
  pkg.name = "serendipity";
  pkg.scripts = {
    dev: "next dev",
    build: "next build",
    start: "next start",
    lint: "eslint . --max-warnings 0",
    typecheck: "tsc --noEmit",
    "verify:phase003": "node scripts/verify-phase003.mjs",
  };
  pkg.engines = { node: plan.runtimePolicy.node, npm: plan.runtimePolicy.npm };
  pkg.packageManager = `npm@${plan.runtimePolicy.npm}`;
  for (const group of ["dependencies", "devDependencies"]) {
    for (const name of Object.keys(pkg[group] ?? {})) {
      const version = lock.packages[`node_modules/${name}`]?.version;
      assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, name);
      pkg[group][name] = version;
    }
  }
  assert.equal(pkg.dependencies.next, plan.runtimePolicy.next);
  assert.equal(pkg.devDependencies["eslint-config-next"], plan.runtimePolicy.eslintConfigNext);
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

try {
  assert.equal(plan.phase, 3);
  assert.equal(json("docs/roadmap-run.json").completedThrough, 2);
  assert(
    !fs.existsSync(path.join(root, `${setup}/bootstrap.json`)),
    "Setup is already complete; do not overwrite its receipt",
  );
  for (const pin of input.pinnedInputs) assert.equal(sha256(read(pin.path)), pin.sha256, pin.id);
  const protectedFiles = spawnSync("git", ["ls-files", "-z", "--", "docs"], {
    cwd: root,
    windowsHide: true,
  })
    .stdout.toString()
    .split("\0")
    .filter(Boolean);
  const protectedHashes = Object.fromEntries(
    protectedFiles.map((file) => [file, sha256(read(file))]),
  );
  const nodeVersion = run("node-version", process.execPath, ["--version"]).stdout.trim();
  const npmVersion = run("npm-version", process.execPath, [npmCli, "--version"]).stdout.trim();
  const createNextAppVersion = run("create-next-app-version", process.execPath, [
    npxCli,
    "--yes",
    `create-next-app@${plan.runtimePolicy.createNextApp}`,
    "--version",
  ]).stdout.trim();
  const shadcnVersion = run("shadcn-version", process.execPath, [
    npxCli,
    "--yes",
    `shadcn@${plan.runtimePolicy.shadcn}`,
    "--version",
  ]).stdout.trim();
  assert.equal(nodeVersion, `v${plan.runtimePolicy.node}`);
  assert.equal(npmVersion, plan.runtimePolicy.npm);
  assert.equal(createNextAppVersion, plan.runtimePolicy.createNextApp);
  assert.equal(shadcnVersion, plan.runtimePolicy.shadcn);
  const temporary = resume
    ? json(`${setup}/temporary.json`).temporary
    : path.join(root, ".scaffold", `phase003-${randomUUID()}`);
  assert.equal(path.dirname(temporary), fs.realpathSync(path.join(root, ".scaffold")));
  if (!resume) {
    assert(!fs.existsSync(temporary));
    run("ignored-temp", "git", [
      "check-ignore",
      "--no-index",
      "--",
      `${path.relative(root, temporary).replaceAll("\\", "/")}/package.json`,
    ]);
    write(`${setup}/temporary.json`, {
      temporary,
      phaseStartCommit: input.phaseStartCommit,
      nextPrivateTestVersionInherited: false,
      isolatedCliPreferences: true,
    });
    run("create-next-app", process.execPath, [
      npxCli,
      "--yes",
      `create-next-app@${plan.runtimePolicy.createNextApp}`,
      temporary,
      "--ts",
      "--tailwind",
      "--eslint",
      "--app",
      "--src-dir",
      "--import-alias",
      "@/*",
      "--use-npm",
      "--disable-git",
      "--yes",
    ]);
  } else
    assert.equal(
      json(`${setup}/06-create-next-app.json`).exitCode,
      0,
      "Original scaffold must have succeeded",
    );
  assert(!fs.existsSync(path.join(temporary, ".git")), "Nested Git repository is forbidden");
  const copyRoots = [
    "package.json",
    "package-lock.json",
    "next.config.ts",
    "tsconfig.json",
    "postcss.config.mjs",
    "eslint.config.mjs",
    "public",
    "src",
  ];
  if (!resume)
    for (const file of copyRoots)
      assert(!fs.existsSync(path.join(root, file)), `Refusing to overwrite ${file}`);
  const copied = [];
  for (const entry of copyRoots) {
    const source = path.join(temporary, entry);
    const paths = fs.statSync(source).isDirectory()
      ? files(source).map((file) => `${entry}/${file}`)
      : [entry];
    for (const file of paths) {
      const bytes = fs.readFileSync(path.join(temporary, file));
      const target = path.join(root, file);
      if (!resume) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes, { flag: "wx" });
        assert.equal(sha256(fs.readFileSync(target)), sha256(bytes));
      } else assert(fs.existsSync(target), `Original copied file missing: ${file}`);
      copied.push({ path: file, sourceSha256: sha256(bytes), copiedSha256: sha256(bytes) });
    }
  }
  const existingIgnoreHash = resume
    ? sha256(
        spawnSync("git", ["show", `${input.phaseStartCommit}:.gitignore`], {
          cwd: root,
          windowsHide: true,
        }).stdout,
      )
    : sha256(read(".gitignore"));
  if (!resume)
    fs.appendFileSync(
      path.join(root, ".gitignore"),
      "\n# Next.js scaffold output\n/out/\n/.vercel/\nnext-env.d.ts\n*.tsbuildinfo\n",
    );
  const ignoreMerge = {
    sourceHash: sha256(fs.readFileSync(path.join(temporary, ".gitignore"))),
    existingHash: existingIgnoreHash,
    mergedHash: sha256(read(".gitignore")),
    policy: input.layoutAdaptations.existingGitignore,
  };
  if (!resume) {
    pinPackage();
    run("initial-lock", process.execPath, [npmCli, "install", "--package-lock-only", "--no-fund"]);
    run("initial-ci", process.execPath, [npmCli, "ci", "--no-fund"]);
    run("shadcn-init", process.execPath, [
      npxCli,
      "--yes",
      `shadcn@${plan.runtimePolicy.shadcn}`,
      "init",
      "-d",
    ]);
    run("shadcn-button", process.execPath, [
      npxCli,
      "--yes",
      `shadcn@${plan.runtimePolicy.shadcn}`,
      "add",
      "button",
    ]);
  } else {
    assert.equal(json(`${setup}/09-shadcn-init.json`).exitCode, 0);
    assert.equal(json(`${setup}/10-shadcn-button.json`).exitCode, 0);
    const lockRoot = path.join(root, ".scaffold", `postcss-lock-${randomUUID()}`);
    assert.equal(path.dirname(lockRoot), fs.realpathSync(path.join(root, ".scaffold")));
    fs.mkdirSync(lockRoot);
    fs.copyFileSync(path.join(root, "package.json"), path.join(lockRoot, "package.json"));
    run(
      "isolated-security-lock",
      process.execPath,
      [npmCli, "install", "--package-lock-only", "--no-fund", "--prefix", lockRoot],
      lockRoot,
    );
    const repaired = JSON.parse(fs.readFileSync(path.join(lockRoot, "package-lock.json")));
    assert.equal(
      (
        repaired.packages["node_modules/next/node_modules/postcss"] ??
        repaired.packages["node_modules/postcss"]
      ).version,
      "8.5.28",
    );
    fs.copyFileSync(path.join(lockRoot, "package-lock.json"), path.join(root, "package-lock.json"));
  }
  const generatedButton = {
    path: "src/components/ui/button.tsx",
    sha256: sha256(read("src/components/ui/button.tsx")),
  };
  if (!resume)
    run("lucide-exact", process.execPath, [
      npmCli,
      "install",
      "--save-exact",
      `lucide-react@${plan.toolPolicy.lucideReact}`,
      "--no-fund",
    ]);
  pinPackage();
  run("final-lock", process.execPath, [npmCli, "install", "--package-lock-only", "--no-fund"]);
  if (resume) {
    const finalLock = json("package-lock.json");
    assert.equal(
      (
        finalLock.packages["node_modules/next/node_modules/postcss"] ??
        finalLock.packages["node_modules/postcss"]
      ).version,
      "8.5.28",
      "Do not install a stale vulnerable lock",
    );
  }
  run("final-ci", process.execPath, [npmCli, "ci", "--no-fund"]);
  const auditRecord = run("production-audit", process.execPath, [
    npmCli,
    "audit",
    "--omit=dev",
    "--audit-level=high",
    "--json",
  ]);
  const audit = JSON.parse(auditRecord.stdout);
  assert.equal(audit.metadata.vulnerabilities.high, 0);
  assert.equal(audit.metadata.vulnerabilities.critical, 0);
  run("peer-dependencies", process.execPath, [npmCli, "ls", "--all", "--json"]);
  const lock = json("package-lock.json");
  assert.equal(lock.lockfileVersion, 3);
  const registry = json(".scaffold/phase003-registry-probe.json");
  if (resume) registry.packages.push(json(".scaffold/phase003-postcss-metadata.json"));
  for (const name of ["next", "eslint-config-next", "lucide-react"])
    assert.equal(
      lock.packages[`node_modules/${name}`].integrity,
      registry.packages.find((entry) => entry.name === name).integrity,
      name,
    );
  const baseline = {
    schemaVersion: "runtime-baseline-v1",
    producerPhase: 3,
    generatedAt: new Date().toISOString(),
    manifestPath: "Serendipity · 际遇/docs/roadmap-execution-manifest.json",
    manifestHash: input.manifestHash,
    runtimePolicy: plan.runtimePolicy,
    observedVersions: {
      node: nodeVersion,
      npm: npmVersion,
      createNextApp: createNextAppVersion,
      shadcn: shadcnVersion,
      next: lock.packages["node_modules/next"].version,
      eslintConfigNext: lock.packages["node_modules/eslint-config-next"].version,
    },
    lockfileVersion: lock.lockfileVersion,
    nodeExecutableSha256: sha256(fs.readFileSync(process.execPath)),
    registry: registry.packages,
    toolPaths: {
      npmCli: ".scaffold/tools/node_modules/npm/bin/npm-cli.js",
      npxCli: ".scaffold/tools/node_modules/npm/bin/npx-cli.js",
      playwright: ".scaffold/tools/node_modules/playwright/index.mjs",
      playwrightBrowsers: ".scaffold/tools/browsers",
    },
    browser: {
      playwrightVersion: plan.toolPolicy.playwright,
      chromiumVersion: "140.0.7339.186",
      build: 1193,
    },
    lucideReact: plan.toolPolicy.lucideReact,
    securityBaseline: "Next.js 15.5.24; CVE-2026-75604 fixed baseline",
    auditReceiptPath: commands.findLast((command) =>
      command.outputPath.endsWith("-production-audit.json"),
    ).outputPath,
    dependencyVersions: {
      ...json("package.json").dependencies,
      ...json("package.json").devDependencies,
    },
    nextPrivateTestVersionInherited: false,
  };
  write("docs/runtime-baseline.json", baseline);
  for (const [file, hash] of Object.entries(protectedHashes))
    assert.equal(sha256(read(file)), hash, `Protected document changed: ${file}`);
  write(`${setup}/bootstrap.json`, {
    status: "PASS",
    phase: 3,
    phaseStartCommit: input.phaseStartCommit,
    temporary,
    copyWhitelist: copyRoots,
    copied,
    ignoreMerge,
    generatedButton,
    protectedDocumentHashes: protectedHashes,
    commands,
    runtimeBaselineHash: sha256(read("docs/runtime-baseline.json")),
    artifactAcquisitionNetwork: "OFFICIAL_NPM_REGISTRY_AND_SHADCN_PUBLIC_REGISTRY",
    productionTraffic: false,
  });
  console.warn(
    JSON.stringify({
      status: "PASS",
      scope: "PHASE003_SCAFFOLD_SETUP",
      copied: copied.length,
      temporary,
    }),
  );
} catch (error) {
  const attempt = `docs/evidence/attempts/Phase003/${plan.attemptId}/attempt.json`;
  if (!fs.existsSync(path.join(root, attempt)))
    write(attempt, {
      phase: 3,
      attemptId: plan.attemptId,
      status: "FAIL",
      artifactCommit: null,
      command: "node scripts/prepare-phase003.mjs",
      failure: error.message,
      commands,
      planHash: sha256(read("docs/phase-plans/Phase003.json")),
      generatedAt: new Date().toISOString(),
      temporaryRetained: true,
    });
  console.error(error.message);
  process.exitCode = 1;
}
