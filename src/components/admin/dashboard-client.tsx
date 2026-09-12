"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { DataTable } from "@/components/common/data-table";
import { PageHeader } from "@/components/common/page-header";
import { LoadingState } from "@/components/common/loading-state";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorState } from "@/components/common/error-state";
import { Button } from "@/components/ui/button";
import {
  parseDashboardStats,
  RECORD_STATUSES,
  type DashboardStats,
  type DashboardWidget,
} from "@/lib/admin-dashboard";

const statusNames = {
  DRAFT: "草稿",
  NEEDS_INFO: "待补充",
  PLANNED: "已规划",
  MODIFIED: "已修改",
  FINALIZED: "已确认",
  NEEDS_REVALIDATION: "待复核",
  ARCHIVED: "已归档",
};
function Widget<T>({
  title,
  widget,
  children,
  onRetry,
}: {
  title: string;
  widget: DashboardWidget<T>;
  children: (data: T) => ReactNode;
  onRetry: () => void;
}) {
  return (
    <section
      aria-label={title}
      className="min-w-0 space-y-4 rounded-xl border bg-surface p-4 sm:p-5"
    >
      <h2 className="text-lg font-semibold">{title}</h2>
      {widget.status === "error" ? (
        <ErrorState
          message={`此项暂时无法读取。请求编号：${widget.error.requestId}`}
          onRetry={onRetry}
        />
      ) : (
        children(widget.data)
      )}
    </section>
  );
}
export function DashboardClient() {
  const [data, setData] = useState<DashboardStats | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const generation = useRef(0);
  async function load() {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/dashboard/stats", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error("Dashboard unavailable");
      const parsed = parseDashboardStats(body.data);
      if (current === generation.current) setData(parsed);
    } catch {
      if (current === generation.current) {
        setData(null);
        setError("后台概览暂时无法读取，请重试。登录失效时请重新登录。");
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, []);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="查看账户、旅行记录、配置与最近管理操作。"
        actions={
          <Button
            variant="outline"
            className="min-h-11"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw aria-hidden="true" />
            刷新概览
          </Button>
        }
      />
      {loading ? (
        <LoadingState label="正在加载后台概览…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : data ? (
        <div className="grid min-w-0 gap-4 xl:grid-cols-2">
          <Widget title="用户" widget={data.widgets.users} onRetry={() => void load()}>
            {(users) => (
              <dl className="grid grid-cols-2 gap-3">
                <div>
                  <dt className="text-sm text-muted-foreground">用户总数</dt>
                  <dd className="mt-2 text-3xl font-semibold tabular-nums">{users.total}</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">启用账户</dt>
                  <dd className="mt-2 text-3xl font-semibold tabular-nums">{users.active}</dd>
                </div>
              </dl>
            )}
          </Widget>
          <Widget title="系统配置" widget={data.widgets.configs} onRetry={() => void load()}>
            {(configs) => (
              <dl className="grid grid-cols-2 gap-3">
                <div>
                  <dt className="text-sm text-muted-foreground">配置总数</dt>
                  <dd className="mt-2 text-3xl font-semibold tabular-nums">{configs.total}</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">标记为公开</dt>
                  <dd className="mt-2 text-3xl font-semibold tabular-nums">{configs.public}</dd>
                </div>
              </dl>
            )}
          </Widget>
          <Widget title="旅行记录" widget={data.widgets.travelRecords} onRetry={() => void load()}>
            {(records) => (
              <>
                <p className="text-sm">
                  记录总数 <strong className="ml-2 text-2xl tabular-nums">{records.total}</strong>
                </p>
                {records.total === 0 ? (
                  <EmptyState title="暂无旅行记录" />
                ) : (
                  <DataTable caption="旅行记录状态分布">
                    <thead>
                      <tr>
                        <th scope="col" className="py-2">
                          状态
                        </th>
                        <th scope="col" className="py-2 text-right">
                          数量
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {RECORD_STATUSES.map((status) => (
                        <tr key={status} className="border-t">
                          <th scope="row" className="py-2 font-normal">
                            {statusNames[status]}
                          </th>
                          <td className="py-2 text-right tabular-nums">
                            {records.byStatus[status]}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </DataTable>
                )}
              </>
            )}
          </Widget>
          <Widget title="最近审计" widget={data.widgets.recentAudits} onRetry={() => void load()}>
            {(audits) =>
              audits.length === 0 ? (
                <EmptyState title="暂无审计记录" />
              ) : (
                <div
                  role="region"
                  aria-label="最近十条审计，可横向滚动"
                  tabIndex={0}
                  className="max-w-full overflow-x-auto focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <DataTable caption="最近十条审计安全摘要" className="min-w-[480px]">
                    <thead>
                      <tr>
                        <th scope="col" className="p-2">
                          时间
                        </th>
                        <th scope="col" className="p-2">
                          操作
                        </th>
                        <th scope="col" className="p-2">
                          安全摘要
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {audits.map((audit) => (
                        <tr key={audit.id} className="border-t">
                          <td className="p-2 text-xs">
                            <time dateTime={audit.createdAt}>
                              {new Intl.DateTimeFormat("zh-CN", {
                                dateStyle: "short",
                                timeStyle: "short",
                                timeZone: "Asia/Shanghai",
                              }).format(new Date(audit.createdAt))}
                            </time>
                          </td>
                          <th scope="row" className="p-2 text-left text-xs font-normal">
                            {audit.action}
                          </th>
                          <td className="max-w-60 break-all p-2 text-xs">{audit.safeSummary}</td>
                        </tr>
                      ))}
                    </tbody>
                  </DataTable>
                </div>
              )
            }
          </Widget>
        </div>
      ) : null}
    </div>
  );
}
