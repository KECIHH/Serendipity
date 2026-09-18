import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";
import { bootstrapAiGovernance, enableMockAi } from "@/server/services/ai-governance-service";
import { authCookieSettings, encodeAuthCookie } from "@/server/auth/cookie";
import { MockAiProvider } from "@/server/ai/mock-provider";
import { debugTaskAggregateId, debugTaskHandler } from "@/server/ai/debug-runner";
import { runTask, type WorkerResult } from "@/server/tasks/dispatcher";

/** The Mock governance probe requires this exact synthetic administrator identity. */
export const ADMIN_EMAIL = "phase015-admin@serendipity.invalid";
export const USER_EMAIL = "phase018-user@serendipity.invalid";

export interface Phase018Config {
  readonly phase: "018";
  readonly runId: string;
  readonly database: string;
  readonly user: string;
  readonly appUser: string;
  readonly url: string;
  readonly appUrl: string;
  readonly authSecret: string;
  readonly encryptionKey: string;
}

export function config(): Phase018Config {
  const file = process.env.PHASE018_FIXTURE_CONFIG;
  assert(file, "PHASE018_ISOLATED_DATABASE_REQUIRED");
  const data = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as Phase018Config;
  assert.match(data.database, /^phase018_disposable_[a-f0-9]{12}$/);
  assert.equal(data.database, `phase018_disposable_${data.runId}`);
  for (const [value, username] of [
    [data.url, data.user],
    [data.appUrl, data.appUser],
  ]) {
    const url = new URL(value);
    assert.equal(url.protocol, "postgresql:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, `/${data.database}`);
    assert.equal(url.username, username);
  }
  return data;
}

export const client = () => new PrismaClient({ datasourceUrl: config().appUrl, log: [] });
export const ownerClient = () => new PrismaClient({ datasourceUrl: config().url, log: [] });

/** The single Mock adapter is the only egress boundary, so counting it proves "0 network calls". */
let mockCalls = 0;
const originalComplete = MockAiProvider.prototype.complete;
MockAiProvider.prototype.complete = function counted(
  this: MockAiProvider,
  ...args: Parameters<typeof originalComplete>
) {
  mockCalls += 1;
  return originalComplete.apply(this, args);
};
export const mockCallCount = () => mockCalls;
export const resetMockCalls = () => {
  mockCalls = 0;
};

export async function initialize(db: PrismaClient): Promise<void> {
  const data = config();
  const owner = ownerClient();
  try {
    const [identity] = await owner.$queryRaw<Array<{ name: string; marker: string | null }>>`
      SELECT current_database() AS name,shobj_description(oid,'pg_database') AS marker
      FROM pg_database WHERE datname=current_database()`;
    assert.equal(identity.name, data.database);
    assert.equal(identity.marker, `serendipity-phase018-disposable:${data.runId}`);
    await owner.$executeRawUnsafe(
      'TRUNCATE "AiDebugRun","AiOutputRecord","AiUsageReservation","PromptActivation","PromptModelActivation","PromptVersion","PromptDefinition","ModelDeployment","ProviderConfigVersion","PlanningPolicyActivation","PlanningPolicyVersion" CASCADE',
    );
    await owner.systemConfig.deleteMany({ where: { key: "ai.calls.enabled" } });
  } finally {
    await owner.$disconnect();
  }
  await db.$transaction((tx) => bootstrapAiGovernance(tx), { timeout: 15000 });
  const actor = await db.user.upsert({
    where: { email: ADMIN_EMAIL },
    create: { email: ADMIN_EMAIL, passwordHash: "synthetic", role: "ADMIN" },
    update: { role: "ADMIN", status: "ACTIVE", sessionVersion: 0 },
  });
  await enableMockAi(db, {
    actorId: actor.id,
    runId: data.database,
    databaseUrl: data.appUrl,
  });
  resetMockCalls();
}

export async function cleanupDebug(): Promise<void> {
  const owner = ownerClient();
  try {
    await owner.$executeRawUnsafe('TRUNCATE "AiDebugRun","AiOutputRecord","AiUsageReservation"');
  } finally {
    await owner.$disconnect();
  }
}

export interface FixtureSession {
  readonly cookie: string;
  readonly csrf: string;
  readonly userId: string;
  readonly opaqueToken: string;
}

export interface SessionOptions {
  readonly role?: "ADMIN" | "USER";
  readonly status?: "ACTIVE" | "DISABLED";
  readonly audience?: "ADMIN" | "USER";
  readonly sessionVersion?: number;
  readonly ttlMs?: number;
  readonly email?: string;
}

/** Real AuthSession rows plus a real Auth.js cookie: no test-only auth bypass exists. */
export async function issueSession(
  db: PrismaClient,
  options: SessionOptions = {},
): Promise<FixtureSession> {
  const email = options.email ?? (options.role === "USER" ? USER_EMAIL : ADMIN_EMAIL);
  const user = await db.user.upsert({
    where: { email },
    create: {
      email,
      passwordHash: "synthetic",
      role: options.role ?? "ADMIN",
      status: options.status ?? "ACTIVE",
    },
    update: {
      role: options.role ?? "ADMIN",
      status: options.status ?? "ACTIVE",
      sessionVersion: 0,
    },
  });
  const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT public.auth_now() AS now`;
  const opaqueToken = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + (options.ttlMs ?? 43_200_000));
  await db.authSession.create({
    data: {
      userId: user.id,
      tokenHash: createHash("sha256").update(opaqueToken).digest("hex"),
      audience: options.audience ?? options.role ?? "ADMIN",
      sessionVersion: options.sessionVersion ?? user.sessionVersion,
      issuedAt: now,
      createdAt: now,
      expiresAt,
    },
  });
  const settings = authCookieSettings();
  const encrypted = await encodeAuthCookie({
    token: { opaqueToken, absoluteExpiresAt: expiresAt.getTime() },
    secret: env.AUTH_SECRET,
    salt: settings.sessionToken.name,
  });
  const csrfCookie = `${csrf}%7C${createHash("sha256").update(`${csrf}${env.AUTH_SECRET}`).digest("hex")}`;
  return {
    cookie: `${settings.sessionToken.name}=${encrypted}; ${settings.csrfToken.name}=${csrfCookie}`,
    csrf,
    userId: user.id,
    opaqueToken,
  };
}

export interface RequestOptions {
  readonly method?: "GET" | "POST";
  readonly session?: FixtureSession | null;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly csrf?: string | null;
  readonly origin?: string;
  readonly signal?: AbortSignal;
}

export function request(pathname: string, options: RequestOptions = {}): Request {
  const method = options.method ?? "POST";
  const headers = new Headers({ "content-type": "application/json" });
  if (options.session) headers.set("cookie", options.session.cookie);
  if (method === "POST") {
    headers.set("origin", options.origin ?? new URL(env.AUTH_URL).origin);
    headers.set("sec-fetch-site", "same-origin");
    const csrf = options.csrf === undefined ? options.session?.csrf : options.csrf;
    if (csrf) headers.set("x-csrf-token", csrf);
    headers.set("idempotency-key", options.idempotencyKey ?? randomUUID());
  }
  return new Request(new URL(pathname, env.AUTH_URL), {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(options.body ?? {}) : undefined,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export async function runDebugWorker(
  db: PrismaClient,
  runId: string,
  options: { onDelta?: (text: string) => Promise<void>; worker?: string } = {},
): Promise<WorkerResult> {
  const aggregateId = await debugTaskAggregateId(db, runId);
  return runTask(debugTaskHandler(options.onDelta), {
    db,
    kind: "AI_DEBUG",
    aggregateId,
    runId: options.worker ?? `debug_worker_${randomUUID().replaceAll("-", "")}`,
  });
}

export function observation(fixture: string, details: Record<string, unknown>): void {
  if (process.env.PHASE018_OBSERVATIONS)
    fs.appendFileSync(
      process.env.PHASE018_OBSERVATIONS,
      JSON.stringify({ fixture, ...details }) + "\n",
    );
}
