"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/common/page-header";
import { DataTable } from "@/components/common/data-table";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorState } from "@/components/common/error-state";
import { AdminPagination } from "@/components/admin/admin-pagination";
import { LoadingState } from "@/components/common/loading-state";
import { isAuditLogPage, type AuditLogPage } from "@/lib/admin-logs";

const field =
  "min-h-11 w-full rounded-md border border-input bg-surface px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50";
const time = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "short",
  timeStyle: "medium",
  timeZone: "Asia/Shanghai",
});

export function LogsClient() {
  const [page, setPage] = useState<AuditLogPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [filters, setFilters] = useState("");
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [index, setIndex] = useState(0);
  const generation = useRef(0);
  const filterForm = useRef<HTMLFormElement>(null);

  const load = useCallback(async (query: string, cursor: string | null) => {
    const run = ++generation.current;
    setLoading(true);
    setError(null);
    setAuthRequired(false);
    setPage(null);
    try {
      const params = new URLSearchParams(query);
      params.set("limit", "20");
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/admin/logs?${params}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const body: unknown = await response.json();
      if (run !== generation.current) return;
      if (response.status === 401 || response.status === 403) {
        setAuthRequired(true);
        throw new Error(
          response.status === 401 ? "登录已过期，请重新登录。" : "当前账号无法读取审计日志。",
        );
      }
      if (
        !response.ok ||
        !body ||
        typeof body !== "object" ||
        !("success" in body) ||
        body.success !== true ||
        !("data" in body) ||
        !isAuditLogPage(body.data)
      ) {
        throw new Error(
          response.status === 400
            ? "筛选条件或分页已失效，请调整条件后重新查询。"
            : "审计日志暂时无法加载，请稍后重试。",
        );
      }
      setPage(body.data);
    } catch (failure) {
      if (run === generation.current) {
        const message =
          failure instanceof Error &&
          [
            "登录已过期，请重新登录。",
            "当前账号无法读取审计日志。",
            "筛选条件或分页已失效，请调整条件后重新查询。",
          ].includes(failure.message)
            ? failure.message
            : "审计日志暂时无法加载，请稍后重试。";
        setError(message);
      }
    } finally {
      if (run === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const counter = generation;
    void load("", null);
    return () => {
      counter.current++;
    };
  }, [load]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget),
      params = new URLSearchParams();
    try {
      for (const name of ["actorId", "action", "targetType", "targetId", "from", "to"]) {
        const raw = String(data.get(name) ?? "").trim();
        if (raw)
          params.set(name, name === "from" || name === "to" ? new Date(raw).toISOString() : raw);
      }
      const value = params.toString();
      setFilters(value);
      setCursors([null]);
      setIndex(0);
      void load(value, null);
    } catch {
      setError("筛选条件或分页已失效，请调整条件后重新查询。");
    }
  }
  function changePage(next: number) {
    const cursor = next > index ? (page?.nextCursor ?? null) : cursors[next];
    if (next < 0 || (next > index && !cursor)) return;
    if (next > index) setCursors([...cursors.slice(0, next), cursor]);
    setIndex(next);
    void load(filters, cursor);
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="审计日志"
        description="查看管理操作与安全结果。敏感内容已脱敏。"
        actions={
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={loading}
            onClick={() => void load(filters, cursors[index])}
          >
            <RefreshCw aria-hidden="true" />
            刷新日志
          </Button>
        }
      />
      <form
        ref={filterForm}
        onSubmit={search}
        aria-label="筛选审计日志"
        className="rounded-xl border bg-surface p-4"
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <label className="space-y-1 text-sm">
            操作
            <input
              name="action"
              maxLength={64}
              placeholder="例如 API_KEY_ROTATE"
              className={field}
            />
          </label>
          <label className="space-y-1 text-sm">
            目标类型
            <select name="targetType" className={field}>
              <option value="">全部类型</option>
              <option value="ApiKeyConfig">密钥</option>
              <option value="User">用户</option>
              <option value="SystemConfig">系统配置</option>
              <option value="AuthSession">会话</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            操作者 ID
            <input name="actorId" maxLength={128} className={field} />
          </label>
          <label className="space-y-1 text-sm">
            目标 ID
            <input name="targetId" maxLength={128} className={field} />
          </label>
          <label className="space-y-1 text-sm">
            开始时间
            <input name="from" type="datetime-local" className={field} />
          </label>
          <label className="space-y-1 text-sm">
            结束时间
            <input name="to" type="datetime-local" className={field} />
          </label>
        </div>
        <div className="mt-4 flex gap-3">
          <Button type="submit" className="min-h-11" disabled={loading}>
            查询日志
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={loading}
            onClick={() => {
              filterForm.current?.reset();
              setFilters("");
              setCursors([null]);
              setIndex(0);
              void load("", null);
            }}
          >
            重置筛选
          </Button>
        </div>
      </form>
      {loading ? (
        <LoadingState label="正在加载审计日志" />
      ) : error ? (
        <div className="rounded-xl border p-5">
          <ErrorState message={error} />
          {authRequired ? (
            <Link className="mt-3 inline-block underline" href="/admin/login">
              重新登录
            </Link>
          ) : (
            <Button
              variant="outline"
              className="mt-3 min-h-11"
              onClick={() => void load(filters, cursors[index])}
            >
              重试
            </Button>
          )}
        </div>
      ) : page?.items.length === 0 ? (
        <EmptyState title="没有符合条件的审计日志。" />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-surface">
          <div
            role="region"
            aria-label="审计日志列表"
            tabIndex={0}
            className="overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <DataTable className="w-full min-w-[820px] text-left text-sm" caption="只读审计记录">
              <thead className="bg-muted/50">
                <tr>
                  {["时间", "操作者", "操作", "目标", "安全摘要"].map((label) => (
                    <th key={label} scope="col" className="px-4 py-3 font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page?.items.map((item) => (
                  <tr key={item.id} className="border-t">
                    <td className="whitespace-nowrap px-4 py-4 align-top">
                      <time dateTime={item.createdAt}>{time.format(new Date(item.createdAt))}</time>
                    </td>
                    <td className="max-w-44 break-all px-4 py-4 align-top">
                      {item.actorType === "SYSTEM"
                        ? "系统"
                        : item.actorType === "ADMIN"
                          ? "管理员"
                          : "用户"}
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {item.actorId ?? "系统操作"}
                      </span>
                    </td>
                    <td className="px-4 py-4 align-top font-mono text-xs">{item.action}</td>
                    <td className="max-w-44 break-all px-4 py-4 align-top">
                      {item.targetType}
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {item.targetId ?? "—"}
                      </span>
                    </td>
                    <td className="max-w-md break-all px-4 py-4 align-top">
                      <pre className="whitespace-pre-wrap font-sans text-xs leading-6">
                        {item.safeSummary}
                      </pre>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        </div>
      )}
      <AdminPagination
        summary={page ? `第 ${index + 1} 页 · 本页 ${page.items.length} 条` : "尚未加载列表"}
        previousDisabled={loading || index === 0}
        nextDisabled={loading || !page?.nextCursor}
        onPrevious={() => changePage(index - 1)}
        onNext={() => changePage(index + 1)}
      />
    </div>
  );
}
