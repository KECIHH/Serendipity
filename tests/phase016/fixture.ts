import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";
import type { TravelRecordOwner } from "@/server/anonymous-owner";
import { authCookieSettings, encodeAuthCookie } from "@/server/auth/cookie";
import { hashSessionToken } from "@/server/auth/session-service";
import { bootstrapAiGovernance, enableMockAi } from "@/server/services/ai-governance-service";
import { issueOrReuseAnonymousSession, resolveExistingOwner } from "@/server/chat/owner";
import { createOrResumeChatCommand } from "@/server/chat/command-service";
import { claimTask, type TaskLease } from "@/server/tasks/durable-task";
import { claimCommand } from "@/server/chat/command-state";
import { openChatEventStream } from "@/server/chat/sse";
import type { ChatEventEnvelope } from "@/lib/chat-stream";

export function phase016Config() {
  const file = process.env.PHASE016_FIXTURE_CONFIG;
  assert(file, "Phase016 requires its isolated fixture configuration");
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as {
    database: string;
    runId: string;
    url: string;
    appUrl: string;
    appUser: string;
    authSecret: string;
    encryptionKey: string;
  };
  assert.match(config.database, /^phase016_disposable_[a-f0-9]{12}$/);
  for (const source of [config.url, config.appUrl]) {
    const url = new URL(source);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, "/" + config.database);
  }
  return config;
}
export const phase016Client = () =>
  new PrismaClient({ datasourceUrl: phase016Config().appUrl, log: [] });
export const phase016OwnerClient = () =>
  new PrismaClient({ datasourceUrl: phase016Config().url, log: [] });
export async function initializeFixture(client: PrismaClient) {
  const config = phase016Config();
  const [identity] = await client.$queryRaw<
    Array<{ name: string; marker: string; superuser: boolean; owner: boolean }>
  >`
    SELECT current_database() AS name,shobj_description(d.oid,'pg_database') AS marker,r.rolsuper AS superuser,
      d.datdba=r.oid AS owner FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`;
  assert.equal(identity.name, config.database);
  assert.equal(identity.marker, `serendipity-phase016-disposable:${config.runId}`);
  assert.equal(identity.superuser, false);
  assert.equal(identity.owner, false);
  await client.$transaction((tx) => bootstrapAiGovernance(tx));
  const enabled = await client.systemConfig.findUniqueOrThrow({
    where: { key: "ai.calls.enabled" },
  });
  if (enabled.valueJson !== true) {
    const actor = await client.user.upsert({
      where: { email: "phase015-admin@serendipity.invalid" },
      create: {
        email: "phase015-admin@serendipity.invalid",
        passwordHash: "synthetic",
        role: "ADMIN",
      },
      update: {},
    });
    await enableMockAi(client, {
      actorId: actor.id,
      runId: config.database,
      databaseUrl: config.appUrl,
    });
  }
}
export function observe(fixture: string, scenario: string, counts: Record<string, unknown>) {
  if (process.env.PHASE016_OBSERVATIONS)
    fs.appendFileSync(
      process.env.PHASE016_OBSERVATIONS,
      JSON.stringify({ fixture, scenario, ...counts }) + "\n",
    );
}
export async function anonymousOwner(client: PrismaClient) {
  const issued = issueOrReuseAnonymousSession(new Request(env.AUTH_URL));
  const cookie = issued.cookieHeader.split(";")[0];
  const request = new Request(env.AUTH_URL, { headers: { cookie } });
  const owner = await resolveExistingOwner(request, { db: client });
  assert(owner);
  return { owner, cookie, request, issued };
}
export async function loginOwner(client: PrismaClient, role: "USER" | "ADMIN" = "USER") {
  const user = await client.user.create({
    data: { email: `fixture-${randomUUID()}@serendipity.invalid`, passwordHash: "synthetic", role },
  });
  const [{ now }] = await client.$queryRaw<Array<{ now: Date }>>`SELECT public.auth_now() AS now`;
  const token = randomBytes(32).toString("base64url"),
    expiresAt = new Date(now.getTime() + 43200000);
  const session = await client.authSession.create({
    data: {
      userId: user.id,
      tokenHash: hashSessionToken(token)!,
      audience: role,
      sessionVersion: user.sessionVersion,
      issuedAt: now,
      createdAt: now,
      expiresAt,
    },
  });
  const name = authCookieSettings().sessionToken.name;
  const value = await encodeAuthCookie({
    token: { opaqueToken: token, absoluteExpiresAt: expiresAt.getTime() },
    secret: env.AUTH_SECRET,
    salt: name,
  });
  const cookie = `${name}=${value}`,
    request = new Request(env.AUTH_URL, { headers: { cookie } });
  const owner = await resolveExistingOwner(request, { db: client });
  assert(owner);
  return { owner, request, cookie, user, session, token };
}
export async function record(
  client: PrismaClient,
  owner: TravelRecordOwner,
  status: "DRAFT" | "ARCHIVED" | "FINALIZED" = "DRAFT",
) {
  return client.travelRecord.create({
    data: {
      userId: owner.userId ?? null,
      anonTokenHash: owner.anonTokenHash ?? null,
      title: "合成会话",
      status,
    },
  });
}
export function commandInput(owner: TravelRecordOwner, travelRecordId: string) {
  return {
    owner,
    travelRecordId,
    message: "请说明这条合成行程的修改请求",
    clientMessageId: randomUUID(),
    idempotencyKey: randomUUID(),
    traceId: "tr_" + randomUUID(),
  };
}
export async function accepted(client: PrismaClient, owner?: TravelRecordOwner) {
  const identity = owner ?? (await anonymousOwner(client)).owner,
    travel = await record(client, identity),
    input = commandInput(identity, travel.id);
  return { owner: identity, travel, input, ...(await createOrResumeChatCommand(client, input)) };
}
export async function leased(
  client: PrismaClient,
  commandId: string,
  leaseMs = 10000,
): Promise<TaskLease> {
  return client.$transaction(async (tx) => {
    const claim = await claimTask(tx, {
      kind: "CHAT_COMMAND",
      aggregateId: commandId,
      leaseOwner: "test_" + randomUUID().replaceAll("-", ""),
      leaseMs,
    });
    assert(claim);
    const lease = {
      taskId: claim.task.id,
      leaseOwner: claim.task.leaseOwner!,
      fencingToken: claim.task.fencingToken,
    };
    assert(await claimCommand(tx, { ...lease, commandId }));
    return lease;
  });
}
export const finalContent = {
  schemaVersion: 1 as const,
  kind: "MESSAGE" as const,
  text: "完整且已校验的合成回复",
};
export async function commandCounts(client: PrismaClient, commandId: string) {
  const command = await client.chatCommand.findUniqueOrThrow({ where: { id: commandId } });
  return {
    status: command.status,
    users: await client.chatMessage.count({ where: { commandId, role: "USER" } }),
    assistants: await client.chatMessage.count({ where: { commandId, role: "ASSISTANT" } }),
    terminal: await client.chatCommandEvent.count({
      where: { aggregateId: commandId, type: { not: "message.accepted" } },
    }),
    deltas:
      (await client.chatCommandEvent.count({
        where: { aggregateId: commandId, type: "assistant.delta" },
      })) +
      (await client.outbox.count({ where: { aggregateId: commandId, type: "assistant.delta" } })),
  };
}
export async function waitUntil(predicate: () => Promise<boolean> | boolean, timeout = 12000) {
  const until = Date.now() + timeout;
  while (!(await predicate())) {
    assert(Date.now() < until, "Fixture deadline exceeded");
    await new Promise((r) => setTimeout(r, 10));
  }
}
export interface WorkerNotice {
  type: string;
  stage?: string;
  taskId?: string;
  leaseOwner?: string;
  fencingToken?: number;
  attemptCount?: number;
  checkpoint?: unknown;
  result?: unknown;
  pid?: number;
  eventId?: string;
}
export async function worker(input: Record<string, unknown>) {
  const child = spawn(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", path.resolve("tests/phase016/worker.ts")],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: phase016Config().appUrl,
        AUTH_SECRET: env.AUTH_SECRET,
        ENCRYPTION_KEY: env.ENCRYPTION_KEY,
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const notices: WorkerNotice[] = [];
  let closed = false;
  let diagnostics = "";
  child.stdout?.on("data", (b) => {
    diagnostics += b.toString();
  });
  child.stderr?.on("data", (b) => {
    diagnostics += b.toString();
  });
  child.on("message", (m) => notices.push(m as WorkerNotice));
  child.on("exit", () => {
    closed = true;
  });
  child.send(input);
  return {
    child,
    notices,
    async wait(type: string, stage?: string) {
      await waitUntil(
        () => notices.some((n) => n.type === type && (!stage || n.stage === stage)) || closed,
      );
      const n = notices.find((n) => n.type === type && (!stage || n.stage === stage));
      assert(
        n,
        `Worker exited before ${type}: ${JSON.stringify(notices)} ${diagnostics.slice(-600)}`,
      );
      return n;
    },
    release() {
      if (child.connected) child.send({ action: "continue" });
    },
    async close() {
      if (!closed) child.kill("SIGKILL");
      await waitUntil(() => closed);
    },
  };
}
export async function stream(client: PrismaClient, owner: TravelRecordOwner, commandId: string) {
  const response = await openChatEventStream(
    client,
    { owner, aggregateId: commandId },
    { databaseUrl: phase016Config().appUrl },
  );
  assert.equal(response.status, 200);
  const reader = response.body!.getReader(),
    events: ChatEventEnvelope[] = [];
  let pending = "";
  const reading = (async () => {
    for (;;) {
      const row = await reader.read();
      if (row.done) break;
      pending += new TextDecoder().decode(row.value);
      let offset;
      while ((offset = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, offset);
        pending = pending.slice(offset + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        if (data) events.push(JSON.parse(data.slice(6)));
      }
    }
  })();
  return {
    events,
    reading,
    async close() {
      await reader.cancel();
      await reading;
    },
  };
}
export async function stopChild(child: ChildProcess) {
  if (child.connected) child.disconnect();
  child.kill("SIGKILL");
}
