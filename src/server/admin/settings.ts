import "server-only";

import { setTimeout as delay } from "node:timers/promises";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  parseAdminSetting,
  parseSettingPatch,
  SettingInputError,
  type AdminSetting,
  type AdminSettings,
} from "@/lib/admin-settings";
import { fail, type ApiErrorCode } from "@/lib/api-response";
import { env } from "@/lib/env";
import {
  ADMIN_RECEIPT_MIN_RETENTION_MS,
  AdminCommandError,
  findAdminCommandReceipt,
  makeAdminCommandIdentity,
} from "@/server/admin/command-receipt";
import { AdminReadinessError, assertAdminReadiness } from "@/server/admin/readiness";
import { AuditLogError, createAuditContext, type AuditRequestContext } from "@/server/audit-log";
import { readAuthClock } from "@/server/auth/clock";
import { assertCookieMutation, CookieRequestError, readAuthCookie } from "@/server/auth/cookie";
import { AuthAuthorizationError } from "@/server/auth/errors";
import { createSessionService, hashSessionToken } from "@/server/auth/session-service";
import { configDefinition, CONFIG_REGISTRY, parseConfig } from "@/server/config/config-registry";
import { canonicalConfigHash, configCaps } from "@/server/config/config-service";
import {
  AuditTransactionConflictError,
  openAuditedAdminDatabase,
  writeAuditLog,
} from "@/server/services/audit-log-service";

export class AdminSettingsError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 503,
    readonly code: ApiErrorCode,
    readonly details?: unknown,
  ) {
    super(
      status === 400
        ? "配置内容无效，请检查数值、字段与部署上限"
        : status === 401
          ? "请先登录"
          : status === 403
            ? "没有系统配置权限"
            : status === 404
              ? "未找到此配置"
              : code === "VERSION_CONFLICT"
                ? "配置已被更新，请刷新后重新编辑"
                : status === 409
                  ? "请求标识已用于其他内容"
                  : "配置服务暂时不可用",
    );
    this.name = "AdminSettingsError";
  }
}
function safeFailure(error: unknown): AdminSettingsError {
  if (error instanceof AdminSettingsError) return error;
  if (error instanceof AuthAuthorizationError)
    return new AdminSettingsError(error.status, error.code);
  if (error instanceof CookieRequestError) return new AdminSettingsError(403, "FORBIDDEN");
  if (
    error instanceof SettingInputError ||
    (error instanceof AdminCommandError && error.kind === "VALIDATION_ERROR")
  )
    return new AdminSettingsError(400, "VALIDATION_ERROR");
  if (error instanceof AdminCommandError && error.kind === "IDEMPOTENCY_KEY_REUSED")
    return new AdminSettingsError(409, "IDEMPOTENCY_KEY_REUSED");
  return new AdminSettingsError(
    503,
    error instanceof AdminReadinessError ? "CONFIG_ERROR" : "INTERNAL_ERROR",
  );
}
export function adminSettingsFailure(error: unknown, requestId: string): Response {
  const failure = safeFailure(error);
  return Response.json(fail(failure.code, failure.message, requestId, failure.details), {
    status: failure.status,
    headers: { "cache-control": "no-store" },
  });
}
const select = {
  id: true,
  key: true,
  valueJson: true,
  description: true,
  group: true,
  isPublic: true,
  revision: true,
  updatedAt: true,
} as const satisfies Prisma.SystemConfigSelect;
type SettingRow = Prisma.SystemConfigGetPayload<{ select: typeof select }>;
function dto(row: SettingRow): AdminSetting {
  try {
    const entry = configDefinition(row.key);
    if (entry.group !== row.group) throw new SettingInputError();
    return parseAdminSetting({
      key: row.key,
      valueJson: parseConfig(row.key, row.valueJson, configCaps()),
      description: row.description,
      group: row.group,
      isPublic: row.isPublic,
      revision: row.revision,
      updatedAt: row.updatedAt.toISOString(),
    });
  } catch {
    throw new AdminSettingsError(503, "CONFIG_ERROR");
  }
}
class CompletedCommand extends AuditLogError {
  constructor(readonly setting: AdminSetting) {
    super("VALIDATION_ERROR");
  }
}
class RejectedCommand extends AuditLogError {
  constructor(readonly failure: AdminSettingsError) {
    super("VALIDATION_ERROR");
  }
}
async function readPatch(request: Request) {
  const length = request.headers.get("content-length");
  if (
    request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
      "application/json" ||
    !request.body ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > 12_288))
  )
    throw new SettingInputError();
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 12_288) {
        await reader.cancel();
        throw new SettingInputError();
      }
      chunks.push(value);
    }
    return parseSettingPatch(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))),
    );
  } catch {
    throw new SettingInputError();
  } finally {
    reader.releaseLock();
  }
}
export function createAdminSettingsService(options: { databaseUrl?: string } = {}) {
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
  const client = new PrismaClient({ datasourceUrl: databaseUrl, log: [] });
  const sessions = createSessionService({ databaseUrl });
  const audited = openAuditedAdminDatabase(databaseUrl);
  async function authorize(request: Request) {
    const claims = await readAuthCookie(request);
    if (!claims) throw new AuthAuthorizationError(401, "AUTH_REQUIRED");
    const principal = await sessions.validateSession(claims.opaqueToken, "ADMIN");
    // SETTINGS_ADMIN_AUTHORIZATION: independently guard the service boundary.
    if (principal.role !== "ADMIN" || principal.audience !== "ADMIN")
      throw new AuthAuthorizationError(403, "FORBIDDEN");
    const tokenHash = hashSessionToken(claims.opaqueToken);
    if (!tokenHash) throw new AuthAuthorizationError(401, "AUTH_REQUIRED");
    return { principal, tokenHash };
  }
  return Object.freeze({
    async list(request: Request): Promise<AdminSettings> {
      try {
        await authorize(request);
        if (request.method !== "GET" || new URL(request.url).search) throw new SettingInputError();
        await assertAdminReadiness(client);
        const rows = await client.systemConfig.findMany({
          select,
          orderBy: [{ group: "asc" }, { key: "asc" }],
          take: CONFIG_REGISTRY.length + 1,
        });
        if (rows.length > CONFIG_REGISTRY.length) throw new AdminSettingsError(503, "CONFIG_ERROR");
        const items = rows.map(dto);
        await authorize(request);
        return { items };
      } catch (error) {
        throw safeFailure(error);
      }
    },
    async update(
      request: Request,
      key: string,
      context: AuditRequestContext = createAuditContext(),
    ): Promise<{ setting: AdminSetting; replayed: boolean }> {
      try {
        await authorize(request);
        assertCookieMutation(request, request.headers.get("x-csrf-token"));
        if (request.method !== "PATCH") throw new SettingInputError();
        configDefinition(key);
        const input = await readPatch(request);
        const patch = { ...input, valueJson: parseConfig(key, input.valueJson, configCaps()) };
        const idempotencyKey = request.headers.get("idempotency-key");
        if (!idempotencyKey || !/^[A-Za-z0-9_.:-]{8,128}$/.test(idempotencyKey))
          throw new SettingInputError();
        await assertAdminReadiness(client);
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const identity = await authorize(request);
          const command = makeAdminCommandIdentity({
            ownerUserId: identity.principal.id,
            operationId: "patch.admin.settings.key",
            resourceId: key,
            idempotencyKey,
            payload: patch,
          });
          try {
            const setting = await audited.transaction(async (tx) => {
              try {
                // Match the user/key lock order, so revocation and configuration writes serialize.
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('serendipity:admin-users:v1', 0::bigint))`;
                await tx.$queryRaw`SELECT id FROM "User" WHERE id=${identity.principal.id} FOR UPDATE`;
                const actors = await tx.$queryRaw<Array<{ id: string; email: string }>>`
                  SELECT u.id,u.email FROM "User" u JOIN "AuthSession" s ON s."userId"=u.id
                  WHERE u.id=${identity.principal.id} AND s."tokenHash"=${identity.tokenHash}
                  AND u.role='ADMIN' AND u.status='ACTIVE' AND s.audience='ADMIN'
                  AND s.status='ACTIVE' AND s."expiresAt">public.auth_now()
                  AND s."sessionVersion"=u."sessionVersion" FOR UPDATE OF s
                `;
                if (actors.length !== 1) throw new AdminSettingsError(401, "AUTH_REQUIRED");
                const receipt = await findAdminCommandReceipt(tx, command);
                if (receipt) {
                  if (receipt.status !== "SUCCEEDED")
                    throw new AdminSettingsError(409, "VERSION_CONFLICT");
                  const original = parseAdminSetting(receipt.responseJson);
                  if (original.key !== key) throw new AdminSettingsError(503, "CONFIG_ERROR");
                  throw new CompletedCommand(original);
                }
                const target = await tx.systemConfig.findUnique({ where: { key }, select });
                if (!target) throw new AdminSettingsError(404, "NOT_FOUND");
                const before = dto(target);
                // SETTINGS_REVISION_CAS: timestamp equality never authorizes a stale update.
                if (target.revision !== patch.expectedVersion)
                  throw new AdminSettingsError(409, "VERSION_CONFLICT", {
                    currentVersion: before.revision,
                    action: "RELOAD",
                    current: before,
                  });
                const updated = await tx.systemConfig.updateMany({
                  where: { id: target.id, revision: patch.expectedVersion },
                  data: {
                    valueJson: patch.valueJson === null ? Prisma.JsonNull : patch.valueJson,
                    revision: { increment: 1 },
                    updatedBy: actors[0].id,
                    updatedAt: await readAuthClock(tx),
                  },
                });
                if (updated.count !== 1) throw new AdminSettingsError(409, "VERSION_CONFLICT");
                const response = dto(
                  await tx.systemConfig.findUniqueOrThrow({ where: { id: target.id }, select }),
                );
                // SETTINGS_ATOMIC_AUDIT: hashes, revisions and field names only, never configuration text.
                await writeAuditLog(tx, {
                  actor: { kind: "USER", id: actors[0].id, emailSnapshot: actors[0].email },
                  action: "CONFIG_UPDATE",
                  targetType: "SystemConfig",
                  targetId: target.id,
                  context,
                  detailJson: {
                    before: {
                      revision: before.revision,
                      valueHash: canonicalConfigHash(before.valueJson),
                    },
                    after: {
                      revision: response.revision,
                      valueHash: canonicalConfigHash(response.valueJson),
                    },
                    changedFields: ["valueJson", "revision"],
                    result: "SUCCESS",
                    reasonCode: "CONFIG_CHANGED",
                  },
                });
                const now = await readAuthClock(tx);
                await tx.adminCommandReceipt.create({
                  data: {
                    ...command,
                    status: "SUCCEEDED",
                    responseJson: { ...response },
                    createdAt: now,
                    availableAt: now,
                    completedAt: now,
                    expiresAt: new Date(now.getTime() + ADMIN_RECEIPT_MIN_RETENTION_MS),
                  },
                });
                return response;
              } catch (error) {
                if (error instanceof CompletedCommand) throw error;
                if (
                  error instanceof AdminSettingsError ||
                  error instanceof SettingInputError ||
                  error instanceof AdminCommandError
                )
                  throw new RejectedCommand(safeFailure(error));
                throw error;
              }
            });
            return { setting, replayed: false };
          } catch (error) {
            if (error instanceof CompletedCommand)
              return { setting: error.setting, replayed: true };
            if (error instanceof RejectedCommand) throw error.failure;
            const retry =
              error instanceof AuditTransactionConflictError ||
              (error instanceof Prisma.PrismaClientKnownRequestError &&
                ["P2034", "P2002"].includes(error.code));
            if (!retry || attempt === 3) throw error;
            await delay([25, 50, 100][attempt]);
          }
        }
        throw new AdminSettingsError(503, "INTERNAL_ERROR");
      } catch (error) {
        throw safeFailure(error);
      }
    },
    async disconnect() {
      await Promise.all([client.$disconnect(), sessions.disconnect(), audited.disconnect()]);
    },
  });
}
let service: ReturnType<typeof createAdminSettingsService> | undefined;
export function adminSettingsService() {
  return (service ??= createAdminSettingsService());
}
