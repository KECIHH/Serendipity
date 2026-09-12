import "server-only";

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  ApiKeyInputError,
  assertApiKeyTransition,
  parseApiKeyCreate,
  parseApiKeyId,
  parseApiKeyPatch,
  parseApiKeyQuery,
  parseApiKeyRotateRequest,
  type ApiKeyDto,
  type ApiKeyPage,
  type ApiKeyPatch,
} from "@/lib/admin-api-keys";
import { fail } from "@/lib/api-response";
import { env } from "@/lib/env";
import { decodeApiKeyCursor, encodeApiKeyCursor } from "@/server/admin/api-key-cursor";
import {
  AdminCommandError,
  findAdminCommandReceipt,
  makeAdminCommandIdentity,
  readSucceededKeyReceipt,
  writeSucceededKeyReceipt,
  type AdminCommandIdentity,
} from "@/server/admin/command-receipt";
import {
  createKeyCandidateClient,
  type KeyCandidateClient,
} from "@/server/admin/key-candidate-client";
import { KeyLifecycleError, type KeyReferenceAdapter } from "@/server/admin/key-reference";
import { createKeyRotationCoordinator } from "@/server/admin/key-rotation";
import { AuditLogError, createAuditContext, type AuditRequestContext } from "@/server/audit-log";
import { readAuthClock } from "@/server/auth/clock";
import { assertCookieMutation, CookieRequestError, readAuthCookie } from "@/server/auth/cookie";
import { AuthAuthorizationError } from "@/server/auth/errors";
import { createSessionService, hashSessionToken } from "@/server/auth/session-service";
import type { AuthPrincipal } from "@/server/auth/types";
import {
  ADMIN_API_KEY_COLUMNS,
  adminApiKeyDto,
  readAdminApiKey,
  type AdminApiKeyRow,
} from "@/server/projections/admin-api-key";
import {
  createKeyResolver,
  encryptSecret,
  generateFingerprint,
  SecretDecryptError,
  type KeyResolver,
} from "@/server/security/secret-envelope";
import {
  AuditTransactionConflictError,
  openAuditedAdminDatabase,
  writeAuditLog,
  type AuditTransactionClient,
} from "@/server/services/audit-log-service";

export { KeyLifecycleError as AdminApiKeysError };

function safeFailure(error: unknown): KeyLifecycleError {
  if (error instanceof KeyLifecycleError) return error;
  if (
    error instanceof ApiKeyInputError ||
    (error instanceof AdminCommandError && error.kind === "VALIDATION_ERROR")
  )
    return new KeyLifecycleError(400, "VALIDATION_ERROR");
  if (error instanceof AdminCommandError && error.kind === "IDEMPOTENCY_KEY_REUSED")
    return new KeyLifecycleError(409, "IDEMPOTENCY_KEY_REUSED");
  if (error instanceof AuthAuthorizationError)
    return new KeyLifecycleError(error.status, error.code);
  if (error instanceof CookieRequestError) return new KeyLifecycleError(403, "FORBIDDEN");
  if (error instanceof SecretDecryptError) return new KeyLifecycleError(503, "CONFIG_ERROR");
  return new KeyLifecycleError(503, "INTERNAL_ERROR");
}

export function adminApiKeysFailure(error: unknown, requestId: string): Response {
  const failure = safeFailure(error);
  const message =
    failure.status === 401
      ? "请先登录"
      : failure.status === 403
        ? "无法执行此操作"
        : failure.status === 404
          ? "未找到此密钥"
          : failure.status === 409
            ? "操作发生冲突，请刷新后重试"
            : failure.status === 400
              ? "请求内容无效，请检查后重试"
              : "密钥服务暂时不可用，请稍后重试";
  return Response.json(fail(failure.publicCode, message, requestId, failure.details), {
    status: failure.status,
    headers: { "cache-control": "no-store" },
  });
}

interface CurrentIdentity {
  principal: AuthPrincipal;
  tokenHash: string;
}
interface KeyMutationResult {
  key: ApiKeyDto;
  replayed: boolean;
}
class CompletedKeyCommand extends AuditLogError {
  constructor(readonly result: KeyMutationResult) {
    super("VALIDATION_ERROR");
  }
}
class UnchangedKeyCommand extends AuditLogError {}

function conflict(key: ApiKeyDto): never {
  throw new KeyLifecycleError(409, "VERSION_CONFLICT", {
    currentVersion: key.revision,
    action: "RELOAD",
    current: key,
  });
}

function retryable(error: unknown): boolean {
  return (
    error instanceof AuditTransactionConflictError ||
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      (["P2034", "P2002"].includes(error.code) ||
        (error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code)))))
  );
}

async function readBody<T>(request: Request, parser: (value: unknown) => T): Promise<T> {
  const length = request.headers.get("content-length");
  if (
    request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
      "application/json" ||
    !request.body ||
    (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 131_072))
  )
    throw new ApiKeyInputError();
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 131_072) {
        await reader.cancel();
        throw new ApiKeyInputError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return parser(
      JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks))),
    );
  } catch {
    throw new ApiKeyInputError();
  }
}

function idempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key");
  if (!value || !/^[A-Za-z0-9_.:-]{8,128}$/.test(value)) throw new ApiKeyInputError();
  return value;
}

export interface AdminApiKeysServiceOptions {
  readonly databaseUrl?: string;
  readonly cursorSecret?: string;
  readonly resolver?: KeyResolver;
  readonly referenceAdapters?: readonly KeyReferenceAdapter[];
  readonly candidateClient?: KeyCandidateClient;
  readonly queryObserver?: (query: string) => void;
}

export function createAdminApiKeysService(options: AdminApiKeysServiceOptions = {}) {
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL,
    cursorSecret = options.cursorSecret ?? env.AUTH_SECRET;
  const resolver = options.resolver ?? createKeyResolver();
  const client = new PrismaClient({
    datasourceUrl: databaseUrl,
    log: [{ emit: "event", level: "query" }],
  });
  if (options.queryObserver) client.$on("query", (event) => options.queryObserver!(event.query));
  const sessions = createSessionService({ databaseUrl }),
    audited = openAuditedAdminDatabase(databaseUrl);
  const rotation = createKeyRotationCoordinator({
    client,
    audited,
    resolver,
    adapters: options.referenceAdapters ?? [],
    candidateClient: options.candidateClient ?? createKeyCandidateClient(),
  });

  async function authorize(request: Request): Promise<CurrentIdentity> {
    const claims = await readAuthCookie(request);
    if (!claims) throw new AuthAuthorizationError(401, "AUTH_REQUIRED");
    const tokenHash = hashSessionToken(claims.opaqueToken);
    if (!tokenHash) throw new AuthAuthorizationError(401, "AUTH_REQUIRED");
    const principal = await sessions.validateSession(claims.opaqueToken, "ADMIN");
    if (principal.role !== "ADMIN" || principal.audience !== "ADMIN")
      throw new AuthAuthorizationError(403, "FORBIDDEN");
    return { principal, tokenHash };
  }

  async function authorizeLocked(tx: Prisma.TransactionClient, identity: CurrentIdentity) {
    // Common lock ordering with Phase012 closes the authorization race while administrators change.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('serendipity:admin-users:v1',0::bigint))`;
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${identity.principal.id} FOR UPDATE`;
    const rows = await tx.$queryRaw<Array<{ id: string; email: string }>>`
      SELECT u.id,u.email FROM "User" u JOIN "AuthSession" s ON s."userId"=u.id
      WHERE u.id=${identity.principal.id} AND s."tokenHash"=${identity.tokenHash}
        AND u.role='ADMIN' AND u.status='ACTIVE' AND s.audience='ADMIN' AND s.status='ACTIVE'
        AND s."expiresAt">public.auth_now() AND s."sessionVersion"=u."sessionVersion" FOR UPDATE OF s
    `;
    if (rows.length !== 1) throw new KeyLifecycleError(401, "AUTH_REQUIRED");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('serendipity:api-keys:v1',0::bigint))`;
    return rows[0];
  }

  async function state(
    tx: Prisma.TransactionClient,
    identity: CurrentIdentity,
    command: AdminCommandIdentity,
    targetId?: string,
  ) {
    const actor = await authorizeLocked(tx, identity);
    const receipt = await findAdminCommandReceipt(tx, command);
    if (receipt) return { actor, replay: readSucceededKeyReceipt(receipt), key: null };
    if (!targetId) return { actor, replay: null, key: null };
    await tx.$queryRaw`SELECT id FROM "ApiKeyConfig" WHERE id=${targetId} FOR UPDATE`;
    const key = await readAdminApiKey(tx, targetId);
    if (!key) throw new KeyLifecycleError(404, "NOT_FOUND");
    return { actor, replay: null, key };
  }

  async function safeTransaction<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (!retryable(error) || attempt === 3) throw error;
        await delay(15 * (attempt + 1));
      }
    }
    throw new KeyLifecycleError(503, "INTERNAL_ERROR");
  }

  async function changed(
    tx: AuditTransactionClient,
    identity: CurrentIdentity,
    id: string,
    patch: ApiKeyPatch,
    command: AdminCommandIdentity,
    context: AuditRequestContext,
  ): Promise<ApiKeyDto> {
    const current = await state(tx, identity, command, id);
    if (current.replay) throw new CompletedKeyCommand({ key: current.replay, replayed: true });
    const old = current.key!;
    if (old.revision !== patch.expectedVersion) conflict(old);
    const nextStatus = patch.status ?? old.status,
      nextName = patch.name ?? old.name;
    try {
      assertApiKeyTransition(old.status, nextStatus);
    } catch {
      throw new KeyLifecycleError(409, "VERSION_CONFLICT");
    }
    if (nextStatus === "ACTIVE" && old.status !== "ACTIVE") {
      const candidate = await tx.keyRotationRun.findFirst({
        where: { newKeyId: id, stage: { not: "ACTIVATED" } },
        select: { id: true },
      });
      if (candidate) throw new KeyLifecycleError(409, "VERSION_CONFLICT");
    }
    const fingerprint = generateFingerprint(nextName);
    const nameSecret = await tx.apiKeyConfig.count({ where: { id, keyFingerprint: fingerprint } });
    if (nameSecret) throw new KeyLifecycleError(400, "VALIDATION_ERROR");
    if (nextStatus === old.status && nextName === old.name)
      throw new UnchangedKeyCommand("VALIDATION_ERROR");
    const now = await readAuthClock(tx);
    await tx.apiKeyConfig.update({
      where: { id, revision: patch.expectedVersion },
      data: {
        name: nextName,
        status: nextStatus,
        revision: { increment: 1 },
        updatedAt: now,
        ...(nextStatus === "REVOKED" && old.status !== "REVOKED" ? { revokedAt: now } : {}),
      },
      select: { id: true },
    });
    const result = await readAdminApiKey(tx, id);
    if (!result) throw new KeyLifecycleError(503, "INTERNAL_ERROR");
    await writeAuditLog(tx, {
      actor: { kind: "USER", id: current.actor.id, emailSnapshot: current.actor.email },
      action:
        nextStatus === "REVOKED" && old.status !== "REVOKED" ? "API_KEY_REVOKE" : "API_KEY_UPDATE",
      targetType: "ApiKeyConfig",
      targetId: id,
      context,
      detailJson: {
        before: { status: old.status, revision: old.revision },
        after: { status: result.status, revision: result.revision },
        result: "SUCCESS",
        reasonCode:
          nextStatus === "REVOKED" && old.status !== "REVOKED" ? "KEY_REVOKED" : "KEY_UPDATED",
      },
    });
    await writeSucceededKeyReceipt(tx, command, result);
    return result;
  }

  return Object.freeze({
    async list(request: Request): Promise<ApiKeyPage> {
      try {
        const identity = await authorize(request);
        if (request.method !== "GET") throw new ApiKeyInputError();
        const query = parseApiKeyQuery(new URL(request.url).searchParams);
        const cursor = query.cursor
          ? decodeApiKeyCursor(query.cursor, identity.principal.id, query, cursorSecret)
          : null;
        const watermark = cursor?.watermark ?? (await readAuthClock(client));
        const rows = await client.$queryRaw<AdminApiKeyRow[]>(Prisma.sql`
          SELECT ${ADMIN_API_KEY_COLUMNS} FROM "ApiKeyConfig" WHERE "createdAt" <= ${watermark}
          ${query.provider ? Prisma.sql`AND provider=${query.provider}` : Prisma.empty}
          ${query.status ? Prisma.sql`AND status=${query.status}::"ApiKeyStatus"` : Prisma.empty}
          ${cursor ? Prisma.sql`AND ("createdAt"<${cursor.createdAt} OR ("createdAt"=${cursor.createdAt} AND id<${cursor.id}))` : Prisma.empty}
          ORDER BY "createdAt" DESC,id DESC LIMIT ${query.limit + 1}
        `);
        await authorize(request);
        const items = rows.slice(0, query.limit),
          last = items.at(-1);
        return {
          items: items.map(adminApiKeyDto),
          nextCursor:
            rows.length > query.limit && last
              ? encodeApiKeyCursor(
                  { id: last.id, createdAt: last.createdAt, watermark },
                  identity.principal.id,
                  query,
                  cursorSecret,
                )
              : null,
        };
      } catch (error) {
        throw safeFailure(error);
      }
    },

    async create(
      request: Request,
      context: AuditRequestContext = createAuditContext(),
    ): Promise<KeyMutationResult> {
      try {
        const identity = await authorize(request);
        assertCookieMutation(request, request.headers.get("x-csrf-token"));
        if (request.method !== "POST") throw new ApiKeyInputError();
        const key = idempotencyKey(request),
          input = await readBody(request, parseApiKeyCreate);
        if (input.name.includes(input.plainKey) || input.provider.includes(input.plainKey))
          throw new ApiKeyInputError();
        const fingerprint = generateFingerprint(input.plainKey);
        const command = makeAdminCommandIdentity({
          ownerUserId: identity.principal.id,
          operationId: "post.admin.api-keys",
          resourceId: "global",
          idempotencyKey: key,
          payload: { name: input.name, provider: input.provider, keyFingerprint: fingerprint },
        });
        return await safeTransaction(async () => {
          try {
            const result = await audited.transaction(async (tx) => {
              const current = await state(tx, identity, command);
              if (current.replay)
                throw new CompletedKeyCommand({ key: current.replay, replayed: true });
              if (await tx.apiKeyConfig.count({ where: { keyFingerprint: fingerprint } }))
                throw new KeyLifecycleError(409, "VERSION_CONFLICT");
              const id = `key_${randomUUID()}`,
                now = await readAuthClock(tx);
              const envelope = encryptSecret(
                { id, provider: input.provider, plainKey: input.plainKey },
                resolver,
              );
              await tx.apiKeyConfig.create({
                data: {
                  id,
                  name: input.name,
                  provider: input.provider,
                  ...envelope,
                  status: "ACTIVE",
                  createdAt: now,
                  updatedAt: now,
                },
                select: { id: true },
              });
              const result = await readAdminApiKey(tx, id);
              if (!result) throw new KeyLifecycleError(503, "INTERNAL_ERROR");
              await writeAuditLog(tx, {
                actor: { kind: "USER", id: current.actor.id, emailSnapshot: current.actor.email },
                action: "API_KEY_CREATE",
                targetType: "ApiKeyConfig",
                targetId: id,
                context,
                detailJson: {
                  after: { status: "ACTIVE", revision: 0 },
                  result: "SUCCESS",
                  reasonCode: "KEY_CREATED",
                },
              });
              await writeSucceededKeyReceipt(tx, command, result);
              return result;
            });
            return { key: result, replayed: false };
          } catch (error) {
            if (error instanceof CompletedKeyCommand) return error.result;
            throw error;
          }
        });
      } catch (error) {
        throw safeFailure(error);
      }
    },

    async update(
      request: Request,
      targetId: string,
      context: AuditRequestContext = createAuditContext(),
    ): Promise<KeyMutationResult> {
      try {
        const identity = await authorize(request);
        assertCookieMutation(request, request.headers.get("x-csrf-token"));
        if (request.method !== "PATCH") throw new ApiKeyInputError();
        const key = idempotencyKey(request),
          id = parseApiKeyId(targetId),
          patch = await readBody(request, parseApiKeyPatch);
        const command = makeAdminCommandIdentity({
          ownerUserId: identity.principal.id,
          operationId: "patch.admin.api-keys.id",
          resourceId: id,
          idempotencyKey: key,
          payload: patch,
        });
        return await safeTransaction(async () => {
          try {
            return {
              key: await audited.transaction((tx) =>
                changed(tx, identity, id, patch, command, context),
              ),
              replayed: false,
            };
          } catch (error) {
            if (error instanceof CompletedKeyCommand) return error.result;
            if (!(error instanceof UnchangedKeyCommand)) throw error;
            return client.$transaction(
              async (tx) => {
                const current = await state(tx, identity, command, id);
                if (current.replay) return { key: current.replay, replayed: true };
                const old = current.key!;
                if (
                  old.revision !== patch.expectedVersion ||
                  (patch.name ?? old.name) !== old.name ||
                  (patch.status ?? old.status) !== old.status
                )
                  conflict(old);
                await writeSucceededKeyReceipt(tx, command, old);
                return { key: old, replayed: false };
              },
              { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
            );
          }
        });
      } catch (error) {
        throw safeFailure(error);
      }
    },

    async rotate(
      request: Request,
      targetId: string,
      context: AuditRequestContext = createAuditContext(),
    ) {
      try {
        const identity = await authorize(request);
        assertCookieMutation(request, request.headers.get("x-csrf-token"));
        if (request.method !== "POST") throw new ApiKeyInputError();
        const key = idempotencyKey(request),
          id = parseApiKeyId(targetId),
          input = await readBody(request, parseApiKeyRotateRequest);
        if (input.name.includes(input.plainKey) || input.provider.includes(input.plainKey))
          throw new ApiKeyInputError();
        const command = makeAdminCommandIdentity({
          ownerUserId: identity.principal.id,
          operationId: "post.admin.api-keys.id.rotate",
          resourceId: id,
          idempotencyKey: key,
          payload: {
            name: input.name,
            provider: input.provider,
            expectedVersion: input.expectedVersion,
            keyFingerprint: generateFingerprint(input.plainKey),
          },
        });
        return await rotation.rotate(command, input, {
          context,
          authorize: (tx) => authorizeLocked(tx, identity),
        });
      } catch (error) {
        throw safeFailure(error);
      }
    },
    async disconnect() {
      await Promise.all([client.$disconnect(), sessions.disconnect(), audited.disconnect()]);
    },
  });
}

let shared: ReturnType<typeof createAdminApiKeysService> | undefined;
export function adminApiKeysService() {
  return (shared ??= createAdminApiKeysService());
}
