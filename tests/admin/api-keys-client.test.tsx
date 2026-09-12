import { webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeysClient } from "@/components/admin/api-keys-client";
import ErrorPage from "@/app/error";
import NotFound from "@/app/not-found";
import type { ApiKeyDto, ApiKeyPage } from "@/lib/admin-api-keys";

const request = vi.fn<typeof fetch>();
const target: ApiKeyDto = {
  id: "fixture_key",
  name: "测试密钥",
  provider: "fixture-provider",
  keyFingerprintDisplay: "0123456789ab…",
  status: "ACTIVE",
  revision: 4,
  lastUsedAt: null,
  revokedAt: null,
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:00:00.000Z",
};
function ok(data: unknown, status = 200) {
  return Response.json({ success: true, data, requestId: "fixture-request" }, { status });
}
function page(items = [target], nextCursor: string | null = null) {
  return ok({ items, nextCursor } satisfies ApiKeyPage);
}
function failed(code: string, status: number) {
  return Response.json(
    {
      success: false,
      error: {
        code,
        message: "PRIVATE_DIAGNOSTIC_STACK_CANARY",
        details: { plainKey: "PRIVATE_DETAIL_CANARY" },
      },
      requestId: "fixture-request",
    },
    { status },
  );
}
function csrf() {
  return Response.json({ csrfToken: "a".repeat(64) });
}
function writes(method = "POST") {
  return request.mock.calls.filter(([, options]) => options?.method === method);
}
async function ready(items = [target], cursor: string | null = null) {
  request.mockResolvedValueOnce(page(items, cursor));
  render(<ApiKeysClient />);
  await screen.findByText(`第 1 页 · 本页 ${items.length} 条`);
}
function createForm(secret: string) {
  fireEvent.click(screen.getByRole("button", { name: "录入密钥" }));
  const form = screen.getByRole("form", { name: "录入密钥" });
  fireEvent.change(within(form).getByLabelText("名称"), { target: { value: "新密钥版本" } });
  fireEvent.change(within(form).getByLabelText("提供方标识"), {
    target: { value: "fixture-provider" },
  });
  fireEvent.change(within(form).getByLabelText("密钥"), { target: { value: secret } });
  return form;
}
beforeEach(() => {
  request.mockReset();
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("crypto", webcrypto);
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("admin/api-keys safe interface", () => {
  it("[create-read] shows loading, empty and exact safe key pages", async () => {
    let resolve!: (response: Response) => void;
    request.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<ApiKeysClient />);
    expect(screen.getByText("正在加载密钥列表")).toBeInTheDocument();
    resolve(page([]));
    await screen.findByText("没有符合条件的密钥。");
    request.mockResolvedValueOnce(page());
    fireEvent.click(screen.getByRole("button", { name: "刷新列表" }));
    await screen.findByText(target.keyFingerprintDisplay);
    expect(screen.getByRole("region", { name: "密钥列表" })).toHaveAttribute("tabindex", "0");
  });

  it("[crypto-redaction] submits an uncontrolled one-time secret and never reflects it in HTML or browser storage", async () => {
    await ready([]);
    const secret = `fixture-only::${webcrypto.randomUUID()}`;
    const form = createForm(secret),
      input = within(form).getByLabelText("密钥") as HTMLInputElement;
    request
      .mockResolvedValueOnce(csrf())
      .mockResolvedValueOnce(ok({ ...target, name: "新密钥版本" }, 201))
      .mockResolvedValueOnce(page());
    fireEvent.submit(form);
    expect(input.value === "").toBe(true);
    await screen.findByText("密钥已保存。后续仅显示短指纹。");
    expect(writes().length).toBe(1);
    const [url, options] = writes()[0];
    expect(url).toBe("/api/admin/api-keys");
    expect(JSON.parse(String(options?.body)).plainKey === secret).toBe(true);
    expect(new Headers(options?.headers).get("Idempotency-Key")?.length).toBeGreaterThan(8);
    expect(document.documentElement.outerHTML.includes(secret)).toBe(false);
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it("[failure-atomicity] reentry after a lost response reuses the same request identity without retaining the secret", async () => {
    await ready([]);
    const secret = `fixture-only::${webcrypto.randomUUID()}`;
    const form = createForm(secret);
    request
      .mockResolvedValueOnce(csrf())
      .mockRejectedValueOnce(new Error("PRIVATE_DIAGNOSTIC_STACK_CANARY"));
    fireEvent.submit(form);
    await screen.findByText("操作未完成。录入或轮换时请重新输入密钥后重试。");
    expect((within(form).getByLabelText("密钥") as HTMLInputElement).value === "").toBe(true);
    const firstKey = new Headers(writes()[0][1]?.headers).get("Idempotency-Key");
    fireEvent.change(within(form).getByLabelText("密钥"), { target: { value: secret } });
    request
      .mockResolvedValueOnce(csrf())
      .mockResolvedValueOnce(ok(target, 201))
      .mockResolvedValueOnce(page());
    fireEvent.submit(form);
    await screen.findByText("密钥已保存。后续仅显示短指纹。");
    expect(writes().length).toBe(2);
    expect(new Headers(writes()[1][1]?.headers).get("Idempotency-Key") === firstKey).toBe(true);
    expect(document.documentElement.outerHTML.includes("PRIVATE_DIAGNOSTIC_STACK_CANARY")).toBe(
      false,
    );
  });

  it("[disable-enable] requires reselection after stale CAS and never enables a revoked key", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: `停用 ${target.name}` }));
    request
      .mockResolvedValueOnce(csrf())
      .mockResolvedValueOnce(failed("VERSION_CONFLICT", 409))
      .mockResolvedValueOnce(
        page([{ ...target, status: "REVOKED", revision: 5, revokedAt: target.updatedAt }]),
      );
    fireEvent.submit(screen.getByRole("form", { name: "停用密钥" }));
    await screen.findByText("密钥状态已变化，请刷新后重新选择操作。");
    await waitFor(() =>
      expect(screen.queryByRole("form", { name: "停用密钥" })).not.toBeInTheDocument(),
    );
    expect(writes("PATCH").length).toBe(1);
    await within(await screen.findByRole("region", { name: "密钥列表" })).findByText("已撤销");
    expect(screen.queryByRole("button", { name: `启用 ${target.name}` })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `轮换 ${target.name}` })).not.toBeInTheDocument();
    expect(document.documentElement.outerHTML.includes("PRIVATE_DETAIL_CANARY")).toBe(false);
  });

  it("[rotate-revoke] displays pending validation honestly and only reports activation from its receipt", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: `轮换 ${target.name}` }));
    const form = screen.getByRole("form", { name: "轮换密钥" }),
      secret = `fixture-only::${webcrypto.randomUUID()}`;
    fireEvent.change(within(form).getByLabelText("新密钥"), { target: { value: secret } });
    request
      .mockResolvedValueOnce(csrf())
      .mockResolvedValueOnce(
        ok(
          {
            key: target,
            stage: "TESTING",
            affectedConfigCount: 2,
            errorCode: "CONFIG_ERROR",
            replayed: false,
          },
          202,
        ),
      )
      .mockResolvedValueOnce(page());
    fireEvent.submit(form);
    await screen.findByText("轮换尚未完成，候选密钥保持停用。重试时请重新输入同一密钥。");
    expect(screen.queryByText(/轮换完成，已切换/)).not.toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("新密钥"), { target: { value: secret } });
    request
      .mockResolvedValueOnce(csrf())
      .mockResolvedValueOnce(
        ok(
          {
            key: target,
            stage: "ACTIVATED",
            affectedConfigCount: 2,
            errorCode: null,
            replayed: true,
          },
          202,
        ),
      )
      .mockResolvedValueOnce(page());
    fireEvent.submit(form);
    await screen.findByText("轮换完成，已切换 2 项配置，原密钥已撤销。");
    expect(writes().every(([url]) => url === `/api/admin/api-keys/${target.id}/rotate`)).toBe(true);
    expect(
      new Headers(writes()[0][1]?.headers).get("Idempotency-Key") ===
        new Headers(writes()[1][1]?.headers).get("Idempotency-Key"),
    ).toBe(true);
  });

  it.each([
    { caseName: "stage array", field: "stage", value: ["ACTIVATED"] },
    { caseName: "nested stage array", field: "stage", value: [["ACTIVATED"]] },
    { caseName: "error code array", field: "errorCode", value: ["CONFIG_ERROR"] },
    { caseName: "nested error code array", field: "errorCode", value: [["CONFIG_ERROR"]] },
  ])(
    "[crypto-redaction] rejects a non-string rotation $caseName with a safe error",
    async ({ field, value }) => {
      await ready();
      fireEvent.click(screen.getByRole("button", { name: `轮换 ${target.name}` }));
      const form = screen.getByRole("form", { name: "轮换密钥" });
      fireEvent.change(within(form).getByLabelText("新密钥"), {
        target: { value: `fixture-only::${webcrypto.randomUUID()}` },
      });
      request.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(
        ok(
          {
            key: target,
            stage: "ACTIVATED",
            affectedConfigCount: 2,
            errorCode: null,
            replayed: false,
            [field]: value,
          },
          202,
        ),
      );
      fireEvent.submit(form);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "操作未完成。录入或轮换时请重新输入密钥后重试。",
      );
      expect(
        screen.queryByText(/轮换尚未完成|轮换完成，已切换|轮换已中止/),
      ).not.toBeInTheDocument();
      expect((within(form).getByLabelText("新密钥") as HTMLInputElement).value).toBe("");
      expect(writes()).toHaveLength(1);
    },
  );

  it("[authorization] uses fixed authorization errors and rejects extra secret fields from the server", async () => {
    request.mockResolvedValueOnce(failed("AUTH_REQUIRED", 401));
    render(<ApiKeysClient />);
    await screen.findByRole("link", { name: "重新登录" });
    expect(document.documentElement.outerHTML.includes("PRIVATE_DIAGNOSTIC_STACK_CANARY")).toBe(
      false,
    );
    request.mockResolvedValueOnce(
      ok({ items: [{ ...target, encryptedKey: "PRIVATE_DETAIL_CANARY" }], nextCursor: null }),
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新列表" }));
    await screen.findByText("密钥列表暂时无法加载，请稍后重试。");
    expect(screen.queryByText(target.name)).not.toBeInTheDocument();
  });

  it("[create-read] binds pagination to current filters", async () => {
    await ready([target], "opaque-cursor-fixture");
    request.mockResolvedValueOnce(page([{ ...target, id: "second", name: "第二页" }]));
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText("第 2 页 · 本页 1 条");
    expect(String(request.mock.calls.at(-1)?.[0]).includes("cursor=opaque-cursor-fixture")).toBe(
      true,
    );
    const filterForm = screen.getByRole("form", { name: "筛选密钥" });
    fireEvent.change(within(filterForm).getByLabelText("提供方"), {
      target: { value: "fixture-provider" },
    });
    request.mockResolvedValueOnce(page([]));
    fireEvent.submit(filterForm);
    await screen.findByText("第 1 页 · 本页 0 条");
    const url = String(request.mock.calls.at(-1)?.[0]);
    expect(url.includes("provider=fixture-provider") && !url.includes("cursor=")).toBe(true);
  });

  it("[crypto-redaction] renders safe error/not-found pages without exception data", () => {
    const reset = vi.fn();
    render(<ErrorPage error={new Error("PRIVATE_DIAGNOSTIC_STACK_CANARY")} reset={reset} />);
    expect(screen.getByRole("heading", { name: "页面暂时无法加载" })).toBeInTheDocument();
    expect(document.documentElement.outerHTML.includes("PRIVATE_DIAGNOSTIC_STACK_CANARY")).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(reset).toHaveBeenCalledOnce();
    cleanup();
    render(<NotFound />);
    expect(screen.getByRole("heading", { name: "页面未找到" })).toBeInTheDocument();
  });
});
