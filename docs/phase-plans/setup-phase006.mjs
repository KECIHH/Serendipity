import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { root, configPath, imageDigest, json, write, hash, npm, docker, command, assertDatabaseTarget } from "./phase006-runtime.mjs";

async function dependencies() {
  const records = [];
  for (const args of [
    ["install", "--save-exact", "@prisma/client@6.19.0", "tr46@6.0.0", "--no-audit", "--no-fund"],
    ["install", "--save-dev", "--save-exact", "prisma@6.19.0", "@types/tr46@5.0.1", "--no-audit", "--no-fund"],
  ]) records.push(await npm(args, { env: { NPM_CONFIG_OFFLINE: "false" } }));
  const runtime = json("docs/runtime-baseline.json");
  const pkg = json("package.json");
  const lock = json("package-lock.json");
  const additions = { "@prisma/client": "6.19.0", prisma: "6.19.0", tr46: "6.0.0", "@types/tr46": "5.0.1" };
  for (const [name, version] of Object.entries(additions)) {
    assert.equal(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name], version);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
    runtime.dependencyVersions[name] = version;
    if (!runtime.registry.some((entry) => entry.name === name)) runtime.registry.push({ name, version, registry: `https://registry.npmjs.org/${name}/${version}`, integrity: lock.packages[`node_modules/${name}`].integrity, tarball: lock.packages[`node_modules/${name}`].resolved, producerPhase: 6 });
  }
  runtime.dependencyAdditions.push({ phase: 6, command: records.map((record) => record.command).join(" then "), dependencies: additions, receiptPath: "docs/evidence/attempts/Phase006/setup/dependencies.json" });
  write("docs/runtime-baseline.json", runtime, false);
  write("docs/evidence/attempts/Phase006/setup/dependencies.json", { records, additions, packageHash: hash("package.json"), lockHash: hash("package-lock.json"), networkPurpose: "PUBLIC_ARTIFACT_PREPARATION", productionTraffic: false });
}

async function database() {
  if (fs.existsSync(path.join(root, configPath))) {
    await assertDatabaseTarget();
    return;
  }
  const runId = randomBytes(6).toString("hex");
  const config = { runId, image: imageDigest, user: "phase006_runner", password: randomBytes(24).toString("hex"), database: `phase006_disposable_${runId}`, network: `serendipity-phase006-${runId}`, containerName: `serendipity-phase006-${runId}` };
  const records = [];
  records.push(await docker(["image", "inspect", "--format", "{{json .RepoDigests}}", imageDigest]));
  records.push(await docker(["network", "create", "--opt", "com.docker.network.bridge.enable_ip_masquerade=false", "--label", `serendipity.run=${runId}`, config.network]));
  const created = await docker(["run", "--detach", "--name", config.containerName, "--label", "serendipity.phase=006", "--label", `serendipity.run=${runId}`, "--network", config.network, "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data:rw,size=536870912", "--env", "POSTGRES_USER", "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_DB", imageDigest], { env: { POSTGRES_USER: config.user, POSTGRES_PASSWORD: config.password, POSTGRES_DB: config.database } });
  records.push(created);
  config.containerId = created.stdout.trim();
  const port = await docker(["port", config.containerId, "5432/tcp"]);
  records.push(port);
  assert.match(port.stdout.trim(), /^127\.0\.0\.1:\d+$/);
  config.port = Number(port.stdout.trim().split(":")[1]);
  config.url = `postgresql://${config.user}:${config.password}@127.0.0.1:${config.port}/${config.database}?connect_timeout=3`;
  write(configPath, config);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await docker(["exec", config.containerId, "pg_isready", "-U", config.user, "-d", config.database], { expected: null });
    records.push(result);
    if (result.exitCode === 0) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(ready, "Disposable PostgreSQL did not start");
  const target = await assertDatabaseTarget(config);
  const version = await docker(["exec", config.containerId, "psql", "-X", "-U", config.user, "-d", config.database, "-Atc", "SHOW server_version;"]);
  assert.match(version.stdout, /^17\./);
  records.push(version);
  write("docs/evidence/attempts/Phase006/setup/postgresql.json", { records, target, version: version.stdout.trim(), syntheticUsers: true, productionTraffic: false, preparationImageTag: "postgres:17-bookworm", image: imageDigest, dataStorage: "TASK_OWNED_TMPFS", loopbackOnly: true, networkMasquerading: false });
}

try {
  if (process.argv.includes("--dependencies")) await dependencies();
  else if (process.argv.includes("--database")) await database();
  else if (process.argv.includes("--versions")) {
    await command("node --version", ["--version"]);
    await npm(["--version"]);
  } else throw new Error("Use --dependencies, --database or --versions");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
