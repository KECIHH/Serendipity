import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Prisma, PrismaClient, type TravelStatus } from "@prisma/client";
import { createOrResumeChatCommand } from "@/server/chat/command-service";
import { lockOwnedTravelRecord } from "@/server/repositories/travel-record";
import { hashAnonymousToken, type AnonTokenHash } from "@/server/anonymous-owner";

export interface Phase016FixtureConfig {
  readonly database: string;
  readonly url: string;
  readonly appUrl: string;
}

export function phase016Config(): Phase016FixtureConfig {
  const file = process.env.PHASE016_FIXTURE_CONFIG;
  assert(file, "Phase016 requires PHASE016_FIXTURE_CONFIG");
  const config = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as Phase016FixtureConfig;
  assert.match(config.database, /^phase016_disposable_[a-f0-9]{12}$/);
  const url = new URL(config.url);
  assert.equal(url.protocol, "postgresql:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, `/${config.database}`);
  const appUrl = new URL(config.appUrl);
  assert.equal(appUrl.hostname, "127.0.0.1");
  assert.equal(appUrl.pathname, `/${config.database}`);
  return config;
}

export function phase016Client(): PrismaClient {
  return new PrismaClient({ datasourceUrl: phase016Config().appUrl, log: [] });
}

export function phase016OwnerClient(): PrismaClient {
  return new PrismaClient({ datasourceUrl: phase016Config().url, log: [] });
}

export type FixtureOwner =
  | { userId: string; anonTokenHash?: never }
  | { anonTokenHash: AnonTokenHash; userId?: never };

export const syntheticOwner = (runId: string) => ({
  kind: "SYNTHETIC" as const,
  runId,
});

export async function createFixtureOwner(
  client: PrismaClient,
  options: { email?: string; anon?: boolean } = {},
): Promise<{ owner: FixtureOwner; userId?: string; anonTokenHash?: string }> {
  if (options.anon) {
    const raw = randomBytes(32).toString("base64url");
    const anonTokenHash = hashAnonymousToken(raw);
    return { owner: { anonTokenHash }, anonTokenHash };
  }
  const email = options.email ?? `fixture-${cryptoRandom8()}@serendipity.invalid`;
  const user = await client.user.create({
    data: { email, passwordHash: "synthetic", role: "USER" },
  });
  return { owner: { userId: user.id }, userId: user.id };
}

export async function createTravelRecord(
  client: PrismaClient,
  input: { owner: FixtureOwner; title: string; status?: TravelStatus; version?: number },
): Promise<{ id: string; status: TravelStatus; version: number }> {
  const record = await client.travelRecord.create({
    data: {
      userId: input.owner.userId ?? null,
      anonTokenHash: input.owner.anonTokenHash ?? null,
      title: input.title,
      status: input.status ?? "DRAFT",
      version: input.version ?? 0,
      requirementJson: Prisma.DbNull,
    },
  });
  return { id: record.id, status: record.status, version: record.version };
}

export async function lastSequence(client: PrismaClient, travelRecordId: string): Promise<number> {
  const last = await client.chatMessage.findFirst({
    where: { travelRecordId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  return last?.sequence ?? 0;
}

export interface CommandFixture {
  client: PrismaClient;
  owner: FixtureOwner;
  travelRecordId: string;
  idempotencyKey: string;
}

export async function acceptFixtureCommand(
  input: CommandFixture & { message: string; kind?: "CHAT_MESSAGE" | "PLAN_DRAFT" },
): Promise<{ travelRecordId: string; commandId: string; replayed: boolean }> {
  return createOrResumeChatCommand(input.client, {
    owner: input.owner,
    travelRecordId: input.travelRecordId,
    kind: input.kind ?? "CHAT_MESSAGE",
    idempotencyKey: input.idempotencyKey,
    message: input.message,
    clientMessageId: `cm_${cryptoRandom16()}`,
    traceId: `tr_${cryptoRandom16()}`,
  });
}

export async function runAsOwner(
  client: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<unknown> {
  return client.$transaction(fn);
}

function cryptoRandom8(): string {
  return randomBytes(4).toString("hex");
}
function cryptoRandom16(): string {
  return randomBytes(8).toString("hex");
}