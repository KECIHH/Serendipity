import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogsClient } from "@/components/admin/logs-client";
import ErrorPage from "@/app/error";
import NotFound from "@/app/not-found";
import type { AuditLogPage, AuditSummary } from "@/lib/admin-logs";

const request = vi.fn<typeof fetch>();
const record: AuditSummary = {
  id: "audit_fixture_1",
  actorType: "ADMIN",
  actorId: "admin_fixture",
  targetType: "ApiKeyConfig",
  targetId: "key_fixture",
  action: "API_KEY_CREATE",
  requestId: "00000000-0000-4000-8000-000000000001",
  traceId: null,
  createdAt: "2026-09-12T00:00:00.000Z",
  safeSummary: '{"result":"SUCCESS","secret":"***"}',
};

function canary(): string {
  const value = `ui-fixture::${randomBytes(24).toString("hex")}`;
  const config = process.env.PHASE013_FIXTURE_CONFIG;
  const file = config
    ? path.join(path.dirname(path.resolve(config)), "crypto-canaries.jsonl")
    : path.resolve(".scaffold/phase013/crypto-canaries.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ uiPrivateDiagnostic: value })}\n`);
  return value;
}

function ok(data: unknown): Response {
  return Response.json({ success: true, data, requestId: "fixture_request" });
}
function page(items: AuditSummary[] = [record], nextCursor: string | null = null): Response {
  return ok({ items, nextCursor } satisfies AuditLogPage);
}
function failure(status: number, secret: string): Response {
  return Response.json(
    {
      success: false,
      error: { code: "INTERNAL_ERROR", message: secret, details: { stack: secret } },
      requestId: "fixture_request",
    },
    { status },
  );
}
async function ready(items: AuditSummary[] = [record], nextCursor: string | null = null) {
  request.mockResolvedValueOnce(page(items, nextCursor));
  render(<LogsClient />);
  await screen.findByText(`第 1 页 · 本页 ${items.length} 条`);
  await waitFor(() => expect(screen.getByRole("button", { name: "刷新日志" })).not.toBeDisabled());
}

beforeEach(() => {
  request.mockReset();
  vi.stubGlobal("fetch", request);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("admin/logs client", () => {
  it("[failure-atomicity] separates loading empty and service-error states with safe retries", async () => {
    let resolve!: (response: Response) => void;
    request.mockReturnValueOnce(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    render(<LogsClient />);
    expect(screen.getByRole("status")).toHaveTextContent("正在加载审计日志");
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
    const privateDiagnostic = canary();
    await act(async () => resolve(failure(503, privateDiagnostic)));
    expect(await screen.findByRole("alert")).toHaveTextContent("审计日志暂时无法加载");
    expect(document.body.textContent?.includes(privateDiagnostic)).toBe(false);
    expect(screen.queryByText("没有符合条件的审计日志。")).not.toBeInTheDocument();
    request.mockResolvedValueOnce(page([]));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("没有符合条件的审计日志。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
  });

  it("[failure-atomicity] uses opaque next and previous cursors then resets them for new filters", async () => {
    await ready([record], "opaque-second-page");
    request.mockResolvedValueOnce(
      page([{ ...record, id: "audit_fixture_2", action: "API_KEY_REVOKE" }]),
    );
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText("第 2 页 · 本页 1 条");
    expect(
      new URL(String(request.mock.calls[1][0]), "https://fixture.invalid").searchParams.get(
        "cursor",
      ),
    ).toBe("opaque-second-page");
    request.mockResolvedValueOnce(page([record], "opaque-second-page"));
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    await screen.findByText("第 1 页 · 本页 1 条");
    expect(
      new URL(String(request.mock.calls[2][0]), "https://fixture.invalid").searchParams.has(
        "cursor",
      ),
    ).toBe(false);
    fireEvent.change(screen.getByLabelText("操作", { exact: true }), {
      target: { value: " API_KEY_ROTATE " },
    });
    fireEvent.change(screen.getByLabelText("目标类型"), { target: { value: "ApiKeyConfig" } });
    fireEvent.change(screen.getByLabelText("操作者 ID"), { target: { value: "actor_fixture" } });
    fireEvent.change(screen.getByLabelText("目标 ID"), { target: { value: "key_fixture" } });
    request.mockResolvedValueOnce(page([]));
    fireEvent.submit(screen.getByRole("form", { name: "筛选审计日志" }));
    await screen.findByText("没有符合条件的审计日志。");
    const parameters = new URL(String(request.mock.calls[3][0]), "https://fixture.invalid")
      .searchParams;
    expect(Object.fromEntries(parameters)).toEqual({
      actorId: "actor_fixture",
      action: "API_KEY_ROTATE",
      targetType: "ApiKeyConfig",
      targetId: "key_fixture",
      limit: "20",
    });
    request.mockResolvedValueOnce(page([]));
    fireEvent.click(screen.getByRole("button", { name: "重置筛选" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(5));
    expect(new URL(String(request.mock.calls[4][0]), "https://fixture.invalid").search).toBe(
      "?limit=20",
    );
    expect(screen.getByLabelText("操作", { exact: true })).toHaveValue("");
  });

  it("[crypto-redaction] renders audit summaries as text and never writes browser storage", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const markup =
      '<img src="fixture-xss" onerror="window.fixtureExecuted=true"><script>window.fixtureExecuted=true</script>';
    await ready([{ ...record, safeSummary: markup }]);
    expect(document.body.textContent?.includes(markup)).toBe(true);
    expect(document.querySelector('img[src="fixture-xss"]')).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect("fixtureExecuted" in window).toBe(false);
    expect(storage).not.toHaveBeenCalled();
    expect(
      request.mock.calls.every(([, options]) => !options?.method || options.method === "GET"),
    ).toBe(true);
    expect(request.mock.calls[0][1]?.cache).toBe("no-store");
    expect(request.mock.calls[0][1]?.credentials).toBe("same-origin");
    expect(screen.getByRole("region", { name: "审计日志列表" })).toHaveAttribute("tabindex", "0");
  });

  it("[crypto-redaction] rejects unexpected fields and incomplete audit DTOs without partial rendering", async () => {
    const privateValue = canary();
    for (const unsafe of [
      { ...record, encryptedKey: privateValue },
      { ...record, safeSummary: { plaintext: privateValue } },
      { ...record, actorType: "ROOT" },
      { ...record, actorType: ["SYSTEM"] },
      { ...record, actorType: [["SYSTEM"]] },
      { ...record, actorType: ["ADMIN"] },
      { ...record, createdAt: "2026-02-30T00:00:00.000Z" },
    ]) {
      request.mockResolvedValueOnce(ok({ items: [unsafe], nextCursor: null }));
      render(<LogsClient />);
      expect(await screen.findByRole("alert")).toHaveTextContent("审计日志暂时无法加载");
      expect(document.body.textContent?.includes(privateValue)).toBe(false);
      expect(screen.queryByText(record.id)).not.toBeInTheDocument();
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      cleanup();
    }
  });

  it("[authorization] requests reauthentication for denied reads and never trusts server error text", async () => {
    const privateDiagnostic = canary();
    for (const status of [401, 403]) {
      request.mockResolvedValueOnce(failure(status, privateDiagnostic));
      render(<LogsClient />);
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(status === 401 ? "登录已过期" : "当前账号无法读取审计日志");
      expect(screen.getByRole("link", { name: "重新登录" })).toHaveAttribute(
        "href",
        "/admin/login",
      );
      expect(document.body.textContent?.includes(privateDiagnostic)).toBe(false);
      cleanup();
    }
    request.mockResolvedValueOnce(new Response(privateDiagnostic, { status: 503 }));
    render(<LogsClient />);
    expect(await screen.findByRole("alert")).toHaveTextContent("审计日志暂时无法加载");
    expect(document.body.textContent?.includes(privateDiagnostic)).toBe(false);
  });

  it("[failure-atomicity] ignores stale responses after a filter request replaces them", async () => {
    let resolveFirst!: (response: Response) => void;
    request.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      }),
    );
    render(<LogsClient />);
    request.mockResolvedValueOnce(page([]));
    fireEvent.change(screen.getByLabelText("目标 ID"), { target: { value: "new-target" } });
    fireEvent.submit(screen.getByRole("form", { name: "筛选审计日志" }));
    await screen.findByText("没有符合条件的审计日志。");
    await act(async () => resolveFirst(page([record])));
    expect(screen.getByText("没有符合条件的审计日志。")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("[failure-atomicity] error and not-found views omit framework messages stacks and request data", () => {
    const privateDiagnostic = canary(),
      reset = vi.fn();
    const error = new Error(privateDiagnostic) as Error & { digest?: string };
    error.stack = `${privateDiagnostic}\nC:/private/fixture/internal.ts:42`;
    error.digest = privateDiagnostic;
    render(<ErrorPage error={error} reset={reset} />);
    expect(screen.getByRole("alert")).toHaveTextContent("页面暂时无法加载");
    expect(document.body.textContent?.includes(privateDiagnostic)).toBe(false);
    expect(document.body.textContent?.includes("C:/private")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(reset).toHaveBeenCalledTimes(1);
    cleanup();
    render(<NotFound />);
    expect(screen.getByRole("heading", { name: "页面未找到" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回首页" })).toHaveAttribute("href", "/");
    expect(document.body.textContent?.includes(privateDiagnostic)).toBe(false);
  });
});
