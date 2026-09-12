import { exactObject } from "@/lib/admin-settings";
import { isAuditLogPage, type AuditSummary } from "@/lib/admin-logs";

export const RECORD_STATUSES = [
  "DRAFT",
  "NEEDS_INFO",
  "PLANNED",
  "MODIFIED",
  "FINALIZED",
  "NEEDS_REVALIDATION",
  "ARCHIVED",
] as const;
export type DashboardWidget<T> =
  | { status: "ok"; data: T }
  | { status: "error"; error: { code: "INTERNAL_ERROR"; requestId: string } };
export interface DashboardStats {
  widgets: {
    users: DashboardWidget<{ total: number; active: number }>;
    travelRecords: DashboardWidget<{
      total: number;
      byStatus: Record<(typeof RECORD_STATUSES)[number], number>;
    }>;
    configs: DashboardWidget<{ total: number; public: number }>;
    recentAudits: DashboardWidget<AuditSummary[]>;
  };
}
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function parseDashboardStats(value: unknown): DashboardStats {
  const outer = exactObject(value, ["widgets"]);
  const widgets = exactObject(outer.widgets, ["users", "travelRecords", "configs", "recentAudits"]);
  for (const [name, raw] of Object.entries(widgets)) {
    if (raw && typeof raw === "object" && "status" in raw && raw.status === "error") {
      const widget = exactObject(raw, ["status", "error"]);
      const error = exactObject(widget.error, ["code", "requestId"]);
      if (
        error.code !== "INTERNAL_ERROR" ||
        typeof error.requestId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(error.requestId)
      )
        throw new TypeError("Invalid widget error");
    } else {
      const widget = exactObject(raw, ["status", "data"]);
      if (widget.status !== "ok") throw new TypeError("Invalid widget status");
      if (name === "recentAudits") {
        if (
          !Array.isArray(widget.data) ||
          widget.data.length > 10 ||
          !isAuditLogPage({ items: widget.data, nextCursor: null })
        )
          throw new TypeError("Invalid audit widget");
      } else {
        const keys =
          name === "users"
            ? ["total", "active"]
            : name === "configs"
              ? ["total", "public"]
              : ["total", "byStatus"];
        const data = exactObject(widget.data, keys);
        if (!count(data.total)) throw new TypeError("Invalid widget count");
        if (name === "travelRecords") {
          const distribution = exactObject(data.byStatus, RECORD_STATUSES);
          if (
            !Object.values(distribution).every(count) ||
            Object.values(distribution).reduce<number>(
              (sum, value) => sum + (value as number),
              0,
            ) !== data.total
          )
            throw new TypeError("Invalid status counts");
        } else if (!count(data[keys[1]]) || (data[keys[1]] as number) > data.total)
          throw new TypeError("Invalid subset count");
      }
    }
  }
  return { widgets } as unknown as DashboardStats;
}
