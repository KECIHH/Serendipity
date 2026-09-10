import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { root, configPath, imageDigest, json, write, docker, sql, redact, assertDatabaseTarget } from "./phase007-runtime.mjs";

async function database() {
  if (fs.existsSync(path.join(root, configPath))) {
    const config = json(configPath);
    await assertDatabaseTarget(config);
    const marker = await sql("SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database();");
    assert.equal(marker.stdout.trim(), `serendipity-phase007-disposable:${config.runId}`);
    return;
  }
  const runId = randomBytes(6).toString("hex");
  const config = {
    runId, image: imageDigest, user: "phase007_runner", password: randomBytes(24).toString("hex"),
    database: `phase007_disposable_${runId}`, network: `serendipity-phase007-${runId}`,
    containerName: `serendipity-phase007-${runId}`,
  };
  const records = [];
  records.push(await docker(["image", "inspect", "--format", "{{json .RepoDigests}}", imageDigest]));
  records.push(await docker(["network", "create", "--opt", "com.docker.network.bridge.enable_ip_masquerade=false", "--label", `serendipity.run=${runId}`, config.network]));
  const created = await docker([
    "run", "--detach", "--name", config.containerName, "--label", "serendipity.phase=007", "--label", `serendipity.run=${runId}`,
    "--network", config.network, "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data:rw,size=536870912",
    "--env", "POSTGRES_USER", "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_DB", imageDigest,
  ], { env: { POSTGRES_USER: config.user, POSTGRES_PASSWORD: config.password, POSTGRES_DB: config.database } });
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
  records.push(await sql(`COMMENT ON DATABASE "${config.database}" IS 'serendipity-phase007-disposable:${runId}';`, "postgres"));
  const marker = await sql("SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database();");
  records.push(marker);
  assert.equal(marker.stdout.trim(), target.marker);
  const version = await sql("SHOW server_version;");
  records.push(version);
  assert.match(version.stdout, /^17\./);
  write("docs/evidence/attempts/Phase007/setup/postgresql.json", {
    records, target, version: version.stdout.trim(), marker: marker.stdout.trim(),
    syntheticUsers: true, productionTraffic: false, image: imageDigest,
    dataStorage: "TASK_OWNED_TMPFS", loopbackOnly: true, networkMasquerading: false,
  });
}

try {
  assert(process.argv.includes("--database"), "Use --database");
  await database();
} catch (error) {
  console.error(redact(error.stack));
  process.exitCode = 1;
}
