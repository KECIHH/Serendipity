import "server-only";

import { Prisma, PrismaClient } from "@prisma/client";
import {
  AdminLogInputError,
  parseAuditQuery,
  type AuditLogPage,
  type AuditSummary,
} from "@/lib/admin-logs";
import { fail, type ApiErrorCode } from "@/lib/api-response";
import { env } from "@/lib/env";
import { stableStringify } from "@/lib/json";
import { decodeAuditCursor, encodeAuditCursor } from "@/server/admin/log-cursor";
import { AUDIT_ACTION_TARGETS, AUDIT_LOG_ACTIONS, sanitizeAuditDetail } from "@/server/audit-log";
import { readAuthClock } from "@/server/auth/clock";
import { readAuthCookie } from "@/server/auth/cookie";
import { AuthAuthorizationError } from "@/server/auth/errors";
import { createSessionService } from "@/server/auth/session-service";

export class AdminLogsError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 503,
    readonly code: ApiErrorCode,
  ) {
    super(
      status === 400
        ? "审计查询条件无效"
        : status === 401
          ? "请先登录"
          : status === 403
            ? "没有审计读取权限"
            : "审计服务暂时不可用",
    );
    this.name = "AdminLogsError";
  }
}
function safeFailure(error: unknown): AdminLogsError {
  if (error instanceof AdminLogsError) return error;
  if (error instanceof AdminLogInputError) return new AdminLogsError(400, "VALIDATION_ERROR");
  if (error instanceof AuthAuthorizationError) return new AdminLogsError(error.status, error.code);
  return new AdminLogsError(503, "INTERNAL_ERROR");
}
export function adminLogsFailure(error: unknown, requestId: string): Response {
  const failure = safeFailure(error);
  return Response.json(fail(failure.code, failure.message, requestId), {
    status: failure.status,
    headers: { "cache-control": "no-store" },
  });
}

const AUDIT_READ_SELECT = {
  id: true,
  actorId: true,
  action: true,
  targetType: true,
  targetId: true,
  requestId: true,
  traceId: true,
  createdAt: true,
  detailJson: true,
} as const satisfies Prisma.AuditLogSelect;
type AuditRead = Prisma.AuditLogGetPayload<{ select: typeof AUDIT_READ_SELECT }>;

/** The Phase009 sanitizer owns redaction; these internal correlation digests are additionally withheld from reads. */
function outputDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(outputDetail);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [
      name,
      ["seedFingerprint", "seedRunId", "ipHash", "accountHash"].includes(name)
        ? "***"
        : outputDetail(item),
    ]),
  );
}
function dto(row: AuditRead): AuditSummary {
  if (
    !Object.hasOwn(AUDIT_LOG_ACTIONS, row.action) ||
    AUDIT_ACTION_TARGETS[row.action as keyof typeof AUDIT_ACTION_TARGETS] !== row.targetType
  )
    throw new AdminLogsError(503, "INTERNAL_ERROR");
  const detail = sanitizeAuditDetail(row.detailJson);
  const text = detail === null ? "未记录详情" : stableStringify(outputDetail(detail));
  // Actor kind is encoded by the existing systemActor marker, not by a mutable current User.role.
  const actorType = detail?.systemActor
    ? "SYSTEM"
    : row.action.startsWith("API_KEY_") ||
        ["CONFIG_UPDATE", "USER_DISABLE", "USER_UPDATE"].includes(row.action)
      ? "ADMIN"
      : "USER";
  return {
    id: row.id,
    actorType,
    actorId: row.actorId,
    targetType: row.targetType,
    targetId: row.targetId,
    action: row.action,
    requestId: row.requestId,
    traceId: row.traceId,
    createdAt: row.createdAt.toISOString(),
    safeSummary: text.length <= 4_000 ? text : "已记录有界审计详情；摘要省略，敏感内容保持 ***。",
  };
}

export interface AdminLogsServiceOptions {
  databaseUrl?: string;
  cursorSecret?: string;
  queryObserver?: (query: string) => void;
}
export function createAdminLogsService(options: AdminLogsServiceOptions = {}) {
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
  const secret = options.cursorSecret ?? env.AUTH_SECRET;
  const client = new PrismaClient({
    datasourceUrl: databaseUrl,
    log: [{ emit: "event", level: "query" }],
  });
  if (options.queryObserver) client.$on("query", (event) => options.queryObserver!(event.query));
  const sessions = createSessionService({ databaseUrl });
  async function authorize(request: Request) {
    const claims = await readAuthCookie(request);
    if (!claims) throw new AuthAuthorizationError(401, "AUTH_REQUIRED");
    const principal = await sessions.validateSession(claims.opaqueToken, "ADMIN");
    if (principal.role !== "ADMIN" || principal.audience !== "ADMIN")
      throw new AuthAuthorizationError(403, "FORBIDDEN");
    return principal;
  }
  return Object.freeze({
    async list(request: Request): Promise<AuditLogPage> {
      try {
        const principal = await authorize(request);
        if (request.method !== "GET") throw new AdminLogInputError();
        const query = parseAuditQuery(new URL(request.url).searchParams);
        if (query.action && !Object.hasOwn(AUDIT_LOG_ACTIONS, query.action))
          throw new AdminLogInputError();
        if (
          query.targetType &&
          !Object.values(AUDIT_ACTION_TARGETS).some((target) => target === query.targetType)
        )
          throw new AdminLogInputError();
        const cursor = query.cursor
          ? decodeAuditCursor(query.cursor, principal.id, query, secret)
          : null;
        const watermark = cursor?.watermark ?? (await readAuthClock(client));
        const rows = await client.auditLog.findMany({
          where: {
            ...(query.actorId ? { actorId: query.actorId } : {}),
            ...(query.action ? { action: query.action } : {}),
            ...(query.targetType ? { targetType: query.targetType } : {}),
            ...(query.targetId ? { targetId: query.targetId } : {}),
            AND: [
              { createdAt: { lte: watermark } },
              ...(query.from ? [{ createdAt: { gte: new Date(query.from) } }] : []),
              ...(query.to ? [{ createdAt: { lte: new Date(query.to) } }] : []),
              ...(cursor
                ? [
                    {
                      OR: [
                        { createdAt: { lt: cursor.createdAt } },
                        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                      ],
                    },
                  ]
                : []),
            ],
          },
          select: AUDIT_READ_SELECT,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: query.limit + 1,
        });
        await authorize(request);
        const items = rows.slice(0, query.limit),
          last = items.at(-1);
        return {
          items: items.map(dto),
          nextCursor:
            rows.length > query.limit && last
              ? encodeAuditCursor(
                  { id: last.id, createdAt: last.createdAt, watermark },
                  principal.id,
                  query,
                  secret,
                )
              : null,
        };
      } catch (error) {
        throw safeFailure(error);
      }
    },
    async disconnect() {
      const results = await Promise.allSettled([client.$disconnect(), sessions.disconnect()]);
      if (results.some((result) => result.status === "rejected")) throw safeFailure(null);
    },
  });
}
let service: ReturnType<typeof createAdminLogsService> | undefined;
export function adminLogsService() {
  return (service ??= createAdminLogsService());
}
