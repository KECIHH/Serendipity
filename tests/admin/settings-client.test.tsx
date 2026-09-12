import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsClient } from "@/components/admin/settings-client";
import type { AdminSetting } from "@/lib/admin-settings";

const item: AdminSetting = {
  key: "planner.quick.defaultDurationDays",
  valueJson: 3,
  group: "GENERAL",
  description: "默认快速规划天数",
  isPublic: false,
  revision: 0,
  updatedAt: "2026-09-13T00:00:00.000Z",
};
const reply = (data: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    json: async () =>
      status < 400
        ? { success: true, data, requestId: "fixture-ui" }
        : {
            success: false,
            error: {
              code: status === 409 ? "VERSION_CONFLICT" : "INTERNAL_ERROR",
              message: "PRIVATE_ERROR_SHOULD_NOT_RENDER",
            },
            requestId: "fixture-ui",
          },
  }) as Response;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("admin/settings browser-facing interactions", () => {
  it("[authorization] separates loading, error and empty states without displaying server diagnostics", async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValueOnce(reply({ items: [] }));
    vi.stubGlobal("fetch", fetch);
    render(<SettingsClient />);
    expect(screen.getByRole("status")).toHaveTextContent("正在加载配置");
    resolve(reply(null, 503));
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法读取");
    expect(screen.queryByText("此分组暂无配置")).toBeNull();
    expect(screen.queryByText("PRIVATE_ERROR_SHOULD_NOT_RENDER")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { name: "此分组暂无配置" })).toBeInTheDocument();
  });
  it("[authorization] validates JSON and sends only URL key plus expectedVersion, CSRF and stable retry identity", async () => {
    const writes: RequestInit[] = [];
    const fetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/auth/csrf")
        return { ok: true, json: async () => ({ csrfToken: "fixture-csrf" }) } as Response;
      if (options?.method === "PATCH") {
        writes.push(options);
        return writes.length === 1
          ? reply(null, 503)
          : reply({ ...item, valueJson: 5, revision: 1 });
      }
      return reply({ items: [item] });
    });
    vi.stubGlobal("fetch", fetch);
    render(<SettingsClient />);
    const edit = await screen.findByRole("button", { name: "编辑 默认快速规划天数" });
    fireEvent.click(edit);
    const textbox = screen.getByRole("textbox", { name: "配置值（JSON）" });
    expect(textbox).toHaveFocus();
    fireEvent.change(textbox, { target: { value: "invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("有效 JSON");
    expect(writes.length).toBe(0);
    fireEvent.change(textbox, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText("保存未完成，请重试；登录失效时请重新登录。");
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText("配置已保存，变更已记录。");
    expect(writes.length).toBe(2);
    expect(JSON.parse(writes[0].body as string)).toEqual({ valueJson: 5, expectedVersion: 0 });
    expect(writes[0].headers).toEqual(writes[1].headers);
    expect((writes[0].headers as Record<string, string>)["x-csrf-token"]).toBe("fixture-csrf");
    expect(screen.queryByRole("textbox")).toBeNull();
    await waitFor(() => expect(edit).toHaveFocus());
  });
  it("[authorization] restores the enabled edit trigger after cancel and Escape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ items: [item] })));
    render(<SettingsClient />);
    const edit = await screen.findByRole("button", { name: "编辑 默认快速规划天数" });
    fireEvent.click(edit);
    expect(screen.getByRole("textbox")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(edit).toHaveFocus());
    fireEvent.click(edit);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    await waitFor(() => expect(edit).toHaveFocus());
  });
  it("[authorization] closes stale edits after409 and requires explicit selection of the refreshed version", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        if (url === "/api/auth/csrf")
          return { ok: true, json: async () => ({ csrfToken: "fixture-csrf" }) } as Response;
        if (options?.method === "PATCH") {
          calls++;
          return reply(null, 409);
        }
        return reply({ items: [{ ...item, revision: calls, valueJson: calls ? 8 : 3 }] });
      }),
    );
    render(<SettingsClient />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑 默认快速规划天数" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText(/配置已被其他操作更新/);
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(calls).toBe(1);
    expect(await screen.findByText("8")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑 默认快速规划天数" }));
    expect(screen.getByRole("textbox")).toHaveValue("8");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
