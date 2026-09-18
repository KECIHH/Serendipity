"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAuthCsrf } from "@/components/auth/login-form";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorState } from "@/components/common/error-state";
import {
  AI_DEBUG_FAILURE_PROFILES,
  AI_DEBUG_PROMPT_KEYS,
  parseAiDebugReceipt,
  parseAiDebugStatus,
  type AiDebugFailureProfile,
  type AiDebugStatusDto,
} from "@/lib/ai-debug";

const field =
  "min-h-11 w-full rounded-md border border-input bg-surface px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60";
const statusText: Record<AiDebugStatusDto["status"], string> = {
  PENDING: "等待执行",
  RUNNING: "执行中",
  SUCCEEDED: "成功",
  FAILED: "失败",
  CANCELLED: "已取消",
};
const profileText: Record<AiDebugFailureProfile, string> = {
  success: "成功（固定 fixture）",
  timeout: "超时",
  rate_limit: "限流",
  server_error: "服务端错误",
  network_error: "网络错误",
  invalid_json: "非法 JSON",
  schema_mismatch: "Schema 不匹配",
  cancel: "取消",
  cost: "成本/预算边界",
  repair: "语法修复",
};

interface ApiEnvelope {
  success: boolean;
  data?: unknown;
  error?: { code?: unknown; message?: unknown };
}
function envelope(value: unknown): ApiEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { success: false };
  return value as ApiEnvelope;
}
function message(envelopeValue: ApiEnvelope): string {
  const code = envelopeValue.error?.code;
  return typeof code === "string" ? code : "请求失败";
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function AiDebugClient() {
  const [promptKey, setPromptKey] = useState<string>(AI_DEBUG_PROMPT_KEYS[0] ?? "");
  const [failureProfile, setFailureProfile] = useState<AiDebugFailureProfile>("success");
  const [variables, setVariables] = useState<string>(
    '{"userText":"这周末从深圳去武功山","stage":"CORE"}',
  );
  const [runs, setRuns] = useState<AiDebugStatusDto[]>([]);
  const [deltas, setDeltas] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadRun = useCallback(async (debugRunId: string): Promise<AiDebugStatusDto | null> => {
    const response = await fetch(`/api/admin/ai-debug/runs/${encodeURIComponent(debugRunId)}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    const body = envelope(await response.json().catch(() => null));
    if (!response.ok || !body.success) return null;
    try {
      return parseAiDebugStatus(body.data);
    } catch {
      return null;
    }
  }, []);

  const record = useCallback((status: AiDebugStatusDto) => {
    setRuns((current) =>
      [status, ...current.filter((row) => row.debugRunId !== status.debugRunId)].slice(0, 8),
    );
  }, []);

  const poll = useCallback(
    async (debugRunId: string) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const status = await loadRun(debugRunId);
        if (!mounted.current) return;
        if (status) {
          record(status);
          if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(status.status)) return;
        }
        await sleep(250);
      }
    },
    [loadRun, record],
  );

  async function submit(mode: "test" | "stream") {
    if (busy) return;
    setBusy(true);
    setError(null);
    setDeltas("");
    try {
      let parsedVariables: unknown;
      try {
        parsedVariables = JSON.parse(variables);
      } catch {
        throw new Error("变量必须是合法 JSON 对象");
      }
      const csrfToken = await fetchAuthCsrf();
      const response = await fetch(`/api/admin/ai-debug/${mode}`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({ promptKey, variables: parsedVariables, failureProfile }),
      });
      if (mode === "stream" && response.ok) {
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let debugRunId: string | null = null;
        while (reader) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const event = /^event: (.+)$/m.exec(frame)?.[1];
            const raw = /^data: (.+)$/m.exec(frame)?.[1];
            if (!event || !raw) continue;
            const payload: unknown = JSON.parse(raw);
            if (event === "accepted") {
              debugRunId = parseAiDebugReceipt(payload).debugRunId;
            } else if (event === "delta" && payload !== null && typeof payload === "object") {
              const text = (payload as { text?: unknown }).text;
              if (typeof text === "string") setDeltas((current) => current + text);
            }
          }
        }
        if (debugRunId) await poll(debugRunId);
        return;
      }
      const body = envelope(await response.json().catch(() => null));
      if (!response.ok || !body.success) throw new Error(message(body));
      const receipt = parseAiDebugReceipt(body.data);
      await poll(receipt.debugRunId);
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : "请求失败");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI 调试台"
        description="仅使用服务端已激活的 Mock Provider 与 Prompt 版本。不提供部署、Provider 地址、密钥或任意 System Prompt 输入，调试结果不写入任何正式旅行记录。"
      />
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit("test");
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="font-medium">Prompt key</span>
            <select
              className={field}
              value={promptKey}
              onChange={(event) => setPromptKey(event.target.value)}
              disabled={busy}
            >
              {AI_DEBUG_PROMPT_KEYS.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">固定 mock profile</span>
            <select
              className={field}
              value={failureProfile}
              onChange={(event) => setFailureProfile(event.target.value as AiDebugFailureProfile)}
              disabled={busy}
            >
              {AI_DEBUG_FAILURE_PROFILES.map((profile) => (
                <option key={profile} value={profile}>
                  {profileText[profile]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">变量（JSON 对象）</span>
          <textarea
            className={`${field} min-h-32 font-mono text-sm`}
            value={variables}
            onChange={(event) => setVariables(event.target.value)}
            disabled={busy}
            spellCheck={false}
          />
          <span className="block text-xs text-muted-foreground">
            服务端始终以自身时钟与语言环境覆盖 locale、timezone 与 serverDate。
          </span>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            单次调用
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void submit("stream")}
          >
            流式调用
          </Button>
        </div>
      </form>
      {error ? <ErrorState message={error} /> : null}
      {deltas ? (
        <section className="space-y-1 rounded-md border border-border-subtle p-3">
          <h2 className="text-sm font-medium">瞬时 delta（不持久化，不重放）</h2>
          <pre className="max-h-40 overflow-auto text-xs break-all whitespace-pre-wrap">
            {deltas}
          </pre>
        </section>
      ) : null}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">最近调试运行</h2>
        {runs.length === 0 ? (
          <EmptyState title="暂无调试运行" description="提交一次调用后，这里显示安全聚合状态。" />
        ) : (
          <ul className="space-y-3">
            {runs.map((run) => (
              <li
                key={run.debugRunId}
                className="space-y-2 rounded-md border border-border-subtle p-3"
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono text-xs">{run.debugRunId}</span>
                  <span className="rounded-sm bg-muted px-2 py-0.5 text-xs">
                    {statusText[run.status]}
                  </span>
                  {run.errorCode ? (
                    <span className="rounded-sm bg-muted px-2 py-0.5 font-mono text-xs">
                      {run.errorCode}
                    </span>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void poll(run.debugRunId)}
                  >
                    刷新（零外呼）
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  attempt：{run.attemptIds.length === 0 ? "无" : run.attemptIds.join(", ")}
                </p>
                {run.finalSummary ? (
                  <dl className="grid gap-1 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="inline text-muted-foreground">Prompt 版本：</dt>
                      <dd className="inline font-mono">{run.finalSummary.promptVersionId}</dd>
                    </div>
                    <div>
                      <dt className="inline text-muted-foreground">Prompt hash：</dt>
                      <dd className="inline font-mono break-all">{run.finalSummary.promptHash}</dd>
                    </div>
                    <div>
                      <dt className="inline text-muted-foreground">Deployment：</dt>
                      <dd className="inline font-mono">
                        {run.finalSummary.deploymentId}@{run.finalSummary.deploymentConfigVersion}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline text-muted-foreground">Provider：</dt>
                      <dd className="inline font-mono">
                        {run.finalSummary.providerId}@{run.finalSummary.providerConfigVersion}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline text-muted-foreground">Schema 校验：</dt>
                      <dd className="inline">
                        {run.finalSummary.schemaValidation.valid
                          ? "通过"
                          : (run.finalSummary.schemaValidation.diagnosticCategory ?? "未分类失败")}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline text-muted-foreground">AiOutputRecord：</dt>
                      <dd className="inline font-mono">{run.finalSummary.aiOutputRecordId}</dd>
                    </div>
                  </dl>
                ) : null}
                {run.finalSummary?.rawOutput ? (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      受限 mock rawOutput（已裁剪、已脱敏）
                    </summary>
                    <pre className="mt-1 max-h-40 overflow-auto break-all whitespace-pre-wrap">
                      {run.finalSummary.rawOutput}
                    </pre>
                  </details>
                ) : null}
                {run.finalSummary?.parsedData ? (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">解析后的数据</summary>
                    <pre className="mt-1 max-h-40 overflow-auto break-all whitespace-pre-wrap">
                      {JSON.stringify(run.finalSummary.parsedData, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="text-xs text-muted-foreground">
        所有时间戳以服务端时钟为准；页面不展示 Prompt 正文、密钥或 Provider 地址。
      </p>
    </div>
  );
}
