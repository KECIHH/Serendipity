import "server-only";

import { PrismaClient, type Prisma } from "@prisma/client";
import {
  parseDashboardStats,
  RECORD_STATUSES,
  type DashboardStats,
  type DashboardWidget,
} from "@/lib/admin-dashboard";
import { env } from "@/lib/env";
import { AUDIT_READ_SELECT, projectAuditSummary } from "@/server/admin/logs";
import { AdminReadinessError, assertAdminReadiness } from "@/server/admin/readiness";
import { AdminSettingsError, adminSettingsFailure } from "@/server/admin/settings";
import { readAuthCookie } from "@/server/auth/cookie";
import { AuthAuthorizationError } from "@/server/auth/errors";
import { createSessionService } from "@/server/auth/session-service";

export const dashboardFailure = adminSettingsFailure;
/** Four separate read-only bounded transactions: one failed query cannot abort its siblings. */
export async function queryDashboardWidgets(
  client: PrismaClient,
  requestId: string,
): Promise<DashboardStats> {
  const bounded = <T>(query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '5000ms'`;
        return query(tx);
      },
      { maxWait: 5_000, timeout: 7_000 },
    );
  const results = await Promise.allSettled([
    bounded(async (tx) => {
      const rows = await tx.user.groupBy({ by: ["status"], _count: { _all: true } });
      return {
        total: rows.reduce((sum, row) => sum + row._count._all, 0),
        active: rows.find((row) => row.status === "ACTIVE")?._count._all ?? 0,
      };
    }),
    bounded(async (tx) => {
      const rows = await tx.travelRecord.groupBy({ by: ["status"], _count: { _all: true } });
      return {
        total: rows.reduce((sum, row) => sum + row._count._all, 0),
        byStatus: Object.fromEntries(
          RECORD_STATUSES.map((status) => [
            status,
            rows.find((row) => row.status === status)?._count._all ?? 0,
          ]),
        ) as Record<(typeof RECORD_STATUSES)[number], number>,
      };
    }),
    bounded(async (tx) => {
      const rows = await tx.systemConfig.groupBy({ by: ["isPublic"], _count: { _all: true } });
      return {
        total: rows.reduce((sum, row) => sum + row._count._all, 0),
        public: rows.find((row) => row.isPublic)?._count._all ?? 0,
      };
    }),
    bounded(async (tx) =>
      (
        await tx.auditLog.findMany({
          select: AUDIT_READ_SELECT,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 10,
        })
      ).map(projectAuditSummary),
    ),
  ]);
  const widget = <T>(result: PromiseSettledResult<T>): DashboardWidget<T> =>
    result.status === "fulfilled"
      ? { status: "ok", data: result.value }
      : { status: "error", error: { code: "INTERNAL_ERROR", requestId } };
  return parseDashboardStats({
    widgets: {
      users: widget(results[0]),
      travelRecords: widget(results[1]),
      configs: widget(results[2]),
      recentAudits: widget(results[3]),
    },
  });
}
export function createDashboardService(databaseUrl = env.DATABASE_URL) {
  const client = new PrismaClient({ datasourceUrl: databaseUrl, log: [] });
  const sessions = createSessionService({ databaseUrl });
  let resetting: Promise<void> | undefined;
  async function authorize(request: Request) {
    const claims = await readAuthCookie(request);
    if (!claims) throw new AuthAuthorizationError(401, "AUTH_REQUIRED");
    const principal = await sessions.validateSession(claims.opaqueToken, "ADMIN");
    if (principal.role !== "ADMIN" || principal.audience !== "ADMIN")
      throw new AuthAuthorizationError(403, "FORBIDDEN");
  }
  return Object.freeze({
    async stats(request: Request, requestId: string): Promise<DashboardStats> {
      await authorize(request);
      if (request.method !== "GET" || new URL(request.url).search)
        throw new AdminSettingsError(400, "VALIDATION_ERROR");
      if (resetting) await resetting;
      try {
        await assertAdminReadiness(client);
      } catch (error) {
        // PG can close every connection in the four-query pool. Discard that pool on
        // P1017; this request still fails safely, and the next request reconnects.
        if (error instanceof AdminReadinessError && error.connectionLost) {
          resetting ??= client.$disconnect().finally(() => {
            resetting = undefined;
          });
          await resetting;
        }
        throw error;
      }
      const data = await queryDashboardWidgets(client, requestId);
      await authorize(request);
      if (Object.values(data.widgets).every((widget) => widget.status === "error"))
        throw new AdminSettingsError(503, "INTERNAL_ERROR");
      return data;
    },
    async disconnect() {
      await Promise.all([client.$disconnect(), sessions.disconnect()]);
    },
  });
}
let service: ReturnType<typeof createDashboardService> | undefined;
export function dashboardService() {
  return (service ??= createDashboardService());
}
