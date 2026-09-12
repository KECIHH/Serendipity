"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, KeyRound, Plus, RefreshCw } from "lucide-react";
import { fetchAuthCsrf } from "@/components/auth/login-form";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/common/loading-state";
import {
  parseApiKeyCreate,
  parseApiKeyDto,
  parseApiKeyPatch,
  parseApiKeyRotateRequest,
  parseKeyRotationReceipt,
  type ApiKeyDto,
  type ApiKeyPage,
  type ApiKeyStatus,
} from "@/lib/admin-api-keys";

const field =
  "min-h-11 w-full rounded-md border border-input bg-surface px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60";
const time = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Shanghai",
});
const statusText: Record<ApiKeyStatus, string> = {
  ACTIVE: "已启用",
  DISABLED: "已停用",
  REVOKED: "已撤销",
};
type Editor =
  | { kind: "create" }
  | { kind: "rename" | "rotate" | "disable" | "enable" | "revoke"; key: ApiKeyDto };
const titles = {
  create: "录入密钥",
  rename: "重命名密钥",
  rotate: "轮换密钥",
  disable: "停用密钥",
  enable: "启用密钥",
  revoke: "紧急撤销密钥",
} as const;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parsePage(value: unknown): ApiKeyPage {
  if (
    !object(value) ||
    Object.keys(value).length !== 2 ||
    !Array.isArray(value.items) ||
    value.items.length > 100 ||
    !(
      value.nextCursor === null ||
      (typeof value.nextCursor === "string" && value.nextCursor.length <= 2_048)
    )
  )
    throw new Error("Invalid safe response");
  return { items: value.items.map(parseApiKeyDto), nextCursor: value.nextCursor };
}
function publicMessage(code: unknown): string {
  switch (code) {
    case "AUTH_REQUIRED":
      return "登录已过期，请重新登录。";
    case "FORBIDDEN":
      return "无法执行此操作，请检查当前权限。";
    case "VALIDATION_ERROR":
      return "请检查名称、提供方和输入内容后重试。";
    case "VERSION_CONFLICT":
      return "密钥状态已变化，请刷新后重新选择操作。";
    case "IDEMPOTENCY_KEY_REUSED":
      return "请求内容已变化，请重新选择操作。";
    case "CONFIG_ERROR":
      return "密钥验证未通过，原配置保持不变。请检查后重试。";
    case "NOT_FOUND":
      return "此密钥不可用，请刷新列表。";
    default:
      return "操作暂时未完成，请稍后重试。";
  }
}

export function ApiKeysClient() {
  const [page, setPage] = useState<ApiKeyPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [saving, setSaving] = useState(false);
  const [filters, setFilters] = useState("");
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [index, setIndex] = useState(0);
  const generation = useRef(0),
    busy = useRef(false);
  const editForm = useRef<HTMLFormElement>(null);
  // Only a digest and an idempotency identifier survive a failed request. Never retain its secret body.
  const pending = useRef<{ digest: string; key: string } | null>(null);

  const load = useCallback(async (query: string, cursor: string | null) => {
    const run = ++generation.current;
    setLoading(true);
    setPage(null);
    try {
      const params = new URLSearchParams(query);
      params.set("limit", "20");
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/admin/api-keys?${params}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const body: unknown = await response.json();
      if (run !== generation.current) return;
      if (!response.ok || !object(body) || body.success !== true) {
        setError(publicMessage(object(body) && object(body.error) ? body.error.code : null));
        return;
      }
      setPage(parsePage(body.data));
    } catch {
      if (run === generation.current) setError("密钥列表暂时无法加载，请稍后重试。");
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
  useEffect(() => {
    if (editor)
      editForm.current
        ?.querySelector<HTMLInputElement | HTMLButtonElement>("input, button")
        ?.focus();
  }, [editor]);

  function select(value: Editor) {
    pending.current = null;
    setError(null);
    setNotice(null);
    setEditor(value);
  }
  function refresh() {
    setError(null);
    setNotice(null);
    setEditor(null);
    pending.current = null;
    void load(filters, cursors[index]);
  }
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      params = new URLSearchParams();
    const provider = String(form.get("provider") ?? "").trim(),
      status = String(form.get("status") ?? "");
    if (provider) params.set("provider", provider);
    if (status) params.set("status", status);
    const query = params.toString();
    setFilters(query);
    setCursors([null]);
    setIndex(0);
    setError(null);
    setEditor(null);
    pending.current = null;
    void load(query, null);
  }
  function changePage(next: number) {
    const cursor = next > index ? (page?.nextCursor ?? null) : cursors[next];
    if (next < 0 || (next > index && !cursor)) return;
    if (next > index) setCursors([...cursors.slice(0, next), cursor]);
    setIndex(next);
    setError(null);
    setEditor(null);
    pending.current = null;
    void load(filters, cursor);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || busy.current) return;
    const current = editor,
      form = event.currentTarget;
    busy.current = true;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const data = new FormData(form);
      const path =
        current.kind === "create"
          ? "/api/admin/api-keys"
          : `/api/admin/api-keys/${encodeURIComponent(current.key.id)}${current.kind === "rotate" ? "/rotate" : ""}`;
      const method = current.kind === "create" || current.kind === "rotate" ? "POST" : "PATCH";
      const payload =
        current.kind === "create"
          ? parseApiKeyCreate({
              name: data.get("name"),
              provider: data.get("provider"),
              plainKey: data.get("plainKey"),
            })
          : current.kind === "rotate"
            ? parseApiKeyRotateRequest({
                name: data.get("name"),
                provider: current.key.provider,
                plainKey: data.get("plainKey"),
                expectedVersion: current.key.revision,
              })
            : parseApiKeyPatch({
                expectedVersion: current.key.revision,
                ...(current.kind === "rename"
                  ? { name: data.get("name") }
                  : {
                      status:
                        current.kind === "enable"
                          ? "ACTIVE"
                          : current.kind === "disable"
                            ? "DISABLED"
                            : "REVOKED",
                    }),
              });
      const secretField = form.elements.namedItem("plainKey");
      if (secretField instanceof HTMLInputElement) secretField.value = "";
      const body = JSON.stringify(payload);
      const digest = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(`${method}\n${path}\n${body}`),
          ),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      if (pending.current?.digest !== digest)
        pending.current = { digest, key: crypto.randomUUID() };
      const csrf = await fetchAuthCsrf();
      const response = await fetch(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrf,
          "Idempotency-Key": pending.current.key,
        },
        body,
      });
      const result: unknown = await response.json();
      if (!response.ok || !object(result) || result.success !== true) {
        const code = object(result) && object(result.error) ? result.error.code : null;
        setError(publicMessage(code));
        if (
          response.status === 409 ||
          response.status === 401 ||
          response.status === 403 ||
          response.status === 404
        ) {
          pending.current = null;
          setEditor(null);
          await load(filters, cursors[index]);
        }
        return;
      }
      if (current.kind === "rotate") {
        const receipt = parseKeyRotationReceipt(result.data);
        if (receipt.stage !== "ACTIVATED") {
          setNotice(
            receipt.stage === "ABORTED"
              ? "轮换已中止，原密钥未被替换。"
              : "轮换尚未完成，候选密钥保持停用。重试时请重新输入同一密钥。",
          );
          await load(filters, cursors[index]);
          return;
        }
        setNotice(`轮换完成，已切换 ${receipt.affectedConfigCount} 项配置，原密钥已撤销。`);
      } else {
        parseApiKeyDto(result.data);
        setNotice(
          current.kind === "create"
            ? "密钥已保存。后续仅显示短指纹。"
            : "密钥状态已更新。操作已记入审计日志。",
        );
      }
      pending.current = null;
      setEditor(null);
      await load(filters, cursors[index]);
    } catch {
      setError("操作未完成。录入或轮换时请重新输入密钥后重试。");
    } finally {
      const input = form.elements.namedItem("plainKey");
      if (input instanceof HTMLInputElement) input.value = "";
      busy.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">密钥管理</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            管理全局提供方密钥。保存后仅显示短指纹。
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="min-h-11"
            disabled={loading || saving}
            onClick={refresh}
          >
            <RefreshCw aria-hidden="true" />
            刷新列表
          </Button>
          <Button className="min-h-11" disabled={saving} onClick={() => select({ kind: "create" })}>
            <Plus aria-hidden="true" />
            录入密钥
          </Button>
        </div>
      </header>
      {notice ? (
        <div role="status" className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="rounded-lg border border-destructive/40 p-4 text-sm">
          <p>{error}</p>
          {error === "登录已过期，请重新登录。" ? (
            <Link href="/admin/login" className="mt-2 inline-block underline">
              重新登录
            </Link>
          ) : null}
        </div>
      ) : null}
      {editor ? (
        <section aria-labelledby="key-editor-title" className="rounded-xl border bg-surface p-5">
          <h2 id="key-editor-title" className="text-lg font-semibold">
            {titles[editor.kind]}
          </h2>
          {editor.kind !== "create" ? (
            <p className="mt-2 break-all text-sm text-muted-foreground">
              {editor.key.name} · {editor.key.keyFingerprintDisplay}
            </p>
          ) : null}
          <form
            key={editor.kind === "create" ? "create" : `${editor.kind}:${editor.key.id}`}
            ref={editForm}
            onSubmit={submit}
            aria-label={titles[editor.kind]}
            autoComplete="off"
            className="mt-4 space-y-4"
          >
            {editor.kind === "create" || editor.kind === "rotate" || editor.kind === "rename" ? (
              <label className="block max-w-xl space-y-1 text-sm">
                名称
                <input
                  name="name"
                  required
                  maxLength={200}
                  defaultValue={
                    editor.kind === "create"
                      ? ""
                      : editor.kind === "rotate"
                        ? `${editor.key.name} 新版本`
                        : editor.key.name
                  }
                  disabled={saving}
                  className={field}
                />
              </label>
            ) : null}
            {editor.kind === "create" ? (
              <label className="block max-w-xl space-y-1 text-sm">
                提供方标识
                <input
                  name="provider"
                  required
                  maxLength={128}
                  pattern="[A-Za-z0-9_-]+"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={saving}
                  className={field}
                />
              </label>
            ) : editor.kind === "rotate" ? (
              <p className="text-sm text-muted-foreground">提供方：{editor.key.provider}</p>
            ) : null}
            {editor.kind === "create" || editor.kind === "rotate" ? (
              <div className="block max-w-xl space-y-1 text-sm">
                <label htmlFor="key-plain-input">
                  {editor.kind === "rotate" ? "新密钥" : "密钥"}
                </label>
                <input
                  id="key-plain-input"
                  name="plainKey"
                  type="password"
                  required
                  maxLength={16_384}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={saving}
                  aria-describedby="key-once-help"
                  className={field}
                />
                <span id="key-once-help" className="block text-xs leading-5 text-muted-foreground">
                  仅用于本次提交。提交后输入会清空，无法读回；失败重试需重新输入。
                </span>
              </div>
            ) : null}
            {editor.kind === "revoke" ? (
              <p className="rounded-lg bg-destructive/5 p-3 text-sm">
                撤销后将立即停止使用此密钥发起新调用，且无法恢复。
              </p>
            ) : editor.kind === "disable" ? (
              <p className="text-sm text-muted-foreground">停用后暂停新调用，之后可以重新启用。</p>
            ) : editor.kind === "rotate" ? (
              <p className="text-sm text-muted-foreground">
                新密钥验证通过后统一切换相关配置，并撤销原密钥。
              </p>
            ) : null}
            <div className="flex gap-3">
              <Button
                type="submit"
                variant={editor.kind === "revoke" ? "destructive" : "default"}
                disabled={saving}
                className="min-h-11"
              >
                {saving
                  ? "正在提交…"
                  : editor.kind === "revoke"
                    ? "确认永久撤销"
                    : editor.kind === "rotate"
                      ? "验证并轮换"
                      : "确认保存"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                className="min-h-11"
                onClick={() => {
                  editForm.current?.reset();
                  setEditor(null);
                  pending.current = null;
                }}
              >
                取消
              </Button>
            </div>
          </form>
        </section>
      ) : null}
      <form
        onSubmit={search}
        aria-label="筛选密钥"
        className="flex flex-wrap items-end gap-4 rounded-xl border bg-surface p-4"
      >
        <label className="min-w-48 flex-1 space-y-1 text-sm">
          提供方
          <input name="provider" maxLength={128} className={field} />
        </label>
        <label className="min-w-40 flex-1 space-y-1 text-sm">
          状态
          <select name="status" className={field}>
            <option value="">全部状态</option>
            <option value="ACTIVE">已启用</option>
            <option value="DISABLED">已停用</option>
            <option value="REVOKED">已撤销</option>
          </select>
        </label>
        <Button type="submit" className="min-h-11" disabled={loading || saving}>
          查询密钥
        </Button>
      </form>
      {loading ? (
        <LoadingState label="正在加载密钥列表" />
      ) : page?.items.length === 0 ? (
        <div role="status" className="rounded-xl border border-dashed p-10 text-center">
          <KeyRound aria-hidden="true" className="mx-auto mb-3 size-7 text-muted-foreground" />
          <p className="text-muted-foreground">没有符合条件的密钥。</p>
        </div>
      ) : page ? (
        <div className="overflow-hidden rounded-xl border bg-surface">
          <div
            role="region"
            aria-label="密钥列表"
            tabIndex={0}
            className="overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <table className="w-full min-w-[900px] text-left text-sm">
              <caption className="sr-only">全局提供方密钥的安全摘要</caption>
              <thead className="bg-muted/50">
                <tr>
                  {["名称 / 提供方", "短指纹", "状态", "更新时间", "操作"].map((label) => (
                    <th key={label} scope="col" className="px-4 py-3 font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.items.map((item) => (
                  <tr key={item.id} className="border-t">
                    <td className="max-w-56 break-all px-4 py-4 align-top">
                      <p className="font-medium">{item.name}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{item.provider}</p>
                    </td>
                    <td className="px-4 py-4 align-top font-mono">{item.keyFingerprintDisplay}</td>
                    <td className="px-4 py-4 align-top">
                      <span
                        className={`inline-block rounded-full px-2 py-1 text-xs ${item.status === "ACTIVE" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
                      >
                        {statusText[item.status]}
                      </span>
                      {item.revokedAt ? (
                        <p className="mt-2 whitespace-nowrap text-xs text-muted-foreground">
                          {time.format(new Date(item.revokedAt))}
                        </p>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-4 align-top">
                      <time dateTime={item.updatedAt}>{time.format(new Date(item.updatedAt))}</time>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="flex max-w-80 flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="min-h-11"
                          aria-label={`重命名 ${item.name}`}
                          disabled={saving}
                          onClick={() => select({ kind: "rename", key: item })}
                        >
                          重命名
                        </Button>
                        {item.status !== "REVOKED" ? (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="min-h-11"
                              aria-label={`${item.status === "ACTIVE" ? "停用" : "启用"} ${item.name}`}
                              disabled={saving}
                              onClick={() =>
                                select({
                                  kind: item.status === "ACTIVE" ? "disable" : "enable",
                                  key: item,
                                })
                              }
                            >
                              {item.status === "ACTIVE" ? "停用" : "启用"}
                            </Button>
                            {item.status === "ACTIVE" ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="min-h-11"
                                aria-label={`轮换 ${item.name}`}
                                disabled={saving}
                                onClick={() => select({ kind: "rotate", key: item })}
                              >
                                轮换
                              </Button>
                            ) : null}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="min-h-11 text-destructive"
                              aria-label={`撤销 ${item.name}`}
                              disabled={saving}
                              onClick={() => select({ kind: "revoke", key: item })}
                            >
                              撤销
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <Button variant="outline" className="min-h-11" onClick={refresh}>
          重试加载
        </Button>
      )}
      <footer className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <p aria-live="polite">
          第 {index + 1} 页 · 本页 {page?.items.length ?? 0} 条
        </p>
        <div className="flex gap-2 text-foreground">
          <Button
            variant="outline"
            className="min-h-11 motion-reduce:transition-none"
            disabled={loading || saving || index === 0}
            onClick={() => changePage(index - 1)}
          >
            <ChevronLeft aria-hidden="true" />
            上一页
          </Button>
          <Button
            variant="outline"
            className="min-h-11 motion-reduce:transition-none"
            disabled={loading || saving || !page?.nextCursor}
            onClick={() => changePage(index + 1)}
          >
            下一页
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </footer>
    </div>
  );
}
