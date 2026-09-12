"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Pencil, RefreshCw } from "lucide-react";

import { fetchAuthCsrf } from "@/components/auth/login-form";
import { PageHeader } from "@/components/common/page-header";
import { DataTable } from "@/components/common/data-table";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorState } from "@/components/common/error-state";
import { AdminPagination } from "@/components/admin/admin-pagination";
import { LoadingState } from "@/components/common/loading-state";
import { Button } from "@/components/ui/button";
import type { AdminUserDto, AdminUserPage } from "@/lib/admin-users";
import { isApiError, type ApiError, type ApiResponse } from "@/lib/api-response";

type Filters = {
  role: "" | AdminUserDto["role"];
  status: "" | AdminUserDto["status"];
  limit: number;
};

const initialFilters: Filters = { role: "", status: "", limit: 20 };
const fieldClass =
  "min-h-11 w-full rounded-md border border-input bg-surface px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50";
const cellClass = "border-b px-3 py-3 align-top text-sm";
const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Shanghai",
});

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUser(value: unknown): value is AdminUserDto {
  if (!record(value)) return false;
  const fields = [
    "id",
    "email",
    "name",
    "avatarUrl",
    "role",
    "status",
    "lastLoginAt",
    "createdAt",
    "revision",
  ];
  return (
    Object.keys(value).length === fields.length &&
    Object.keys(value).every((field) => fields.includes(field)) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.email === "string" &&
    (value.name === null || typeof value.name === "string") &&
    (value.avatarUrl === null || typeof value.avatarUrl === "string") &&
    (value.role === "USER" || value.role === "ADMIN") &&
    (value.status === "ACTIVE" || value.status === "DISABLED") &&
    (value.lastLoginAt === null ||
      (typeof value.lastLoginAt === "string" && Number.isFinite(Date.parse(value.lastLoginAt)))) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0
  );
}

function isPage(value: unknown): value is AdminUserPage {
  return (
    record(value) &&
    Object.keys(value).length === 2 &&
    Array.isArray(value.items) &&
    value.items.length <= 100 &&
    value.items.every(isUser) &&
    (value.nextCursor === null || typeof value.nextCursor === "string")
  );
}

async function responseEnvelope(response: Response): Promise<ApiResponse<unknown>> {
  const body: unknown = await response.json();
  if (
    !record(body) ||
    typeof body.requestId !== "string" ||
    (body.success !== true && body.success !== false) ||
    (body.success === false && !isApiError(body.error))
  ) {
    throw new Error("Invalid server response.");
  }
  return body as ApiResponse<unknown>;
}

function safeError(error: ApiError | undefined, saving = false): string {
  if (error?.code === "AUTH_REQUIRED") return "登录已过期，请重新登录。";
  if (error?.code === "FORBIDDEN") {
    return saving
      ? "无法执行此变更。不能修改自己的权限，且必须保留至少一位正常管理员。"
      : "当前账户没有用户管理权限。";
  }
  if (error?.code === "VALIDATION_ERROR") {
    return saving ? "请检查角色、状态与变更原因。" : "筛选条件已失效，请重新应用筛选。";
  }
  if (error?.code === "NOT_FOUND") return "用户记录已不可用，请刷新列表。";
  if (error?.code === "IDEMPOTENCY_KEY_REUSED")
    return "此操作的提交标识已被使用，请取消后重新编辑。";
  return saving ? "保存暂时不可用，请重试。" : "用户列表暂时不可用，请重试。";
}

function matches(user: AdminUserDto, filters: Filters): boolean {
  return (
    (!filters.role || user.role === filters.role) &&
    (!filters.status || user.status === filters.status)
  );
}

function roleLabel(role: AdminUserDto["role"]): string {
  return role === "ADMIN" ? "管理员" : "普通用户";
}

function statusLabel(status: AdminUserDto["status"]): string {
  return status === "ACTIVE" ? "正常" : "已禁用";
}

function dateLabel(value: string | null): string {
  return value === null ? "未知" : timeFormat.format(new Date(value));
}

export function UsersClient({ currentUserId }: Readonly<{ currentUserId: string }>) {
  const id = useId();
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(initialFilters);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [page, setPage] = useState<AdminUserPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [selected, setSelected] = useState<AdminUserDto | null>(null);
  const [role, setRole] = useState<AdminUserDto["role"]>("USER");
  const [status, setStatus] = useState<AdminUserDto["status"]>("ACTIVE");
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState<AdminUserDto | null>(null);
  const loadSequence = useRef(0);
  const submittingRef = useRef(false);
  const commandKeys = useRef(new Map<string, string>());
  const titleRef = useRef<HTMLHeadingElement>(null);
  const roleRef = useRef<HTMLSelectElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const conflictRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(false);

  const loadPage = useCallback(async (query: Filters, nextCursors: Array<string | null>) => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadError("");
    setNeedsLogin(false);
    const params = new URLSearchParams({ limit: String(query.limit) });
    if (query.role) params.set("role", query.role);
    if (query.status) params.set("status", query.status);
    const cursor = nextCursors.at(-1);
    if (cursor) params.set("cursor", cursor);
    try {
      const response = await fetch(`/api/admin/users?${params}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      const body = await responseEnvelope(response);
      if (sequence !== loadSequence.current) return;
      if (!response.ok || !body.success) {
        const error = body.success ? undefined : body.error;
        setLoadError(safeError(error));
        setNeedsLogin(error?.code === "AUTH_REQUIRED" || error?.code === "FORBIDDEN");
        return;
      }
      if (!isPage(body.data)) throw new Error("Invalid list response.");
      setPage(body.data);
      setAppliedFilters(query);
      setCursors(nextCursors);
      setConflict(null);
      setNotice("");
    } catch {
      if (sequence === loadSequence.current) setLoadError(safeError(undefined));
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPage(initialFilters, [null]);
    return () => {
      loadSequence.current += 1;
    };
  }, [loadPage]);

  useEffect(() => {
    if (conflict) {
      conflictRef.current?.focus();
    } else if (selected) {
      roleRef.current?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      if (triggerRef.current?.isConnected) triggerRef.current.focus();
      else titleRef.current?.focus();
    }
  }, [selected, conflict]);

  function beginEdit(user: AdminUserDto, trigger: HTMLButtonElement) {
    if (submittingRef.current || loading || user.id === currentUserId) return;
    triggerRef.current = trigger;
    commandKeys.current.clear();
    setSelected(user);
    setRole(user.role);
    setStatus(user.status);
    setReason("");
    setReasonError("");
    setSaveError("");
    setNotice("");
    setConflict(null);
  }

  function updateVisibleUser(user: AdminUserDto) {
    setPage((current) =>
      current
        ? {
            ...current,
            items: current.items.flatMap((item) =>
              item.id !== user.id ? [item] : matches(user, appliedFilters) ? [user] : [],
            ),
          }
        : current,
    );
  }

  function closeEditor() {
    returnFocus.current = true;
    setSelected(null);
    setSaveError("");
    setReasonError("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || submittingRef.current || selected.id === currentUserId) return;
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 1 || normalizedReason.length > 500) {
      setReasonError("请输入 1–500 字的变更原因。");
      reasonRef.current?.focus();
      return;
    }
    const command = { role, status, expectedVersion: selected.revision, reason: normalizedReason };
    const payload = JSON.stringify(command);
    let key = commandKeys.current.get(payload);
    if (!key) {
      key = crypto.randomUUID();
      commandKeys.current.set(payload, key);
    }
    submittingRef.current = true;
    setSubmitting(true);
    setSaveError("");
    setNotice("");
    try {
      const csrfToken = await fetchAuthCsrf();
      const response = await fetch(`/api/admin/users/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
          "Idempotency-Key": key,
        },
        body: payload,
      });
      const body = await responseEnvelope(response);
      if (!response.ok || !body.success) {
        if (!body.success && body.error.code === "VERSION_CONFLICT") {
          const details = body.error.details;
          if (record(details) && isUser(details.current) && details.current.id === selected.id) {
            updateVisibleUser(details.current);
            setConflict(details.current);
            setSelected(null);
            commandKeys.current.clear();
            return;
          }
          setSaveError("记录版本已变化，请取消编辑并刷新列表。");
          return;
        }
        const error = body.success ? undefined : body.error;
        setSaveError(safeError(error, true));
        setNeedsLogin(error?.code === "AUTH_REQUIRED");
        return;
      }
      if (!isUser(body.data) || body.data.id !== selected.id)
        throw new Error("Invalid update response.");
      updateVisibleUser(body.data);
      setNotice(
        body.data.revision === selected.revision
          ? "角色与状态未变化。"
          : "用户权限已更新，原有登录已失效。",
      );
      commandKeys.current.clear();
      closeEditor();
    } catch {
      setSaveError(safeError(undefined, true));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const browsingDisabled = loading || selected !== null || submitting;

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-4">
      <PageHeader
        title="用户管理"
        titleId={`${id}-title`}
        titleRef={titleRef}
        description="查看账户状态，管理用户的访问权限。"
        actions={
          <Button
            type="button"
            variant="outline"
            className="min-h-11 border-input"
            disabled={browsingDisabled}
            onClick={() => void loadPage(appliedFilters, cursors)}
          >
            <RefreshCw aria-hidden="true" />
            刷新列表
          </Button>
        }
      />

      <form
        aria-label="筛选用户"
        className="grid gap-3 border-y py-4 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_8rem_auto] xl:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          if (!browsingDisabled) void loadPage(filters, [null]);
        }}
      >
        <div className="space-y-1">
          <label htmlFor={`${id}-filter-role`} className="text-sm font-medium">
            筛选角色
          </label>
          <select
            id={`${id}-filter-role`}
            className={fieldClass}
            disabled={browsingDisabled}
            value={filters.role}
            onChange={(event) =>
              setFilters({ ...filters, role: event.target.value as Filters["role"] })
            }
          >
            <option value="">全部角色</option>
            <option value="USER">普通用户</option>
            <option value="ADMIN">管理员</option>
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-filter-status`} className="text-sm font-medium">
            筛选状态
          </label>
          <select
            id={`${id}-filter-status`}
            className={fieldClass}
            disabled={browsingDisabled}
            value={filters.status}
            onChange={(event) =>
              setFilters({ ...filters, status: event.target.value as Filters["status"] })
            }
          >
            <option value="">全部状态</option>
            <option value="ACTIVE">正常</option>
            <option value="DISABLED">已禁用</option>
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-page-limit`} className="text-sm font-medium">
            每页条数
          </label>
          <select
            id={`${id}-page-limit`}
            className={fieldClass}
            disabled={browsingDisabled}
            value={filters.limit}
            onChange={(event) => setFilters({ ...filters, limit: Number(event.target.value) })}
          >
            <option value={20}>20</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </div>
        <Button type="submit" className="min-h-11" disabled={browsingDisabled}>
          应用筛选
        </Button>
      </form>

      {notice ? (
        <p role="status" className="text-sm text-emerald-800">
          {notice}
        </p>
      ) : null}
      {conflict ? (
        <div
          ref={conflictRef}
          role="alert"
          tabIndex={-1}
          className="space-y-2 border-l-4 border-amber-700 bg-amber-50 p-4 text-sm text-amber-950"
        >
          <p className="font-medium">记录已被其他管理员更新，请根据最新信息重新选择操作。</p>
          <p>
            {conflict.email} · {roleLabel(conflict.role)} · {statusLabel(conflict.status)} · 版本{" "}
            {conflict.revision}
          </p>
          {!matches(conflict, appliedFilters) ? (
            <p>该用户已不符合当前筛选条件，请调整筛选后重新编辑。</p>
          ) : null}
        </div>
      ) : null}
      {loadError ? (
        <ErrorState message={loadError} onRetry={() => void loadPage(appliedFilters, cursors)} />
      ) : null}
      {needsLogin ? (
        <Link href="/admin/login" className="inline-flex min-h-11 items-center text-sm underline">
          重新登录
        </Link>
      ) : null}

      <div
        role="region"
        aria-label="用户列表，可横向滚动"
        tabIndex={0}
        aria-busy={loading}
        className="max-w-full overflow-x-auto border bg-surface"
      >
        <DataTable
          className="w-full min-w-[48rem] border-collapse text-left"
          caption="用户账户、权限状态和管理操作"
        >
          <thead className="sticky top-0 bg-zinc-50 text-sm">
            <tr>
              <th scope="col" className={cellClass}>
                用户
              </th>
              <th scope="col" className={cellClass}>
                角色
              </th>
              <th scope="col" className={cellClass}>
                状态
              </th>
              <th scope="col" className={cellClass}>
                注册时间
              </th>
              <th scope="col" className={cellClass}>
                最后登录
              </th>
              <th scope="col" className={`${cellClass} text-right`}>
                版本
              </th>
              <th scope="col" className={cellClass}>
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            {page?.items.map((user) => (
              <tr
                key={user.id}
                data-user-id={user.id}
                className="even:bg-zinc-50 hover:bg-zinc-100"
              >
                <th scope="row" className={`${cellClass} max-w-72 font-normal`}>
                  <p className="font-medium">{user.name ?? "未知"}</p>
                  <p className="break-all text-zinc-600">{user.email}</p>
                </th>
                <td className={cellClass}>{roleLabel(user.role)}</td>
                <td className={cellClass}>
                  <span className={user.status === "ACTIVE" ? "text-emerald-800" : "text-zinc-700"}>
                    {statusLabel(user.status)}
                  </span>
                </td>
                <td className={`${cellClass} whitespace-nowrap`}>{dateLabel(user.createdAt)}</td>
                <td className={`${cellClass} whitespace-nowrap`}>{dateLabel(user.lastLoginAt)}</td>
                <td className={`${cellClass} text-right tabular-nums`}>{user.revision}</td>
                <td className={cellClass}>
                  {user.id === currentUserId ? (
                    <span className="inline-flex min-h-11 items-center whitespace-nowrap text-zinc-600">
                      当前账户
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 border-input"
                      aria-label={`编辑 ${user.email}`}
                      disabled={browsingDisabled}
                      onClick={(event) => beginEdit(user, event.currentTarget)}
                    >
                      <Pencil aria-hidden="true" />
                      编辑
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {!page && loading ? (
              <tr>
                <td colSpan={7} className="p-6">
                  <LoadingState label="正在加载用户…" />
                </td>
              </tr>
            ) : null}
            {page?.items.length === 0 && !loadError ? (
              <tr>
                <td colSpan={7} className="p-6 text-sm text-zinc-600">
                  <EmptyState title="当前筛选下无用户。" />
                </td>
              </tr>
            ) : null}
            {!page && loadError ? (
              <tr>
                <td colSpan={7} className="p-6 text-sm text-zinc-600">
                  未能读取用户列表。
                </td>
              </tr>
            ) : null}
          </tbody>
        </DataTable>
      </div>

      <AdminPagination
        summary={
          <>
            {page ? `第 ${cursors.length} 页 · 本页 ${page.items.length} 位用户` : "尚未加载用户"}
            {loading && page ? " · 正在刷新…" : ""}
          </>
        }
        previousDisabled={browsingDisabled || cursors.length < 2}
        nextDisabled={browsingDisabled || !page?.nextCursor}
        onPrevious={() => void loadPage(appliedFilters, cursors.slice(0, -1))}
        onNext={() => {
          if (page?.nextCursor) void loadPage(appliedFilters, [...cursors, page.nextCursor]);
        }}
      />

      {selected ? (
        <form
          aria-labelledby={`${id}-edit-title`}
          aria-busy={submitting}
          onSubmit={save}
          className="space-y-4 border-t pt-5"
        >
          <div className="space-y-1">
            <h2 id={`${id}-edit-title`} className="text-xl font-semibold">
              编辑用户
            </h2>
            <p className="break-all text-sm text-zinc-600">
              {selected.email} · 当前版本 {selected.revision}
            </p>
            <p className="text-sm text-zinc-600">更改角色或状态后，该用户需要重新登录。</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor={`${id}-edit-role`} className="text-sm font-medium">
                角色
              </label>
              <select
                ref={roleRef}
                id={`${id}-edit-role`}
                className={fieldClass}
                disabled={submitting}
                value={role}
                onChange={(event) => setRole(event.target.value as AdminUserDto["role"])}
              >
                <option value="USER">普通用户</option>
                <option value="ADMIN">管理员</option>
              </select>
            </div>
            <div className="space-y-1">
              <label htmlFor={`${id}-edit-status`} className="text-sm font-medium">
                状态
              </label>
              <select
                id={`${id}-edit-status`}
                className={fieldClass}
                disabled={submitting}
                value={status}
                onChange={(event) => setStatus(event.target.value as AdminUserDto["status"])}
              >
                <option value="ACTIVE">正常</option>
                <option value="DISABLED">已禁用</option>
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <label htmlFor={`${id}-reason`} className="text-sm font-medium">
              变更原因
            </label>
            <textarea
              ref={reasonRef}
              id={`${id}-reason`}
              className={fieldClass}
              rows={3}
              required
              maxLength={500}
              disabled={submitting}
              value={reason}
              aria-invalid={Boolean(reasonError)}
              aria-describedby={`${id}-reason-help${reasonError ? ` ${id}-reason-error` : ""}`}
              onChange={(event) => {
                setReason(event.target.value);
                setReasonError("");
              }}
            />
            <p id={`${id}-reason-help`} className="text-sm text-zinc-600">
              填写必要的管理原因，请勿包含密码、令牌或私人资料。
            </p>
            {reasonError ? (
              <p id={`${id}-reason-error`} role="alert" className="text-sm text-destructive">
                {reasonError}
              </p>
            ) : null}
          </div>
          {saveError ? (
            <p role="alert" className="text-sm text-destructive">
              {saveError}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" className="min-h-11" disabled={submitting}>
              {submitting ? "正在保存…" : "保存变更"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 border-input"
              disabled={submitting}
              onClick={closeEditor}
            >
              取消编辑
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
