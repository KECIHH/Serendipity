import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { bootstrapAiGovernance, enableMockAi } from "@/server/services/ai-governance-service";
import { createNluContext, type NluContextInput } from "@/server/ai/nlu-context";
import { createDeployment, activateFixture } from "../phase015/fixture";
import { startHttpFixture } from "../phase015/http-fixture";

export function config() {
  const file = process.env.PHASE017_FIXTURE_CONFIG;
  assert(file, "PHASE017_ISOLATED_DATABASE_REQUIRED");
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
    database: string;
    runId: string;
    url: string;
    appUrl: string;
    appUser: string;
  };
  assert.match(data.database, /^phase017_disposable_[a-f0-9]{12}$/);
  for (const value of [data.url, data.appUrl]) {
    const url = new URL(value);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, `/${data.database}`);
  }
  return data;
}
export const client = () => new PrismaClient({ datasourceUrl: config().appUrl, log: [] });
export async function initialize(db: PrismaClient) {
  const data = config(),
    owner = new PrismaClient({ datasourceUrl: data.url, log: [] });
  try {
    const [identity] = await owner.$queryRaw<
      Array<{ name: string; marker: string }>
    >`SELECT current_database() AS name,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()`;
    assert.equal(identity.name, data.database);
    assert.equal(identity.marker, `serendipity-phase017-disposable:${data.runId}`);
    await owner.$executeRawUnsafe(
      'TRUNCATE "AiOutputRecord","AiUsageReservation","PromptActivation","PromptModelActivation","PromptVersion","PromptDefinition","ModelDeployment","ProviderConfigVersion","PlanningPolicyActivation","PlanningPolicyVersion" CASCADE',
    );
    await owner.systemConfig.deleteMany({ where: { key: "ai.calls.enabled" } });
  } finally {
    await owner.$disconnect();
  }
  await db.$transaction((tx) => bootstrapAiGovernance(tx));
  const actor = await db.user.upsert({
    where: { email: "phase015-admin@serendipity.invalid" },
    create: {
      email: "phase015-admin@serendipity.invalid",
      passwordHash: "synthetic",
      role: "ADMIN",
    },
    update: {},
  });
  await enableMockAi(db, { actorId: actor.id, runId: data.database, databaseUrl: data.appUrl });
}
export function context(overrides: Partial<NluContextInput> = {}, clock = () => Date.now()) {
  return createNluContext(
    {
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      planningMode: "quick",
      ownerContext: { kind: "SYNTHETIC", runId: config().database },
      traceId: `trace_${randomUUID()}`,
      requestId: `request_${randomUUID()}`,
      signal: new AbortController().signal,
      deadlineAt: clock() + 30000,
      tokenBudget: 1_000_000,
      costBudget: "5",
      ...overrides,
    },
    clock,
  );
}
export const variables = {
  userText: "深圳北京",
  locale: "zh-CN",
  serverDate: "2026-09-15",
  timezone: "Asia/Shanghai",
  stage: "CORE" as const,
};
export async function httpProvider(
  db: PrismaClient,
  outputs: readonly (string | { status: number })[],
  options: { usage?: boolean; delayMs?: number; fixedCost?: string } = {},
) {
  let calls = 0;
  const server = await startHttpFixture(async (_, response) => {
    const entry = outputs[Math.min(calls++, outputs.length - 1)];
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (typeof entry !== "string") {
      response.writeHead(entry.status);
      response.end("{}");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: `synthetic_${calls}`,
        choices: [{ message: { content: entry } }],
        ...(options.usage === false ? {} : { usage: { prompt_tokens: 10, completion_tokens: 10 } }),
      }),
    );
  });
  const tuple = await createDeployment(db, {
    mode: "LIVE",
    retries: 1,
    timeout: 5000,
    pricing: {
      inputPerToken: "0",
      outputPerToken: "0",
      fixedPerRequest: options.fixedCost ?? "0",
      basis: "UTF8_BYTE_UPPER_BOUND_V1",
    },
  });
  await activateFixture(db, "nlu.extract", tuple);
  await activateFixture(db, "planner.repair_json", tuple);
  return {
    ...server,
    calls: () => calls,
    options: {
      db,
      liveEgressAllowed: true,
      transport: server.transport,
      dnsLookup: server.dnsLookup,
    },
  };
}
export function observation(fixture: string, details: Record<string, unknown>) {
  if (process.env.PHASE017_OBSERVATIONS)
    fs.appendFileSync(
      process.env.PHASE017_OBSERVATIONS,
      JSON.stringify({ fixture, ...details }) + "\n",
    );
}
