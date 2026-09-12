import "server-only";

import { setTimeout as delay } from "node:timers/promises";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  AdminUserInputError,
  parseAdminUserId,
  parseAdminUserPatch,
  parseAdminUserQuery,
  type AdminUserDto,
  type AdminUserPage,
  type AdminUserPatch,
  type AdminUserRole,
  type AdminUserStatus,
} from "@/lib/admin-users";
import { fail, type ApiErrorCode } from "@/lib/api-response";
import { env } from "@/lib/env";
import {
  ADMIN_USER_OPERATION,
  AdminCommandError,
  findAdminCommandReceipt,
  makeAdminCommandIdentity,
  readSucceededUserReceipt,
  writeSucceededUserReceipt,
  type AdminCommandIdentity,
} from "@/server/admin/command-receipt";
import { decodeAdminUserCursor, encodeAdminUserCursor } from "@/server/admin/user-cursor";
import { AuditLogError, createAuditContext, type AuditRequestContext } from "@/server/audit-log";
import { readAuthClock } from "@/server/auth/clock";
import { CookieRequestError, assertCookieMutation, readAuthCookie } from "@/server/auth/cookie";
import { AuthAuthorizationError } from "@/server/auth/errors";
import { createSessionService, hashSessionToken } from "@/server/auth/session-service";
import type { AuthPrincipal } from "@/server/auth/types";
import { ADMIN_USER_SELECT, type AdminUser } from "@/server/projections/admin-user";
import {
  AuditTransactionConflictError,
  openAuditedAdminDatabase,
  writeAuditLog,
  type AuditTransactionClient,
} from "@/server/services/audit-log-service";

export class AdminUsersError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 503,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AdminUsersError";
  }
}

function safeFailure(error: unknown): AdminUsersError {
  if (error instanceof AdminUsersError) return error;
  if (
    error instanceof AdminUserInputError ||
    (error instanceof AdminCommandError && error.kind === "VALIDATION_ERROR")
  ) {
    return new AdminUsersError(400, "VALIDATION_ERROR", "请求内容无效，请检查后重试");
  }
  if (error instanceof AdminCommandError && error.kind === "IDEMPOTENCY_KEY_REUSED") {
    return new AdminUsersError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "此请求标识已用于其他操作，请重新选择操作",
    );
  }
  if (error instanceof AuthAuthorizationError) {
    return new AdminUsersError(
      error.status,
      error.code,
      error.status === 401 ? "请先登录" : "没有用户管理权限",
    );
  }
  if (error instanceof CookieRequestError)
    return new AdminUsersError(403, "FORBIDDEN", "请求验证失败，请重新登录后重试");
  return new AdminUsersError(503, "INTERNAL_ERROR", "用户管理服务暂时不可用，请稍后重试");
}

export function adminUsersFailure(error: unknown, requestId: string): Response {
  const failure = safeFailure(error);
  return Response.json(fail(failure.code, failure.message, requestId, failure.details), {
    status: failure.status,
    headers: { "cache-control": "no-store" },
  });
}

function dto(row: AdminUser): AdminUserDto {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl,
    role: row.role,
    status: row.status,
    lastLoginAt: row.lastLoginAt === null ? null : row.lastLoginAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    revision: row.revision,
  };
}

interface CurrentIdentity {
  principal: AuthPrincipal;
  tokenHash: string;
}

interface AdminUserUpdateResult {
  user: AdminUserDto;
  replayed: boolean;
}

class CompletedCommand extends AuditLogError {
  constructor(readonly response: AdminUserDto) {
    super("VALIDATION_ERROR");
  }
}
class UnchangedCommand extends AuditLogError {}
class RejectedCommand extends AuditLogError {
  constructor(readonly failure: AdminUsersError) {
    super("VALIDATION_ERROR");
  }
}

function conflict(row: AdminUser): never {
  throw new AdminUsersError(409, "VERSION_CONFLICT", "用户状态已更新，请根据最新资料重新选择操作", {
    currentVersion: row.revision,
    action: "RELOAD",
    current: dto(row),
  });
}

async function lockAdminSet(
  tx: Prisma.TransactionClient,
  actorId: string,
  targetId: string,
): Promise<void> {
  // One consistent advisory/row lock order covers every admin mutation in every process.
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended('serendipity:admin-users:v1', 0::bigint))
  `;
  await tx.$queryRaw`
    SELECT id FROM "User"
    WHERE (role = 'ADMIN' AND status = 'ACTIVE') OR id IN (${actorId}, ${targetId})
    ORDER BY id FOR UPDATE
  `;
}

async function authorizeLocked(tx: Prisma.TransactionClient, identity: CurrentIdentity) {
  // Authorization reads no sensitive user column into JavaScript; the version match stays in SQL.
  const rows = await tx.$queryRaw<Array<{ id: string; email: string }>>`
    SELECT u.id, u.email FROM "User" u JOIN "AuthSession" s ON s."userId" = u.id
    WHERE u.id = ${identity.principal.id} AND s."tokenHash" = ${identity.tokenHash}
      AND u.role = 'ADMIN' AND u.status = 'ACTIVE' AND s.audience = 'ADMIN'
      AND s.status = 'ACTIVE' AND s."expiresAt" > public.auth_now()
      AND s."sessionVersion" = u."sessionVersion"
    FOR UPDATE OF s
  `;
  if (rows.length !== 1)
    throw new AdminUsersError(401, "AUTH_REQUIRED", "登录状态已失效，请重新登录");
  return rows[0];
}

/** A real locked database invariant, also independently exercised to avoid self/actor guard masking. */
export async function assertActiveAdminRemains(
  tx: Prisma.TransactionClient,
  targetId: string,
  nextRole: AdminUserRole,
  nextStatus: AdminUserStatus,
): Promise<void> {
  parseAdminUserId(targetId);
  if (
    (nextRole !== "ADMIN" && nextRole !== "USER") ||
    (nextStatus !== "ACTIVE" && nextStatus !== "DISABLED")
  ) {
    throw new AdminUserInputError();
  }
  const active = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "User" WHERE role = 'ADMIN' AND status = 'ACTIVE' ORDER BY id FOR UPDATE
  `;
  const removingActive =
    active.some((user) => user.id === targetId) &&
    (nextRole !== "ADMIN" || nextStatus !== "ACTIVE");
  // ADMIN_LAST_ACTIVE_RECHECK: count only after acquiring the ACTIVE ADMIN set locks.
  if (active.length === 0 || (removingActive && active.length <= 1)) {
    throw new AdminUsersError(403, "FORBIDDEN", "至少需要保留一位启用的管理员");
  }
}

async function commandState(
  tx: Prisma.TransactionClient,
  identity: CurrentIdentity,
  targetId: string,
  patch: AdminUserPatch,
  command: AdminCommandIdentity,
) {
  await lockAdminSet(tx, identity.principal.id, targetId);
  const actor = await authorizeLocked(tx, identity);
  const receipt = await findAdminCommandReceipt(tx, command);
  // Replays retain their original safe DTO; the accepted CAS is never reapplied.
  if (receipt) return { actor, replay: readSucceededUserReceipt(receipt), target: null };
  const target = await tx.user.findUnique({ where: { id: targetId }, select: ADMIN_USER_SELECT });
  if (!target) throw new AdminUsersError(404, "NOT_FOUND", "未找到此用户");
  if (target.revision !== patch.expectedVersion) conflict(target);
  return { actor, replay: null, target };
}

async function changedCommand(
  tx: AuditTransactionClient,
  identity: CurrentIdentity,
  targetId: string,
  patch: AdminUserPatch,
  command: AdminCommandIdentity,
  context: AuditRequestContext,
): Promise<AdminUserDto> {
  try {
    const state = await commandState(tx, identity, targetId, patch, command);
    if (state.replay) throw new CompletedCommand(state.replay);
    const target = state.target!;
    if (target.role === patch.role && target.status === patch.status)
      throw new UnchangedCommand("VALIDATION_ERROR");
    if (target.id === state.actor.id)
      throw new AdminUsersError(403, "FORBIDDEN", "不能修改自己的角色或启用状态");
    await assertActiveAdminRemains(tx, target.id, patch.role, patch.status);
    const now = await readAuthClock(tx);
    const updated = await tx.user.update({
      where: { id: target.id, revision: patch.expectedVersion },
      data: {
        role: patch.role,
        status: patch.status,
        revision: { increment: 1 },
        // ADMIN_SESSION_VERSION_INCREMENT: changing either permission field invalidates every old version.
        sessionVersion: { increment: 1 },
      },
      select: ADMIN_USER_SELECT,
    });
    await tx.authSession.updateMany({
      where: { userId: target.id, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: now },
    });
    await writeAuditLog(tx, {
      actor: { kind: "USER", id: state.actor.id, emailSnapshot: state.actor.email },
      action: "USER_UPDATE",
      targetType: "User",
      targetId: target.id,
      context,
      detailJson: {
        before: { role: target.role, status: target.status, revision: target.revision },
        after: { role: updated.role, status: updated.status, revision: updated.revision },
        sessionVersionIncremented: true,
        reason: patch.reason,
        result: "SUCCESS",
        reasonCode: "USER_UPDATED",
      },
    });
    const response = dto(updated);
    await writeSucceededUserReceipt(tx, command, response);
    return response;
  } catch (error) {
    if (
      error instanceof AdminUsersError ||
      error instanceof AdminUserInputError ||
      error instanceof AdminCommandError
    ) {
      throw new RejectedCommand(safeFailure(error));
    }
    throw error;
  }
}

/** A separate, revalidated transaction writes only a receipt. Strict audit enrollment is never relaxed. */
async function unchangedCommand(
  tx: Prisma.TransactionClient,
  identity: CurrentIdentity,
  targetId: string,
  patch: AdminUserPatch,
  command: AdminCommandIdentity,
): Promise<AdminUserUpdateResult> {
  const state = await commandState(tx, identity, targetId, patch, command);
  if (state.replay) return { user: state.replay, replayed: true };
  const target = state.target!;
  if (target.role !== patch.role || target.status !== patch.status) conflict(target);
  const response = dto(target);
  await writeSucceededUserReceipt(tx, command, response);
  return { user: response, replayed: false };
}

const MAX_BODY_BYTES = 8_192;
async function readPatch(request: Request): Promise<AdminUserPatch> {
  const length = request.headers.get("content-length");
  if (
    request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
      "application/json" ||
    (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BODY_BYTES)) ||
    !request.body
  )
    throw new AdminUserInputError();
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new AdminUserInputError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return parseAdminUserPatch(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))),
    );
  } catch {
    throw new AdminUserInputError();
  }
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof AuditTransactionConflictError ||
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      (["P2034", "P2002"].includes(error.code) ||
        (error.code === "P2010" && (error.meta?.code === "40001" || error.meta?.code === "40P01"))))
  );
}

export interface AdminUsersServiceOptions {
  readonly databaseUrl?: string;
  readonly cursorSecret?: string;
  /** Observe real management SQL only, without parameter values or changing the execution path. */
  readonly queryObserver?: (query: string) => void;
}

export function createAdminUsersService(options: AdminUsersServiceOptions = {}) {
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
  const secret = options.cursorSecret ?? env.AUTH_SECRET;
  const client = new PrismaClient({
    datasourceUrl: databaseUrl,
    log: [{ emit: "event", level: "query" }],
  });
  if (options.queryObserver) client.$on("query", (event) => options.queryObserver!(event.query));
  const audited = openAuditedAdminDatabase(databaseUrl);
  const sessions = createSessionService({ databaseUrl });

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

  return Object.freeze({
    async list(request: Request): Promise<AdminUserPage> {
      try {
        const identity = await authorize(request);
        if (request.method !== "GET") throw new AdminUserInputError();
        const query = parseAdminUserQuery(new URL(request.url).searchParams);
        const cursor =
          query.cursor === undefined
            ? null
            : decodeAdminUserCursor(query.cursor, identity.principal.id, query, secret);
        const watermark = cursor?.watermark ?? (await readAuthClock(client));
        const rows = await client.user.findMany({
          where: {
            ...(query.role === undefined ? {} : { role: query.role }),
            ...(query.status === undefined ? {} : { status: query.status }),
            createdAt: { lte: watermark },
            ...(cursor === null
              ? {}
              : {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                  ],
                }),
          },
          select: ADMIN_USER_SELECT,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: query.limit + 1,
        });
        // Recheck authorization before returning an already-read page to a concurrently revoked actor.
        await authorize(request);
        const items = rows.slice(0, query.limit),
          last = items.at(-1);
        return {
          items: items.map(dto),
          nextCursor:
            rows.length > query.limit && last
              ? encodeAdminUserCursor(
                  { id: last.id, createdAt: last.createdAt, watermark },
                  identity.principal.id,
                  query,
                  secret,
                )
              : null,
        };
      } catch (error) {
        throw safeFailure(error);
      }
    },

    async update(
      request: Request,
      userId: string,
      context: AuditRequestContext = createAuditContext(),
    ): Promise<AdminUserUpdateResult> {
      try {
        await authorize(request);
        assertCookieMutation(request, request.headers.get("x-csrf-token"));
        if (request.method !== "PATCH") throw new AdminUserInputError();
        const idempotencyKey = request.headers.get("idempotency-key");
        if (!idempotencyKey || !/^[A-Za-z0-9_.:-]{8,128}$/.test(idempotencyKey))
          throw new AdminUserInputError();
        const targetId = parseAdminUserId(userId),
          patch = await readPatch(request);
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const identity = await authorize(request);
          const command = makeAdminCommandIdentity({
            ownerUserId: identity.principal.id,
            operationId: ADMIN_USER_OPERATION,
            resourceId: targetId,
            idempotencyKey,
            payload: patch,
          });
          try {
            try {
              const user = await audited.transaction((tx) =>
                changedCommand(tx, identity, targetId, patch, command, context),
              );
              return { user, replayed: false };
            } catch (error) {
              if (error instanceof CompletedCommand)
                return { user: error.response, replayed: true };
              if (error instanceof RejectedCommand) throw error.failure;
              if (!(error instanceof UnchangedCommand)) throw error;
              return await client.$transaction(
                (tx) => unchangedCommand(tx, identity, targetId, patch, command),
                {
                  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
                  maxWait: 5_000,
                  timeout: 15_000,
                },
              );
            }
          } catch (error) {
            if (!isRetryable(error) || attempt === 3) throw error;
            await delay([25, 50, 100][attempt]);
          }
        }
        throw new AdminUsersError(503, "INTERNAL_ERROR", "操作未完成，请稍后重试");
      } catch (error) {
        throw safeFailure(error);
      }
    },

    async disconnect(): Promise<void> {
      const result = await Promise.allSettled([
        client.$disconnect(),
        audited.disconnect(),
        sessions.disconnect(),
      ]);
      if (result.some((entry) => entry.status === "rejected")) throw safeFailure(null);
    },
  });
}

let defaultService: ReturnType<typeof createAdminUsersService> | undefined;
export function adminUsersService() {
  return (defaultService ??= createAdminUsersService());
}
