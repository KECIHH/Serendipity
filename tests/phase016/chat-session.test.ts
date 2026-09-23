// @vitest-environment node
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  createOrResumeChatCommand,
  insertInitialPlanDraftCommand,
  type CreateOrResumeChatCommandInput,
} from "@/server/chat/command-service";
import {
  issueOrReuseAnonymousSession,
  readAnonymousCookie,
  resolveExistingOwner,
} from "@/server/chat/owner";
import { ownerKeyHash, registerOwnerExtensions } from "@/server/chat/ownership";
import { completeCommand, failCommand, cancelChatCommand } from "@/server/chat/command-state";
import { createChatCommandHandler } from "@/server/chat/process-task";
import {
  replayEvents,
  openChatEventStream,
  reconcileCommand,
  assertReplayWindow,
  sseFrame,
  REPLAY_RETENTION_MS,
} from "@/server/chat/sse";
import { advanceChatCheckpoint } from "@/lib/chat-stream";
import { publishChatDelta } from "@/server/chat/events";
import { runTask, drainOutbox } from "@/server/tasks/dispatcher";
import { enqueueTask } from "@/server/tasks/durable-task";
import {
  readTaskPayload,
  storeTaskPayload,
  cleanupTaskPayload,
  registerPayloadPin,
  payloadId,
} from "@/server/tasks/payload";
import { canonicalHash } from "@/server/ai/canonical-hash";
import { promptKeyContract } from "@/lib/ai/schemas";
import { createSessionService } from "@/server/auth/session-service";
import { createAdminApiKeysService } from "@/server/admin/api-keys";
import { createProviderKeyCandidateClient } from "@/server/ai/key-candidate-client";
import { makeApiKeyRequest, registerCanary } from "../phase013/api-key-fixture";
import { activateFixture, createDeployment } from "../phase015/fixture";
import { startHttpFixture, sendCompletion } from "../phase015/http-fixture";
import { scanAiBoundary } from "../phase015/import-boundary";
import {
  phase016Client,
  phase016OwnerClient,
  phase016Config,
  initializeFixture,
  anonymousOwner,
  loginOwner,
  record,
  commandInput,
  accepted,
  leased,
  commandCounts,
  finalContent,
  worker,
  waitUntil,
  stream,
  observe,
} from "./fixture";

const enabled = Boolean(process.env.PHASE016_FIXTURE_CONFIG);
describe.skipIf(!enabled)("Phase016 chat-session", () => {
  let db: PrismaClient, ownerDb: PrismaClient;
  beforeAll(async () => {
    db = phase016Client();
    ownerDb = phase016OwnerClient();
    await initializeFixture(db);
  }, 30000);
  afterAll(async () => {
    await db?.$disconnect();
    await ownerDb?.$disconnect();
  });
  const run = (commandId: string, ai: Parameters<typeof createChatCommandHandler>[0] = {}) =>
    runTask(createChatCommandHandler(ai), {
      db,
      kind: "CHAT_COMMAND",
      aggregateId: commandId,
      runId: "test_" + randomUUID().replaceAll("-", ""),
    });
  const counts = async () => {
    const names = [
      "TravelRecord",
      "ChatMessage",
      "ChatCommand",
      "CommandIdempotency",
      "TaskPayload",
      "DurableTask",
      "ChatCommandEvent",
      "Outbox",
    ];
    return Promise.all(
      names.map(async (table) =>
        (
          await db.$queryRawUnsafe<Array<{ count: bigint }>>(
            `SELECT count(*) AS count FROM "${table}"`,
          )
        )[0].count.toString(),
      ),
    );
  };
  async function withClock<T>(at: Date, fn: () => Promise<T>) {
    const [{ definition }] = await ownerDb.$queryRaw<
      Array<{ definition: string }>
    >`SELECT pg_get_functiondef('public.auth_now()'::regprocedure) AS definition`;
    try {
      await ownerDb.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION public.auth_now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${at.toISOString()}'::timestamptz $$`,
      );
      return await fn();
    } finally {
      await ownerDb.$executeRawUnsafe(definition);
    }
  }
  async function mockTuple(options: Parameters<typeof createDeployment>[1] = {}) {
    const tuple = await createDeployment(db, { quota: 100000000, retries: 0, ...options });
    await activateFixture(db, "conversation.modify", tuple);
    return tuple;
  }

  it("first-accept: verified anonymous and login identities atomically create every accepted fact", async () => {
    for (const identity of [await anonymousOwner(db), await loginOwner(db)]) {
      const travel = await record(db, identity.owner),
        input = commandInput(identity.owner, travel.id);
      const result = await createOrResumeChatCommand(db, input);
      expect(result).toMatchObject({
        travelRecordId: travel.id,
        replayed: false,
        ownerType: identity.owner.userId ? "USER" : "ANONYMOUS",
      });
      expect(await commandCounts(db, result.commandId)).toEqual({
        status: "PENDING",
        users: 1,
        assistants: 0,
        terminal: 0,
        deltas: 0,
      });
      const command = await db.chatCommand.findUniqueOrThrow({ where: { id: result.commandId } });
      const task = await db.durableTask.findUniqueOrThrow({ where: { commandId: command.id } });
      expect(command.ownerKeyHash === ownerKeyHash(identity.owner)).toBe(true);
      expect(command.idempotencyKeyHash === input.idempotencyKey).toBe(false);
      expect(await readTaskPayload(db, { ...task, ownerKeyHash: command.ownerKeyHash })).toEqual({
        schemaVersion: 1,
        message: input.message,
        locale: "zh-CN",
      });
      expect(
        await db.commandIdempotency.count({ where: { commandId: command.id, status: "PENDING" } }),
      ).toBe(1);
      expect(
        await db.chatCommandEvent.count({
          where: { aggregateId: command.id, type: "message.accepted" },
        }),
      ).toBe(1);
      expect(await db.outbox.count({ where: { aggregateId: command.id, status: "PENDING" } })).toBe(
        1,
      );
      const payload = await db.taskPayload.findUniqueOrThrow({
        where: { id: payloadId(command.payloadRef) },
      });
      expect(payload.ciphertext.includes(input.message)).toBe(false);
      observe("first-accept", result.ownerType, {
        records: 1,
        users: 1,
        commands: 1,
        receipts: 1,
        payloads: 1,
        tasks: 1,
        acceptedEvents: 1,
        outbox: 1,
      });
    }
  });
  it("first-accept: cookie reuse preserves its absolute 30 day expiry and missing or forged identity writes nothing", async () => {
    const now = Date.now(),
      issued = issueOrReuseAnonymousSession(undefined, now),
      cookie = issued.cookieHeader.split(";")[0];
    const request = new Request("http://127.0.0.1", { headers: { cookie } }),
      reused = issueOrReuseAnonymousSession(request, now + 86400000);
    expect(reused.reused).toBe(true);
    expect(reused.cookieHeader.split(";")[0] === cookie).toBe(true);
    expect(reused.cookieHeader).toContain("Max-Age=2505600");
    expect(issued.cookieHeader).toContain("Max-Age=2592000");
    for (const part of ["HttpOnly", "SameSite=Lax", "Path=/"])
      expect(issued.cookieHeader.includes(part)).toBe(true);
    expect(readAnonymousCookie(request, now + 30 * 86400000)).toBeNull();
    const before = await counts();
    const invalidCookies = [
      "",
      "anon_token=forged",
      "anon_token=a; anon_token=b",
      ...[null, [], "text", 0, true, {}].map(
        (value) => `anon_token=${Buffer.from(JSON.stringify(value)).toString("base64url")}`,
      ),
    ];
    for (const cookie of invalidCookies) {
      const request = new Request("http://127.0.0.1", { headers: { cookie } });
      expect(readAnonymousCookie(request)).toBeNull();
      expect(await resolveExistingOwner(request, { db })).toBeNull();
      const replacement = issueOrReuseAnonymousSession(request);
      expect(replacement.reused).toBe(false);
      expect(
        readAnonymousCookie(
          new Request("http://127.0.0.1", {
            headers: { cookie: replacement.cookieHeader.split(";")[0] },
          }),
        ),
      ).not.toBeNull();
    }
    expect(await counts()).toEqual(before);
    observe("first-accept", "cookie-and-missing-owner", {
      fixedDays: 30,
      invalidIdentities: invalidCookies.length,
      writes: 0,
    });
  });
  it("first-accept: each record payload USER command ledger task event and outbox insertion fault rolls back the entire draft", async () => {
    const identity = await anonymousOwner(db);
    const tables = [
      "TravelRecord",
      "TaskPayload",
      "ChatMessage",
      "ChatCommand",
      "CommandIdempotency",
      "DurableTask",
      "ChatCommandEvent",
      "Outbox",
    ];
    for (const table of tables) {
      const before = await counts();
      await ownerDb.$executeRawUnsafe(
        "CREATE OR REPLACE FUNCTION public.phase016_accept_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PHASE016_ACCEPT_FAULT'; END; $$",
      );
      await ownerDb.$executeRawUnsafe(
        `CREATE TRIGGER "phase016_accept_fault" BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION public.phase016_accept_fault()`,
      );
      try {
        await expect(
          db.$transaction(async (tx) => {
            const travel = await tx.travelRecord.create({
              data: { anonTokenHash: identity.owner.anonTokenHash, title: "合成首稿" },
            });
            await insertInitialPlanDraftCommand(tx, {
              ...commandInput(identity.owner, travel.id),
              kind: "PLAN_DRAFT",
            });
          }),
        ).rejects.toBeDefined();
        expect(await counts()).toEqual(before);
      } finally {
        await ownerDb.$executeRawUnsafe(`DROP TRIGGER "phase016_accept_fault" ON "${table}"`);
      }
    }
    await ownerDb.$executeRawUnsafe("DROP FUNCTION public.phase016_accept_fault()");
    const result = await db.$transaction(async (tx) => {
      const travel = await tx.travelRecord.create({
        data: { anonTokenHash: identity.owner.anonTokenHash, title: "合成首稿" },
      });
      return insertInitialPlanDraftCommand(tx, {
        ...commandInput(identity.owner, travel.id),
        kind: "PLAN_DRAFT",
      });
    });
    expect((await db.chatCommand.findUniqueOrThrow({ where: { id: result.commandId } })).kind).toBe(
      "PLAN_DRAFT",
    );
    observe("first-accept", "fault-matrix", {
      faults: tables.length,
      partialRows: 0,
      composedDrafts: 1,
    });
  });

  it("owner-resume: current owner alone can resume and client owner IDs or server fields cannot override it", async () => {
    const a = await loginOwner(db),
      b = await loginOwner(db),
      anon = await anonymousOwner(db),
      travel = await record(db, a.owner);
    const before = await counts(),
      input = commandInput(a.owner, travel.id);
    for (const bad of [
      { ...input, owner: b.owner },
      { ...input, owner: anon.owner },
      { ...input, userId: b.user.id },
      { ...input, commandId: "chosen" },
      { ...input, status: "COMPLETED" },
      { ...input, sequence: 42 },
    ])
      await expect(
        createOrResumeChatCommand(db, bad as CreateOrResumeChatCommandInput),
      ).rejects.toBeDefined();
    expect(await counts()).toEqual(before);
    const combined = new Request("http://127.0.0.1", {
      headers: { cookie: a.cookie + "; " + anon.cookie },
    });
    expect((await resolveExistingOwner(combined, { db }))?.userId === a.user.id).toBe(true);
    await createOrResumeChatCommand(db, input);
    const archived = await record(db, a.owner, "ARCHIVED"),
      finalized = await record(db, a.owner, "FINALIZED");
    await expect(
      createOrResumeChatCommand(db, commandInput(a.owner, archived.id)),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await createOrResumeChatCommand(db, commandInput(a.owner, finalized.id));
    expect(
      await db.travelRecord.findUnique({
        where: { id: finalized.id },
        select: { status: true, version: true },
      }),
    ).toEqual({ status: "FINALIZED", version: 0 });
    const [future] = await db.$queryRaw<
      Array<{ version: string | null; finalization: string | null }>
    >`SELECT to_regclass('public."TravelPlanVersion"')::text AS version,to_regclass('public."PlanFinalization"')::text AS finalization`;
    expect(future).toEqual({ version: null, finalization: null });
    observe("owner-resume", "authorization-and-status", {
      rejectedOverwrites: 6,
      archivedWrites: 0,
      finalizedAccepted: 1,
      formalVersionWrites: 0,
    });
  });
  it("owner-resume: revoked sessions and sessionVersion changes are rechecked inside acceptance and replay", async () => {
    for (const mode of ["revoke", "version", "disable"]) {
      const identity = await loginOwner(db),
        command = await accepted(db, identity.owner),
        before = await counts();
      if (mode === "revoke") {
        const sessions = createSessionService({ databaseUrl: phase016Config().appUrl });
        try {
          await sessions.revokeSession(identity.token);
        } finally {
          await sessions.disconnect();
        }
      } else
        await ownerDb.user.update({
          where: { id: identity.user.id },
          data: mode === "version" ? { sessionVersion: { increment: 1 } } : { status: "DISABLED" },
        });
      expect(await resolveExistingOwner(identity.request, { db })).toBeNull();
      await expect(
        createOrResumeChatCommand(db, commandInput(identity.owner, command.travel.id)),
      ).rejects.toBeDefined();
      await expect(
        db.$transaction((tx) =>
          replayEvents(tx, { owner: identity.owner, aggregateId: command.commandId }),
        ),
      ).rejects.toBeDefined();
      expect(await counts()).toEqual(before);
    }
    observe("owner-resume", "revocation", {
      revokedSessionRejections: 1,
      versionRejections: 1,
      disabledRejections: 1,
      staleAuthorizationWrites: 0,
    });
  });
  it("owner-resume: consumed anonymous identity and historical alias share the same current-owner boundary", async () => {
    const anon = await anonymousOwner(db),
      command = await accepted(db, anon.owner),
      user = await loginOwner(db);
    const historical = ownerKeyHash(anon.owner);
    const unregister = registerOwnerExtensions({
      consumed: async (_tx, hash) => hash === anon.owner.anonTokenHash,
      aliases: async (_tx, id) => (id === user.user.id ? [historical] : []),
    });
    try {
      await ownerDb.travelRecord.update({
        where: { id: command.travel.id },
        data: { userId: user.user.id, anonTokenHash: null },
      });
      await expect(
        cancelChatCommand(db, { owner: anon.owner, commandId: command.commandId }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        db.$transaction((tx) =>
          replayEvents(tx, { owner: anon.owner, aggregateId: command.commandId }),
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const replay = await createOrResumeChatCommand(db, { ...command.input, owner: user.owner });
      expect(replay.commandId === command.commandId).toBe(true);
      expect(replay.replayed).toBe(true);
      expect(
        (await db.chatCommand.findUniqueOrThrow({ where: { id: command.commandId } }))
          .ownerKeyHash === historical,
      ).toBe(true);
      await cancelChatCommand(db, { owner: user.owner, commandId: command.commandId });
    } finally {
      unregister();
    }
    observe("owner-resume", "extension-boundary", {
      historyRewrites: 0,
      consumedReads: 0,
      consumedCancels: 0,
      authorizedAliasReplays: 1,
    });
  });

  it("idempotency: concurrent identical keys replay the same IDs and changed payload or record produces 409 with zero writes", async () => {
    const identity = await anonymousOwner(db),
      travel = await record(db, identity.owner),
      input = commandInput(identity.owner, travel.id);
    const results = await Promise.all([
      createOrResumeChatCommand(db, input),
      createOrResumeChatCommand(db, { ...input, traceId: "other_trace" }),
    ]);
    expect(new Set(results.map((r) => r.commandId)).size).toBe(1);
    expect(results.filter((r) => r.replayed).length).toBe(1);
    const other = await record(db, identity.owner),
      before = await counts();
    for (const changed of [
      { ...input, message: "不同请求" },
      { ...input, travelRecordId: other.id },
      { ...input, clientMessageId: randomUUID() },
    ])
      await expect(createOrResumeChatCommand(db, changed)).rejects.toMatchObject({
        code: "IDEMPOTENCY_KEY_REUSED",
        status: 409,
      });
    expect(await counts()).toEqual(before);
    observe("idempotency", "key-conflicts", {
      sameIds: 1,
      replays: 1,
      conflicts: 3,
      conflictWrites: 0,
    });
  });
  it("idempotency: record locks allocate max sequence plus one across different commands and historical gaps", async () => {
    const identity = await anonymousOwner(db),
      travel = await record(db, identity.owner);
    await db.chatMessage.create({
      data: {
        travelRecordId: travel.id,
        role: "SYSTEM",
        kind: "TEXT",
        content: "历史空隙",
        sequence: 7,
      },
    });
    const commands = await Promise.all(
      [1, 2].map(() => createOrResumeChatCommand(db, commandInput(identity.owner, travel.id))),
    );
    const lease = await leased(db, commands[0].commandId);
    await db.$transaction((tx) =>
      completeCommand(tx, {
        ...lease,
        commandId: commands[0].commandId,
        assistantContent: finalContent,
      }),
    );
    const rows = await db.chatMessage.findMany({
      where: { travelRecordId: travel.id },
      orderBy: { sequence: "asc" },
      select: { sequence: true },
    });
    expect(rows.map((r) => r.sequence)).toEqual([7, 8, 9, 10]);
    observe("idempotency", "message-order", {
      accepted: 2,
      sequences: [7, 8, 9, 10],
      duplicates: 0,
    });
  });
  it("idempotency: payload references are mandatory authenticated immutable recoverable inputs with retention and domain pins", async () => {
    const c = await accepted(db),
      task = await db.durableTask.findUniqueOrThrow({ where: { commandId: c.commandId } });
    const before = await counts();
    await expect(
      db.$transaction((tx) =>
        enqueueTask(tx, {
          kind: "CHAT_COMMAND",
          aggregateId: c.commandId,
          commandId: c.commandId,
          payloadHash: task.payloadHash,
          payloadSchemaVersion: 1,
        } as Parameters<typeof enqueueTask>[1]),
      ),
    ).rejects.toThrow("PAYLOAD_REFERENCE_REQUIRED");
    await expect(readTaskPayload(db, { ...task, payloadHash: "0".repeat(64) })).rejects.toThrow();
    await expect(readTaskPayload(db, { ...task, ownerKeyHash: "0".repeat(64) })).rejects.toThrow();
    await expect(
      db.taskPayload.update({
        where: { id: payloadId(task.payloadRef) },
        data: { contentHash: "0".repeat(64) },
      }),
    ).rejects.toBeDefined();
    await expect(
      db.$transaction((tx) =>
        storeTaskPayload(tx, {
          ownerKeyHash: ownerKeyHash(c.owner),
          schemaVersion: 1,
          value: { cookie: "forbidden" },
        }),
      ),
    ).rejects.toThrow();
    expect(await counts()).toEqual(before);
    await withClock(new Date(Date.now() + 3 * 86400000), async () => {
      expect(
        await db.$transaction((tx) => cleanupTaskPayload(tx, { id: payloadId(task.payloadRef) })),
      ).toBe(false);
    });
    await cancelChatCommand(db, { owner: c.owner, commandId: c.commandId });
    await withClock(new Date(Date.now() + 3 * 86400000), async () => {
      for (const name of [
        "VERSION_WORKSPACE",
        "OPEN_CLARIFICATION",
        "PENDING_OVERRIDE",
        "UNFINISHED_ERASE",
      ]) {
        const unregister = registerPayloadPin(name, async () => true);
        try {
          expect(
            await db.$transaction((tx) =>
              cleanupTaskPayload(tx, {
                id: payloadId(task.payloadRef),
                now: new Date(Date.now() + 3 * 86400000),
              }),
            ),
          ).toBe(false);
        } finally {
          unregister();
        }
      }
      expect(
        await db.$transaction((tx) =>
          cleanupTaskPayload(tx, {
            id: payloadId(task.payloadRef),
            now: new Date(Date.now() + 3 * 86400000),
          }),
        ),
      ).toBe(true);
    });
    observe("idempotency", "payload", {
      missingRefRejections: 1,
      hashOwnerAndImmutableRejections: 3,
      activePins: 1,
      domainPins: 4,
      eligibleCleanup: 1,
    });
  });
  it("idempotency: two real workers exclude one another and a killed lease is adopted without resetting its attempt", async () => {
    await mockTuple();
    const c = await accepted(db),
      a = await worker({ action: "run", commandId: c.commandId, holdAt: "CLAIM" });
    let b: Awaited<ReturnType<typeof worker>> | undefined,
      late: Awaited<ReturnType<typeof worker>> | undefined;
    try {
      const original = await a.wait("claim");
      b = await worker({ action: "run", commandId: c.commandId });
      expect((await b.wait("done")).result).toBe("NOT_CLAIMED");
      await b.close();
      await a.close();
      await new Promise((r) => setTimeout(r, 750));
      b = await worker({ action: "run", commandId: c.commandId, holdAt: "CALLING" });
      const adopted = await b.wait("claim");
      await b.wait("stage", "CALLING");
      expect(adopted.pid === original.pid).toBe(false);
      expect(adopted.fencingToken).toBe(Number(original.fencingToken) + 1);
      expect(adopted.attemptCount).toBe(original.attemptCount);
      expect(adopted.checkpoint).toEqual(original.checkpoint);
      const before = await counts();
      late = await worker({
        action: "late",
        commandId: c.commandId,
        lease: {
          taskId: original.taskId,
          leaseOwner: original.leaseOwner,
          fencingToken: original.fencingToken,
        },
      });
      expect((await late.wait("done")).result).toEqual([
        "REJECTED",
        "REJECTED",
        "REJECTED",
        "REJECTED",
      ]);
      expect(await counts()).toEqual(before);
      b.release();
      expect((await b.wait("done")).result, JSON.stringify(b.notices)).toBe("COMPLETED");
      expect(await commandCounts(db, c.commandId)).toEqual({
        status: "COMPLETED",
        users: 1,
        assistants: 1,
        terminal: 1,
        deltas: 0,
      });
      observe("idempotency", "multi-process-kill-adopt", {
        processes: 3,
        liveClaimLosers: 1,
        adoptions: 1,
        attemptPreserved: true,
        staleRejections: 4,
        staleWrites: 0,
      });
    } finally {
      await a.close();
      await b?.close();
      await late?.close();
    }
  }, 30000);
  it("idempotency: OUTPUT_READY survives process death and resumes without another provider attempt", async () => {
    await mockTuple();
    const c = await accepted(db),
      a = await worker({ action: "run", commandId: c.commandId, holdAt: "OUTPUT_READY" });
    let b: Awaited<ReturnType<typeof worker>> | undefined;
    try {
      await a.wait("stage", "OUTPUT_READY");
      const checkpoint = (
        await db.durableTask.findUniqueOrThrow({ where: { commandId: c.commandId } })
      ).checkpointJson;
      expect(await db.aiOutputRecord.count({ where: { commandId: c.commandId } })).toBe(1);
      await a.close();
      await new Promise((r) => setTimeout(r, 750));
      b = await worker({ action: "run", commandId: c.commandId });
      expect((await b.wait("claim")).checkpoint).toEqual(checkpoint);
      expect((await b.wait("done")).result).toBe("COMPLETED");
      expect(await db.aiOutputRecord.count({ where: { commandId: c.commandId } })).toBe(1);
      observe("idempotency", "output-checkpoint", {
        encryptedResultCheckpoints: 1,
        reusedResults: 1,
        providerAttempts: 1,
        duplicateAssistants: 0,
      });
    } finally {
      await a.close();
      await b?.close();
    }
  }, 30000);

  it("idempotency: ADMIN_KEY_ROTATION uses the shared worker lease across kill adoption and late domain writes", async () => {
    const identity = await loginOwner(db, "ADMIN"),
      session = {
        userId: identity.user.id,
        opaqueToken: identity.token,
        expiresAt: identity.session.expiresAt.toISOString(),
        audience: "ADMIN" as const,
      };
    const secret = () => {
      const value = "phase016_rotation_" + randomUUID();
      registerCanary({ plainKey: value });
      return value;
    };
    let fail = true;
    const http = await startHttpFixture((request, response) => {
      if (fail) {
        response.writeHead(503);
        response.end();
        return;
      }
      const body = JSON.parse(request.body);
      sendCompletion(response, JSON.parse(body.messages[1].content));
    });
    const service = createAdminApiKeysService({
      databaseUrl: phase016Config().appUrl,
      candidateClient: createProviderKeyCandidateClient(db, http),
    });
    let a: Awaited<ReturnType<typeof worker>> | undefined,
      b: Awaited<ReturnType<typeof worker>> | undefined,
      late: Awaited<ReturnType<typeof worker>> | undefined;
    try {
      const old = await service.create(
        await makeApiKeyRequest({
          method: "POST",
          session,
          idempotencyKey: randomUUID(),
          body: { name: "共享任务恢复 fixture", provider: "deepseek", plainKey: secret() },
        }),
      );
      const tuple = await createDeployment(db, {
        mode: "LIVE",
        secretRef: old.key.id,
        retries: 0,
        quota: 100000000,
      });
      await activateFixture(db, "nlu.extract", tuple);
      const failed = await service.rotate(
        await makeApiKeyRequest({
          method: "POST",
          session,
          idempotencyKey: randomUUID(),
          body: {
            name: "恢复候选",
            provider: "deepseek",
            plainKey: secret(),
            expectedVersion: old.key.revision,
          },
        }),
        old.key.id,
      );
      expect(failed.stage).toBe("TESTING");
      const rotation = await db.keyRotationRun.findFirstOrThrow({
        where: { oldKeyId: old.key.id },
      });
      const initial = await db.durableTask.findUniqueOrThrow({
        where: { adminReceiptId: rotation.receiptId },
      });
      expect(initial.status).toBe("PENDING");
      expect(initial.rotationRunId).toBe(rotation.id);
      await new Promise((r) => setTimeout(r, 1100));
      fail = false;
      a = await worker({
        action: "rotation",
        commandId: rotation.receiptId,
        origin: http.origin,
        holdAt: "CLAIM",
      });
      const original = await a.wait("claim");
      b = await worker({ action: "rotation", commandId: rotation.receiptId, origin: http.origin });
      expect((await b.wait("done")).result).toBe("NOT_CLAIMED");
      await b.close();
      await a.close();
      await new Promise((r) => setTimeout(r, 2300));
      b = await worker({
        action: "rotation",
        commandId: rotation.receiptId,
        origin: http.origin,
        holdAt: "CLAIM",
      });
      const adopted = await b.wait("claim");
      expect(adopted.fencingToken).toBe(Number(original.fencingToken) + 1);
      expect(adopted.attemptCount).toBe(original.attemptCount);
      expect(adopted.checkpoint).toEqual(original.checkpoint);
      const before = {
        run: await db.keyRotationRun.findUniqueOrThrow({ where: { id: rotation.id } }),
        keys: await db.apiKeyConfig.count(),
        audits: await db.auditLog.count(),
      };
      late = await worker({
        action: "late-rotation",
        commandId: rotation.receiptId,
        rotationRunId: rotation.id,
        lease: {
          taskId: original.taskId,
          leaseOwner: original.leaseOwner,
          fencingToken: original.fencingToken,
        },
      });
      expect((await late.wait("done")).result).toEqual([
        "REJECTED",
        "REJECTED",
        "REJECTED",
        "REJECTED",
      ]);
      expect(await db.keyRotationRun.findUniqueOrThrow({ where: { id: rotation.id } })).toEqual(
        before.run,
      );
      expect(await db.apiKeyConfig.count()).toBe(before.keys);
      expect(await db.auditLog.count()).toBe(before.audits);
      b.release();
      const done = await b.wait("done");
      expect(done.result, JSON.stringify(b.notices)).toBe("COMPLETED");
      expect(
        (await db.keyRotationRun.findUniqueOrThrow({ where: { id: rotation.id } })).stage,
      ).toBe("ACTIVATED");
      expect(
        (await db.apiKeyConfig.findUniqueOrThrow({ where: { id: failed.key.id } })).status,
      ).toBe("ACTIVE");
      expect((await db.apiKeyConfig.findUniqueOrThrow({ where: { id: old.key.id } })).status).toBe(
        "REVOKED",
      );
      const receipt = await db.adminCommandReceipt.findUniqueOrThrow({
        where: { id: rotation.receiptId },
      });
      expect(receipt.status).toBe("SUCCEEDED");
      expect(receipt.fencingToken).toBe(0);
      expect(receipt.attemptCount).toBe(0);
      expect(await db.keyRotationRun.count({ where: { oldKeyId: old.key.id } })).toBe(1);
      observe("idempotency", "admin-rotation-kill-adopt", {
        sharedLease: true,
        processes: 3,
        adoptions: 1,
        staleRejections: 4,
        domainRuns: 1,
        candidateReused: true,
        legacyLeaseUpdates: 0,
        httpCalls: http.requests.length,
      });
    } finally {
      await a?.close();
      await b?.close();
      await late?.close();
      await service.disconnect();
      await http.close();
    }
  }, 30000);

  it("replay: equal timestamps replay in sequence with exact envelopes and consistent event ID or sequence cursors", async () => {
    await withClock(new Date(Date.now() + 1000), async () => {
      const c = await accepted(db),
        lease = await leased(db, c.commandId);
      await db.$transaction((tx) =>
        completeCommand(tx, { ...lease, commandId: c.commandId, assistantContent: finalContent }),
      );
      const events = (
        await db.$transaction((tx) =>
          replayEvents(tx, { owner: c.owner, aggregateId: c.commandId }),
        )
      ).events;
      expect(events.map((e) => e.sequence)).toEqual([1, 2]);
      expect(events[0].occurredAt).toBe(events[1].occurredAt);
      for (const event of events) {
        expect(Object.keys(event).sort()).toEqual([
          "aggregateId",
          "eventId",
          "occurredAt",
          "payload",
          "payloadVersion",
          "sequence",
          "status",
          "traceId",
          "type",
        ]);
        expect(sseFrame(event).startsWith(`id: ${event.eventId}\n`)).toBe(true);
      }
      for (const cursor of [
        { lastEventId: events[0].eventId },
        { afterSequence: "1" },
        { lastEventId: events[0].eventId, afterSequence: "1" },
      ]) {
        const replay = await db.$transaction((tx) =>
          replayEvents(tx, { owner: c.owner, aggregateId: c.commandId, ...cursor }),
        );
        expect(replay.events.map((e) => e.eventId)).toEqual([events[1].eventId]);
      }
      expect(
        (
          await db.$transaction((tx) =>
            replayEvents(tx, { owner: c.owner, aggregateId: c.commandId, afterSequence: "2" }),
          )
        ).checkpoint,
      ).toEqual({ eventId: events[1].eventId, sequence: 2 });
      await expect(
        db.$transaction((tx) =>
          replayEvents(tx, {
            owner: c.owner,
            aggregateId: c.commandId,
            lastEventId: events[0].eventId,
            afterSequence: "2",
          }),
        ),
      ).rejects.toMatchObject({ status: 400 });
      const foreign = await accepted(db),
        foreignEvent = await db.chatCommandEvent.findFirstOrThrow({
          where: { aggregateId: foreign.commandId },
        });
      await expect(
        db.$transaction((tx) =>
          replayEvents(tx, {
            owner: c.owner,
            aggregateId: c.commandId,
            lastEventId: foreignEvent.eventId,
          }),
        ),
      ).rejects.toBeDefined();
      observe("replay", "ordered-cursors", {
        sameMillisecond: true,
        persistentSequences: [1, 2],
        cursorForms: 3,
        mismatchRejections: 1,
        foreignCursorRejections: 1,
      });
    });
  });
  it("replay: database event uniqueness and append-only rules reject duplicate facts and unauthorized writes", async () => {
    const c = await accepted(db),
      event = await db.chatCommandEvent.findFirstOrThrow({ where: { aggregateId: c.commandId } }),
      before = await counts();
    const eventId = "evt_" + randomUUID().replaceAll("-", "");
    // This transaction would create a duplicate accepted fact if both ordering uniques were removed.
    let duplicateRejected = false;
    try {
      await db.$transaction(async (tx) => {
        const duplicate = await tx.chatCommandEvent.create({
          data: {
            eventId,
            aggregateId: event.aggregateId,
            sequence: event.sequence,
            traceId: event.traceId,
            type: event.type,
            status: event.status,
            occurredAt: event.occurredAt,
            payloadVersion: 1,
            payloadJson: event.payloadJson as Prisma.InputJsonObject,
          },
        });
        const envelope = {
          eventId: duplicate.eventId,
          sequence: duplicate.sequence,
          aggregateId: duplicate.aggregateId,
          traceId: duplicate.traceId,
          type: duplicate.type,
          status: duplicate.status,
          occurredAt: duplicate.occurredAt.toISOString(),
          payloadVersion: 1,
          payload: duplicate.payloadJson,
        };
        await tx.outbox.create({
          data: {
            aggregateId: c.commandId,
            type: duplicate.type,
            eventId,
            payloadHash: canonicalHash(envelope),
            payloadJson: envelope as Prisma.InputJsonObject,
          },
        });
      });
    } catch {
      duplicateRejected = true;
    }
    expect(
      duplicateRejected,
      "persistent event uniqueness must reject a duplicate accepted sequence",
    ).toBe(true);
    for (const operation of [
      () =>
        db.chatCommandEvent.update({
          where: { eventId: event.eventId },
          data: { status: "FAILED" },
        }),
      () => db.chatCommandEvent.delete({ where: { eventId: event.eventId } }),
      () => db.$executeRawUnsafe('TRUNCATE "ChatCommandEvent"'),
    ])
      await expect(operation()).rejects.toBeDefined();
    const other = await anonymousOwner(db);
    await expect(
      db.$transaction((tx) => replayEvents(tx, { owner: other.owner, aggregateId: c.commandId })),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(await counts()).toEqual(before);
    observe("replay", "unique-append-only", {
      duplicateRejected,
      appendOnlyRejections: 3,
      unauthorizedReads: 0,
    });
  });
  it("replay: page byte and retention limits fail closed with 410 and full persistent reconciliation", async () => {
    const c = await accepted(db),
      row = await db.chatCommandEvent.findFirstOrThrow({ where: { aggregateId: c.commandId } });
    const event = (
      await db.$transaction((tx) => replayEvents(tx, { owner: c.owner, aggregateId: c.commandId }))
    ).events[0];
    expect(() =>
      assertReplayWindow(
        Array.from({ length: 1001 }, (_, i) => ({ ...event, sequence: i + 1 })),
        Date.now(),
      ),
    ).toThrow("RESYNC_REQUIRED");
    expect(() =>
      assertReplayWindow([{ ...event, payload: { text: "x".repeat(262144) } }], Date.now()),
    ).toThrow("RESYNC_REQUIRED");
    expect(() =>
      assertReplayWindow([event], Date.parse(event.occurredAt) + REPLAY_RETENTION_MS + 1),
    ).toThrow("RESYNC_REQUIRED");
    await withClock(new Date(row.occurredAt.getTime() + REPLAY_RETENTION_MS + 1), async () => {
      const response = await openChatEventStream(db, {
        owner: c.owner,
        aggregateId: c.commandId,
        lastEventId: row.eventId,
      });
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({
        error: { code: "RESYNC_REQUIRED", action: "RECONCILE_MESSAGES" },
      });
      const reconciliation = await reconcileCommand(db, c.owner, c.commandId);
      expect(reconciliation.messages.length).toBe(1);
      expect(reconciliation.status).toBe("PENDING");
    });
    observe("replay", "bounded-window", {
      pageLimit: 1000,
      byteLimit: 262144,
      retentionHours: 24,
      publicStatus: 410,
      missingHistoryInvented: 0,
    });
  });
  it("replay: direct database writes cannot detach messages change identity or commit half a terminal result", async () => {
    const c = await accepted(db),
      lease = await leased(db, c.commandId),
      task = await db.durableTask.findUniqueOrThrow({ where: { commandId: c.commandId } });
    const foreign = await accepted(db),
      before = await commandCounts(db, c.commandId);
    const direct = [
      () => db.chatMessage.update({ where: { id: c.userMessageId }, data: { commandId: null } }),
      () =>
        db.chatMessage.update({
          where: { id: c.userMessageId },
          data: { travelRecordId: foreign.travel.id },
        }),
      () =>
        db.chatMessage.update({
          where: { id: c.userMessageId },
          data: { content: "changed accepted intent" },
        }),
      () =>
        db.chatMessage.create({
          data: {
            travelRecordId: c.travel.id,
            commandId: c.commandId,
            role: "USER",
            kind: "TEXT",
            content: "duplicate",
            sequence: 99,
          },
        }),
      () =>
        db.chatCommand.update({
          where: { id: c.commandId },
          data: { status: "COMPLETED", completedAt: new Date() },
        }),
      () =>
        db.chatCommand.update({
          where: { id: c.commandId },
          data: { ownerKeyHash: "0".repeat(64) },
        }),
      () =>
        db.commandIdempotency.updateMany({
          where: { commandId: c.commandId },
          data: { status: "COMPLETED" },
        }),
      () =>
        db.durableTask.update({
          where: { id: task.id },
          data: { payloadRef: "task-payload:missing" },
        }),
      () =>
        db.chatCommandEvent.create({
          data: {
            eventId: "evt_" + randomUUID().replaceAll("-", ""),
            sequence: 2,
            aggregateId: c.commandId,
            traceId: c.input.traceId,
            type: "assistant.delta",
            status: "RUNNING",
            occurredAt: new Date(),
            payloadVersion: 1,
            payloadJson: { text: "forbidden" },
          },
        }),
    ];
    for (const operation of direct) await expect(operation()).rejects.toBeDefined();
    expect(await commandCounts(db, c.commandId)).toEqual(before);
    for (const table of ["ChatMessage", "ChatCommandEvent", "Outbox"]) {
      await ownerDb.$executeRawUnsafe(
        "CREATE OR REPLACE FUNCTION public.phase016_terminal_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PHASE016_TERMINAL_FAULT'; END; $$",
      );
      await ownerDb.$executeRawUnsafe(
        `CREATE TRIGGER phase016_terminal_fault BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION public.phase016_terminal_fault()`,
      );
      try {
        await expect(
          db.$transaction((tx) =>
            completeCommand(tx, {
              ...lease,
              commandId: c.commandId,
              assistantContent: finalContent,
            }),
          ),
        ).rejects.toBeDefined();
        expect(await commandCounts(db, c.commandId)).toEqual(before);
      } finally {
        await ownerDb.$executeRawUnsafe(`DROP TRIGGER phase016_terminal_fault ON "${table}"`);
      }
    }
    await ownerDb.$executeRawUnsafe("DROP FUNCTION public.phase016_terminal_fault()");
    await db.$transaction((tx) =>
      completeCommand(tx, { ...lease, commandId: c.commandId, assistantContent: finalContent }),
    );
    observe("replay", "database-invariants", {
      rejectedDirectWrites: direct.length,
      terminalFaults: 3,
      partialTerminalRows: 0,
    });
  });
  it("replay: outbox delivery followed by process death before ACK retries without duplicate messages or stream events", async () => {
    while (await drainOutbox(db, { batchSize: 100 })) {}
    const c = await accepted(db),
      live = await stream(db, c.owner, c.commandId),
      a = await worker({ action: "outbox", holdAt: "ACK" });
    let b: Awaited<ReturnType<typeof worker>> | undefined;
    try {
      const delivered = await a.wait("delivered");
      expect(
        await db.outbox.count({ where: { eventId: delivered.eventId, status: "PENDING" } }),
      ).toBe(1);
      await a.close();
      await new Promise((r) => setTimeout(r, 5200));
      b = await worker({ action: "outbox" });
      await b.wait("done");
      const outbox = await db.outbox.findUniqueOrThrow({ where: { eventId: delivered.eventId } });
      expect(outbox.status).toBe("DELIVERED");
      expect(outbox.attemptCount).toBe(2);
      await waitUntil(() => live.events.length >= 1);
      await new Promise((r) => setTimeout(r, 200));
      expect(live.events.length).toBe(1);
      expect(await commandCounts(db, c.commandId)).toEqual({
        status: "PENDING",
        users: 1,
        assistants: 0,
        terminal: 0,
        deltas: 0,
      });
      observe("replay", "ack-loss", {
        deliveryAttempts: 2,
        acks: 1,
        visibleAcceptedEvents: 1,
        duplicateMessages: 0,
      });
    } finally {
      await live.close();
      await a.close();
      await b?.close();
    }
  }, 30000);

  it("transient-delta: real HTTP chunks are visible only live and disconnect leaves one complete reconciled final message", async () => {
    const c = await accepted(db),
      expected = promptKeyContract("conversation.modify").fixtureOutput;
    let release: () => void = () => {},
      outsideTransaction = false;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const http = await startHttpFixture(async (request, response) => {
      const [{ count }] = await ownerDb.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND usename=${phase016Config().appUser} AND pid<>pg_backend_pid() AND application_name<>'chat-stream' AND state='idle in transaction'`;
      outsideTransaction = count === BigInt(0);
      const body = JSON.parse(request.body);
      expect(body.messages[1].content === c.input.message).toBe(true);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const output = JSON.stringify(expected),
        split = Math.floor(output.length / 2);
      response.write(
        `data: ${JSON.stringify({ id: "synthetic_stream", choices: [{ delta: { content: output.slice(0, split) } }] })}\n\n`,
      );
      await pause;
      response.write(
        `data: ${JSON.stringify({ id: "synthetic_stream", choices: [{ delta: { content: output.slice(split) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
    await mockTuple({ mode: "LIVE" });
    const live = await stream(db, c.owner, c.commandId);
    await waitUntil(() => live.events.length === 1);
    const initialCheckpoint = advanceChatCheckpoint(null, live.events[0]);
    const running = run(c.commandId, {
      ai: { transport: http.transport, dnsLookup: http.dnsLookup, liveEgressAllowed: true },
    });
    try {
      await waitUntil(() => live.events.some((e) => e.type === "assistant.delta"));
      expect(live.events.reduce(advanceChatCheckpoint, null)).toEqual(initialCheckpoint);
      expect((await commandCounts(db, c.commandId)).deltas).toBe(0);
      expect((await commandCounts(db, c.commandId)).assistants).toBe(0);
      await live.close();
      expect((await db.chatCommand.findUniqueOrThrow({ where: { id: c.commandId } })).status).toBe(
        "RUNNING",
      );
      release();
      expect(await running).toBe("COMPLETED");
      expect(outsideTransaction).toBe(true);
      const reconnect = await openChatEventStream(
        db,
        { owner: c.owner, aggregateId: c.commandId, lastEventId: initialCheckpoint!.eventId },
        { databaseUrl: phase016Config().appUrl },
      );
      const frames = await reconnect.text();
      expect(frames.includes("assistant.completed")).toBe(true);
      expect(frames.includes("assistant.delta")).toBe(false);
      const state = await reconcileCommand(db, c.owner, c.commandId);
      expect(state.messages.filter((m) => m.role === "ASSISTANT")).toHaveLength(1);
      expect(await commandCounts(db, c.commandId)).toEqual({
        status: "COMPLETED",
        users: 1,
        assistants: 1,
        terminal: 1,
        deltas: 0,
      });
      observe("transient-delta", "live-disconnect-reconnect", {
        realHttp: true,
        liveDeltas: live.events.filter((e) => e.type === "assistant.delta").length,
        persistentDeltas: 0,
        checkpointAdvancesFromDeltas: 0,
        disconnectCancellations: 0,
        finalMessages: 1,
        outsideTransaction,
      });
    } finally {
      release();
      await running;
      await live.close();
      await http.close();
      await mockTuple();
    }
  }, 30000);
  it("transient-delta: transport enforces byte and time ceilings while durable work remains resumable", async () => {
    const c = await accepted(db);
    await leased(db, c.commandId, 60000);
    const response = await openChatEventStream(
      db,
      { owner: c.owner, aggregateId: c.commandId },
      { databaseUrl: phase016Config().appUrl },
    );
    const reader = response.body!.getReader();
    let bytes = 0,
      closed = false;
    const reading = (async () => {
      for (;;) {
        const row = await reader.read();
        if (row.done) {
          closed = true;
          break;
        }
        bytes += row.value.byteLength;
      }
    })();
    await waitUntil(() => bytes > 0);
    for (let index = 0; index < 400 && !closed; index++)
      await db.$transaction((tx) =>
        publishChatDelta(tx, {
          eventId: "evt_" + randomUUID().replaceAll("-", ""),
          sequence: 1,
          aggregateId: c.commandId,
          traceId: c.input.traceId,
          type: "assistant.delta",
          status: "RUNNING",
          occurredAt: new Date().toISOString(),
          payloadVersion: 1,
          payload: { commandId: c.commandId, deltaIndex: index, text: "x".repeat(1000) },
        }),
      );
    await waitUntil(() => closed);
    await reading;
    expect(bytes).toBeLessThanOrEqual(262144);
    expect(bytes).toBeGreaterThan(250000);
    const started = Date.now();
    const timed = await openChatEventStream(
      db,
      { owner: c.owner, aggregateId: c.commandId },
      { databaseUrl: phase016Config().appUrl, connectionMs: 100 },
    );
    await timed.text();
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(Date.now() - started).toBeLessThan(3000);
    await expect(
      openChatEventStream(
        db,
        { owner: c.owner, aggregateId: c.commandId },
        { connectionMs: 60001 },
      ),
    ).rejects.toBeDefined();
    expect((await commandCounts(db, c.commandId)).deltas).toBe(0);
    expect((await commandCounts(db, c.commandId)).status).toBe("RUNNING");
    await cancelChatCommand(db, { owner: c.owner, commandId: c.commandId });
    observe("transient-delta", "transport-ceilings", {
      bytes,
      timeCeilingMs: 60000,
      reducedTestMs: 100,
      durableDeltas: 0,
      transportCancels: 0,
    });
  }, 15000);

  it("cancel-race: cancelled winner rejects a late completion and completed winner is replayed by cancel", async () => {
    await mockTuple();
    for (const winner of ["CANCELLED", "COMPLETED"]) {
      const c = await accepted(db),
        w = await worker({ action: "run", commandId: c.commandId, holdAt: "OUTPUT_READY" });
      try {
        const claim = await w.wait("claim");
        await w.wait("stage", "OUTPUT_READY");
        if (winner === "CANCELLED") {
          expect(
            (await cancelChatCommand(db, { owner: c.owner, commandId: c.commandId })).winner,
          ).toBe("CANCELLED");
          const late = await db.$transaction((tx) =>
            completeCommand(tx, {
              taskId: claim.taskId!,
              leaseOwner: claim.leaseOwner!,
              fencingToken: claim.fencingToken!,
              commandId: c.commandId,
              assistantContent: finalContent,
            }),
          );
          expect(late.winner, "terminal CAS loser must return the actual cancelled winner").toBe(
            "CANCELLED",
          );
          w.release();
          expect((await w.wait("done")).result).toBe("CANCELLED");
        } else {
          w.release();
          expect((await w.wait("done")).result).toBe("COMPLETED");
          expect(
            (await cancelChatCommand(db, { owner: c.owner, commandId: c.commandId })).winner,
          ).toBe("COMPLETED");
        }
        expect(await commandCounts(db, c.commandId)).toEqual({
          status: winner,
          users: 1,
          assistants: winner === "COMPLETED" ? 1 : 0,
          terminal: 1,
          deltas: 0,
        });
        await expect(
          db.chatCommand.update({
            where: { id: c.commandId },
            data: { status: "RUNNING", completedAt: null },
          }),
        ).rejects.toBeDefined();
        observe("cancel-race", winner, {
          terminalEvents: 1,
          assistantMessages: winner === "COMPLETED" ? 1 : 0,
          loserWrites: 0,
          realWorker: true,
        });
      } finally {
        await w.close();
      }
    }
  }, 30000);
  it("cancel-race: owner cancellation aborts an active guarded call but leaves unknown billing reserved", async () => {
    await mockTuple({ timeout: 10000 });
    const c = await accepted(db);
    const running = run(c.commandId, { ai: { mockDelayMs: 8000 } });
    await waitUntil(
      async () =>
        (await db.aiUsageReservation.count({
          where: { traceId: c.input.traceId, submissionState: "MAY_HAVE_BEEN_SENT" },
        })) === 1,
    );
    const started = Date.now();
    await cancelChatCommand(db, { owner: c.owner, commandId: c.commandId });
    expect(await running).toBe("CANCELLED");
    expect(Date.now() - started).toBeLessThan(3000);
    const reservation = await db.aiUsageReservation.findFirstOrThrow({
      where: { traceId: c.input.traceId },
    });
    expect(reservation.status).not.toBe("RELEASED");
    const attempts = await db.aiOutputRecord.findMany({ where: { commandId: c.commandId } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      traceId: c.input.traceId,
      status: "CANCELLED",
      parsedOk: false,
      errorCode: "CANCELLED",
      rawOutput: null,
    });
    expect(attempts[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(await commandCounts(db, c.commandId)).toEqual({
      status: "CANCELLED",
      users: 1,
      assistants: 0,
      terminal: 1,
      deltas: 0,
    });
    const failed = await accepted(db),
      lease = await leased(db, failed.commandId);
    await db.$transaction((tx) =>
      failCommand(tx, { ...lease, commandId: failed.commandId, errorCode: "PROVIDER_TIMEOUT" }),
    );
    expect(
      (await cancelChatCommand(db, { owner: failed.owner, commandId: failed.commandId })).winner,
    ).toBe("FAILED");
    expect((await commandCounts(db, failed.commandId)).terminal).toBe(1);
    observe("cancel-race", "abort-and-failed-replay", {
      abortObserved: true,
      unknownReservationsReleased: 0,
      failedWinnerReplayed: true,
    });
  }, 15000);

  for (const [mode, code] of [
    ["timeout", "PROVIDER_TIMEOUT"],
    ["rate", "RATE_LIMITED"],
    ["cost", "COST_LIMIT"],
    ["network", "PROVIDER_UNAVAILABLE"],
    ["invalid", "PROVIDER_UNAVAILABLE"],
  ] as const)
    it(`provider-failure: guarded ${mode} preserves USER intent and one safe failure audit without partial assistant`, async () => {
      const http = await startHttpFixture(async (_request, response) => {
        if (mode === "timeout") {
          await new Promise((r) => setTimeout(r, 1800));
          sendCompletion(response, promptKeyContract("conversation.modify").fixtureOutput);
        } else if (mode === "rate") {
          response.writeHead(429, { "content-type": "application/json" });
          response.end("{}");
        } else if (mode === "network") response.destroy();
        else if (mode === "invalid") sendCompletion(response, { schemaVersion: 1, wrong: "shape" });
        else sendCompletion(response, promptKeyContract("conversation.modify").fixtureOutput);
      });
      await mockTuple({
        mode: "LIVE",
        timeout: 1000,
        pricing: {
          inputPerToken: "0",
          outputPerToken: "0",
          fixedPerRequest: mode === "cost" ? "0.1" : "0",
          basis: "UTF8_BYTE_UPPER_BOUND_V1",
        },
      });
      const c = await accepted(db);
      try {
        expect(
          await run(c.commandId, {
            ai: {
              transport: http.transport,
              dnsLookup: http.dnsLookup,
              liveEgressAllowed: true,
              ...(mode === "cost" ? { costCap: "0" } : {}),
            },
          }),
        ).toBe("FAILED");
        const command = await db.chatCommand.findUniqueOrThrow({ where: { id: c.commandId } });
        expect(command.errorCode).toBe(code);
        expect(await commandCounts(db, c.commandId)).toEqual({
          status: "FAILED",
          users: 1,
          assistants: 0,
          terminal: 1,
          deltas: 0,
        });
        const logs = await db.aiOutputRecord.findMany({ where: { commandId: c.commandId } });
        expect(logs).toHaveLength(1);
        expect(logs[0].parsedOk).toBe(false);
        expect(logs[0].rawOutput).toBeNull();
        expect(logs[0].errorCode).toBe(mode === "invalid" ? "SCHEMA_MISMATCH" : code);
        expect(logs[0].status).toBe("FAILED");
        expect(
          await db.commandIdempotency.count({
            where: { commandId: c.commandId, status: "FAILED" },
          }),
        ).toBe(1);
        const terminal = await db.chatCommandEvent.findFirstOrThrow({
          where: { aggregateId: c.commandId, type: "command.failed" },
        });
        expect((terminal.payloadJson as Prisma.JsonObject).conversationCursor).toBeDefined();
        expect(http.requests.length).toBe(mode === "cost" ? 0 : 1);
        observe("provider-failure", mode, {
          code,
          guardedAttempts: logs.length,
          httpCalls: http.requests.length,
          users: 1,
          partialAssistants: 0,
          terminalEvents: 1,
          rawOutputs: 0,
        });
      } finally {
        await http.close();
        await mockTuple();
      }
    }, 15000);
  it("provider-failure: current ownership is checked before delayed output can be committed", async () => {
    await mockTuple();
    const identity = await loginOwner(db),
      c = await accepted(db, identity.owner);
    let release: () => void = () => {};
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = false;
    const running = run(c.commandId, {
      onCheckpoint: async (stage) => {
        if (stage === "OUTPUT_READY") {
          reached = true;
          await pause;
        }
      },
    });
    await waitUntil(() => reached);
    await ownerDb.user.update({ where: { id: identity.user.id }, data: { status: "DISABLED" } });
    release();
    await running;
    expect((await commandCounts(db, c.commandId)).assistants).toBe(0);
    expect((await commandCounts(db, c.commandId)).terminal).toBe(1);
    observe("provider-failure", "revoked-before-commit", {
      assistantWrites: 0,
      safeFailureTerminal: 1,
    });
  });
  it("mutation: forbidden route and direct Provider import scans cover the complete product source", () => {
    expect(scanAiBoundary()).toEqual([]);
    const routes = [
      "src/app/api/chat/route.ts",
      "src/app/api/nlu/parse/route.ts",
      "src/app/api/nlu/extract/route.ts",
      "src/app/api/plan/generate/route.ts",
      "src/app/api/session/anonymous/route.ts",
      "src/app/api/travel-records/[id]/commands/route.ts",
    ];
    expect(routes.filter((file) => fs.existsSync(file))).toEqual([]);
    observe("mutation", "import-route-source", {
      directProviderImports: 0,
      legacyRoutes: 0,
      prematureRoutes: 0,
    });
  });
});
