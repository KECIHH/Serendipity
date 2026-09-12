"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { RefreshCw } from "lucide-react";
import { DataTable } from "@/components/common/data-table";
import { PageHeader } from "@/components/common/page-header";
import { LoadingState } from "@/components/common/loading-state";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorState } from "@/components/common/error-state";
import { Button } from "@/components/ui/button";
import { fetchAuthCsrf } from "@/components/auth/login-form";
import {
  parseAdminSetting,
  parseAdminSettings,
  type AdminSetting,
  type AdminSettings,
} from "@/lib/admin-settings";
import { SYSTEM_CONFIG_GROUPS } from "@/lib/schemas/system-config";

const labels = { GENERAL: "常规", UI: "界面", SECURITY: "安全", EXPORT: "导出", AI: "AI 运行护栏" };
const fieldClass =
  "min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
export function SettingsClient() {
  const id = useId(),
    titleRef = useRef<HTMLHeadingElement>(null),
    editorRef = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null),
    busy = useRef(false),
    commandKeys = useRef(new Map<string, string>());
  const [data, setData] = useState<AdminSettings | null>(null),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState("");
  const [group, setGroup] = useState(""),
    [selected, setSelected] = useState<AdminSetting | null>(null),
    [text, setText] = useState("");
  const [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState(""),
    [notice, setNotice] = useState("");
  const fetchId = useRef(0),
    restoreFocus = useRef(false);
  async function load() {
    const run = ++fetchId.current;
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch("/api/admin/settings", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error("Unable to read settings");
      const next = parseAdminSettings(body.data);
      if (run === fetchId.current) setData(next);
    } catch {
      if (run === fetchId.current) {
        setData(null);
        setLoadError("系统配置暂时无法读取，请重试。登录失效时请重新登录。");
      }
    } finally {
      if (run === fetchId.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      fetchId.current += 1;
    };
  }, []);
  useEffect(() => {
    if (selected) editorRef.current?.focus();
  }, [selected]);
  useEffect(() => {
    if (!restoreFocus.current || selected || saving || loading) return;
    restoreFocus.current = false;
    if (trigger.current?.isConnected && !trigger.current.disabled) trigger.current.focus();
    else titleRef.current?.focus();
  }, [selected, saving, loading]);
  function close() {
    restoreFocus.current = true;
    setSelected(null);
    setSaveError("");
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || busy.current) return;
    let valueJson: unknown;
    try {
      valueJson = JSON.parse(text);
    } catch {
      setSaveError("请输入有效 JSON；文本值需要双引号。");
      editorRef.current?.focus();
      return;
    }
    const payload = JSON.stringify({ valueJson, expectedVersion: selected.revision });
    const identity = `${selected.key}:${payload}`;
    let key = commandKeys.current.get(identity);
    if (!key) {
      key = crypto.randomUUID();
      commandKeys.current.set(identity, key);
    }
    busy.current = true;
    setSaving(true);
    setSaveError("");
    setNotice("");
    try {
      const csrf = await fetchAuthCsrf();
      const response = await fetch(`/api/admin/settings/${encodeURIComponent(selected.key)}`, {
        method: "PATCH",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrf,
          "Idempotency-Key": key,
        },
        body: payload,
      });
      const body = await response.json();
      if (!response.ok || !body.success) {
        if (body.error?.code === "VERSION_CONFLICT") {
          close();
          commandKeys.current.clear();
          setNotice("配置已被其他操作更新，已刷新列表。请核对后重新编辑。");
          await load();
        } else
          setSaveError(
            body.error?.code === "VALIDATION_ERROR"
              ? "配置值不符合要求，请检查字段、数值范围与部署上限。"
              : "保存未完成，请重试；登录失效时请重新登录。",
          );
        return;
      }
      const setting = parseAdminSetting(body.data);
      if (setting.key !== selected.key) throw new Error("Invalid setting response");
      setData((current) =>
        current
          ? { items: current.items.map((item) => (item.key === setting.key ? setting : item)) }
          : current,
      );
      close();
      commandKeys.current.clear();
      setNotice("配置已保存，变更已记录。");
    } catch {
      setSaveError("保存结果暂时无法确认，请重试同一内容。");
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  const items = data?.items.filter((item) => !group || item.group === group) ?? [];
  return (
    <section aria-labelledby={`${id}-title`} className="space-y-5">
      <PageHeader
        title="系统配置"
        titleId={`${id}-title`}
        titleRef={titleRef}
        description="管理已登记的运行配置。保存前请核对当前版本。"
        actions={
          <Button
            variant="outline"
            className="min-h-11"
            disabled={loading || saving || !!selected}
            onClick={() => void load()}
          >
            <RefreshCw aria-hidden="true" />
            刷新配置
          </Button>
        }
      />
      <div className="max-w-sm space-y-1">
        <label htmlFor={`${id}-group`}>配置分组</label>
        <select
          id={`${id}-group`}
          className={fieldClass}
          value={group}
          disabled={saving || !!selected}
          onChange={(event) => setGroup(event.target.value)}
        >
          <option value="">全部分组</option>
          {SYSTEM_CONFIG_GROUPS.map((key) => (
            <option key={key} value={key}>
              {labels[key]}
            </option>
          ))}
        </select>
      </div>
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      {selected ? (
        <form
          onSubmit={save}
          aria-label="编辑系统配置"
          className="space-y-3 rounded-lg border bg-surface p-4"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy.current) close();
          }}
        >
          <h2 className="break-all font-semibold">{selected.description}</h2>
          <p className="break-all text-sm text-muted-foreground">
            {selected.key} · 版本 {selected.revision}
          </p>
          <label htmlFor={`${id}-value`} className="block text-sm">
            配置值（JSON）
          </label>
          <textarea
            id={`${id}-value`}
            ref={editorRef}
            className={`${fieldClass} min-h-36 font-mono`}
            value={text}
            maxLength={8192}
            disabled={saving}
            onChange={(event) => setText(event.target.value)}
            aria-describedby={`${id}-hint`}
          />
          <p id={`${id}-hint`} className="text-sm text-muted-foreground">
            保留原有字段；数字、布尔值与文本的类型应与当前值一致。
          </p>
          {saveError ? <ErrorState message={saveError} /> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="min-h-11" disabled={saving}>
              {saving ? "正在保存…" : "保存配置"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={saving}
              onClick={close}
            >
              取消
            </Button>
          </div>
        </form>
      ) : null}
      {loading ? (
        <LoadingState label="正在加载配置…" />
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={() => void load()} />
      ) : items.length === 0 ? (
        <EmptyState title="此分组暂无配置" description="已登记并保存的配置会显示在这里。" />
      ) : (
        <div
          role="region"
          aria-label="系统配置列表，可横向滚动"
          tabIndex={0}
          className="max-w-full overflow-x-auto rounded-lg border bg-surface focus-visible:ring-2 focus-visible:ring-ring"
        >
          <DataTable caption="配置值、分组、可见性和版本" className="min-w-[760px]">
            <thead className="bg-muted/50">
              <tr>
                {["配置", "当前值", "分组", "可见性", "版本", "操作"].map((label) => (
                  <th key={label} scope="col" className="p-3">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.key} className="border-t">
                  <th scope="row" className="max-w-64 break-all p-3 font-normal">
                    <p className="font-medium">{item.description}</p>
                    <p className="text-xs text-muted-foreground">{item.key}</p>
                  </th>
                  <td className="max-w-80 p-3">
                    <pre className="whitespace-pre-wrap break-all text-xs">
                      {JSON.stringify(item.valueJson, null, 2)}
                    </pre>
                  </td>
                  <td className="p-3">{labels[item.group]}</td>
                  <td className="p-3">{item.isPublic ? "允许公开投影" : "私有"}</td>
                  <td className="p-3 tabular-nums">{item.revision}</td>
                  <td className="p-3">
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={!!selected || saving}
                      aria-label={`编辑 ${item.description}`}
                      onClick={(event) => {
                        trigger.current = event.currentTarget;
                        setSelected(item);
                        setText(JSON.stringify(item.valueJson, null, 2));
                        setSaveError("");
                        setNotice("");
                        commandKeys.current.clear();
                      }}
                    >
                      编辑
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </div>
      )}
    </section>
  );
}
