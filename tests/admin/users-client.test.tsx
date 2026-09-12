import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UsersClient } from "@/components/admin/users-client";
import type { AdminUserDto, AdminUserPage } from "@/lib/admin-users";

const request = vi.fn<typeof fetch>();
const actorId = "fixture_admin";
const target: AdminUserDto = {
  id: "fixture_target",
  email: "target@example.invalid",
  name: "测试用户",
  avatarUrl: null,
  role: "USER",
  status: "ACTIVE",
  lastLoginAt: null,
  createdAt: "2026-09-01T08:00:00.000Z",
  revision: 4,
};
const administrator: AdminUserDto = {
  ...target,
  id: actorId,
  email: "admin@example.invalid",
  name: "当前管理员",
  role: "ADMIN",
};

function ok<T>(data: T) {
  return Response.json({ success: true, data, requestId: "fixture-request" });
}

function failed(code: string, status: number, details?: unknown) {
  return Response.json(
    {
      success: false,
      error: {
        code,
        message: "untrusted internal diagnostic",
        ...(details === undefined ? {} : { details }),
      },
      requestId: "fixture-request",
    },
    { status },
  );
}

function csrf() {
  return Response.json({ csrfToken: "a".repeat(64) });
}

function patchCalls() {
  return request.mock.calls.filter(([, options]) => options?.method === "PATCH");
}

async function ready(
  items: AdminUserDto[] = [administrator, target],
  nextCursor: string | null = null,
) {
  request.mockResolvedValueOnce(ok<AdminUserPage>({ items, nextCursor }));
  render(<UsersClient currentUserId={actorId} />);
  await screen.findByText(`第 1 页 · 本页 ${items.length} 位用户`);
}

function edit(user: AdminUserDto = target) {
  fireEvent.click(screen.getByRole("button", { name: `编辑 ${user.email}` }));
}

function submit() {
  fireEvent.submit(screen.getByRole("form", { name: "编辑用户" }));
}

beforeEach(() => {
  request.mockReset();
  vi.stubGlobal("fetch", request);
  let key = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation(
    () => `00000000-0000-4000-8000-${String(++key).padStart(12, "0")}`,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("admin/users client", () => {
  it("loads the exact management page, keeps self controls absent and separates a failed list from an empty list", async () => {
    request.mockResolvedValueOnce(failed("INTERNAL_ERROR", 503));
    render(<UsersClient currentUserId={actorId} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("用户列表暂时不可用");
    expect(screen.queryByText("当前筛选下无用户。")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).not.toHaveTextContent("untrusted internal diagnostic");
    request.mockResolvedValueOnce(ok<AdminUserPage>({ items: [], nextCursor: null }));
    fireEvent.click(screen.getByRole("button", { name: "刷新列表" }));
    expect(await screen.findByText("当前筛选下无用户。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
    request.mockResolvedValueOnce(
      ok<AdminUserPage>({ items: [administrator, target], nextCursor: null }),
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新列表" }));
    expect(await screen.findByText("当前账户")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: `编辑 ${administrator.email}` }),
    ).not.toBeInTheDocument();
    expect(request.mock.calls[0][0]).toBe("/api/admin/users?limit=20");
  });

  it("uses opaque next/previous cursors and clears pagination when applying role/status/page-size filters", async () => {
    await ready([administrator, target], "opaque-page-2");
    request.mockResolvedValueOnce(
      ok<AdminUserPage>({
        items: [{ ...target, id: "next_user", email: "next@example.invalid" }],
        nextCursor: null,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText("第 2 页 · 本页 1 位用户");
    expect(
      new URL(String(request.mock.calls[1][0]), "https://fixture.invalid").searchParams.get(
        "cursor",
      ),
    ).toBe("opaque-page-2");
    request.mockResolvedValueOnce(
      ok<AdminUserPage>({ items: [administrator, target], nextCursor: "opaque-page-2" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    await screen.findByText("第 1 页 · 本页 2 位用户");
    expect(
      new URL(String(request.mock.calls[2][0]), "https://fixture.invalid").searchParams.has(
        "cursor",
      ),
    ).toBe(false);
    fireEvent.change(screen.getByLabelText("筛选角色"), { target: { value: "ADMIN" } });
    fireEvent.change(screen.getByLabelText("筛选状态"), { target: { value: "DISABLED" } });
    fireEvent.change(screen.getByLabelText("每页条数"), { target: { value: "50" } });
    request.mockResolvedValueOnce(ok<AdminUserPage>({ items: [], nextCursor: null }));
    fireEvent.submit(screen.getByRole("form", { name: "筛选用户" }));
    await screen.findByText("第 1 页 · 本页 0 位用户");
    const query = new URL(String(request.mock.calls[3][0]), "https://fixture.invalid").searchParams;
    expect(Object.fromEntries(query)).toEqual({ limit: "50", role: "ADMIN", status: "DISABLED" });
  });

  it("retains the real GET revision in PATCH, sends CSRF and a command key, and focuses the trigger after success", async () => {
    await ready();
    const trigger = screen.getByRole("button", { name: `编辑 ${target.email}` });
    edit();
    expect(screen.getByLabelText("角色", { exact: true })).toHaveFocus();
    fireEvent.change(screen.getByLabelText("角色", { exact: true }), {
      target: { value: "ADMIN" },
    });
    fireEvent.change(screen.getByLabelText("变更原因"), { target: { value: "  扩展管理职责  " } });
    request
      .mockResolvedValueOnce(csrf())
      .mockResolvedValueOnce(ok({ ...target, role: "ADMIN", revision: 5 }));
    submit();
    expect(await screen.findByRole("status")).toHaveTextContent("用户权限已更新");
    const [url, options] = patchCalls()[0];
    expect(url).toBe(`/api/admin/users/${target.id}`);
    expect(JSON.parse(String(options?.body))).toEqual({
      role: "ADMIN",
      status: "ACTIVE",
      expectedVersion: 4,
      reason: "扩展管理职责",
    });
    const headers = new Headers(options?.headers);
    expect(headers.get("x-csrf-token")).toBe("a".repeat(64));
    expect(headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.queryByRole("form", { name: "编辑用户" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(document.body).not.toHaveTextContent("sessionVersion");
  });

  it("blocks duplicate in-flight submissions and reuses the same key and payload on a safe retry", async () => {
    await ready();
    edit();
    fireEvent.change(screen.getByLabelText("状态", { exact: true }), {
      target: { value: "DISABLED" },
    });
    fireEvent.change(screen.getByLabelText("变更原因"), { target: { value: "测试停用" } });
    let resolvePending!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolvePending = resolve;
    });
    request.mockResolvedValueOnce(csrf()).mockReturnValueOnce(pending);
    submit();
    submit();
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    expect(screen.getByLabelText("状态", { exact: true })).toBeDisabled();
    await act(async () => resolvePending(failed("INTERNAL_ERROR", 503)));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存暂时不可用");
    expect(screen.getByLabelText("状态", { exact: true })).toHaveValue("DISABLED");
    expect(screen.getByLabelText("变更原因")).toHaveValue("测试停用");
    fireEvent.change(screen.getByLabelText("变更原因"), { target: { value: " 测试停用 " } });
    request
      .mockResolvedValueOnce(csrf())
      .mockResolvedValueOnce(ok({ ...target, status: "DISABLED", revision: 5 }));
    submit();
    await screen.findByText("用户权限已更新，原有登录已失效。");
    const patches = patchCalls();
    expect(patches).toHaveLength(2);
    expect(patches[0][1]?.body).toBe(patches[1][1]?.body);
    expect(new Headers(patches[0][1]?.headers).get("Idempotency-Key")).toBe(
      new Headers(patches[1][1]?.headers).get("Idempotency-Key"),
    );
  });

  it("shows the latest safe 409 summary and requires a newly selected operation and key", async () => {
    await ready();
    edit();
    fireEvent.change(screen.getByLabelText("状态", { exact: true }), {
      target: { value: "DISABLED" },
    });
    fireEvent.change(screen.getByLabelText("变更原因"), { target: { value: "第一次选择" } });
    const latest: AdminUserDto = { ...target, role: "ADMIN", revision: 7 };
    request
      .mockResolvedValueOnce(csrf())
      .mockResolvedValueOnce(
        failed("VERSION_CONFLICT", 409, { currentVersion: 7, action: "RELOAD", current: latest }),
      );
    submit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("请根据最新信息重新选择操作");
    expect(alert).toHaveTextContent("管理员 · 正常 · 版本 7");
    expect(alert).toHaveFocus();
    expect(screen.queryByRole("form", { name: "编辑用户" })).not.toBeInTheDocument();
    expect(patchCalls()).toHaveLength(1);
    edit(latest);
    expect(screen.getByLabelText("角色", { exact: true })).toHaveValue("ADMIN");
    expect(screen.getByLabelText("状态", { exact: true })).toHaveValue("ACTIVE");
    expect(screen.getByLabelText("变更原因")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("状态", { exact: true }), {
      target: { value: "DISABLED" },
    });
    fireEvent.change(screen.getByLabelText("变更原因"), { target: { value: "确认新版本后停用" } });
    request
      .mockResolvedValueOnce(csrf())
      .mockResolvedValueOnce(ok({ ...latest, status: "DISABLED", revision: 8 }));
    submit();
    await screen.findByText("用户权限已更新，原有登录已失效。");
    const patches = patchCalls();
    expect(JSON.parse(String(patches[1][1]?.body)).expectedVersion).toBe(7);
    expect(new Headers(patches[0][1]?.headers).get("Idempotency-Key")).not.toBe(
      new Headers(patches[1][1]?.headers).get("Idempotency-Key"),
    );
  });

  it("reports a same-value response truthfully without claiming session revocation", async () => {
    await ready();
    edit();
    fireEvent.change(screen.getByLabelText("变更原因"), { target: { value: "复核账户" } });
    request.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(ok(target));
    submit();
    expect(await screen.findByRole("status")).toHaveTextContent("角色与状态未变化。");
    expect(screen.getByRole("status")).not.toHaveTextContent("原有登录已失效");
  });

  it("requires a meaningful reason and returns focus when the user cancels editing", async () => {
    await ready();
    const trigger = screen.getByRole("button", { name: `编辑 ${target.email}` });
    edit();
    fireEvent.change(screen.getByLabelText("变更原因"), { target: { value: "   " } });
    submit();
    expect(screen.getByRole("alert")).toHaveTextContent("请输入 1–500 字的变更原因");
    expect(screen.getByLabelText("变更原因")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("变更原因")).toHaveFocus();
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "取消编辑" }));
    expect(trigger).toHaveFocus();
  });

  it("rejects an unexpected sensitive response field instead of rendering any partial unsafe DTO", async () => {
    request.mockResolvedValueOnce(
      ok({ items: [{ ...target, passwordHash: "private-canary" }], nextCursor: null }),
    );
    render(<UsersClient currentUserId={actorId} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("用户列表暂时不可用");
    expect(document.body).not.toHaveTextContent("private-canary");
    expect(screen.queryByText(target.email)).not.toBeInTheDocument();
  });

  it("offers reauthentication after authorization expires without echoing the server diagnostic", async () => {
    request.mockResolvedValueOnce(failed("AUTH_REQUIRED", 401));
    render(<UsersClient currentUserId={actorId} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("登录已过期");
    expect(screen.getByRole("link", { name: "重新登录" })).toHaveAttribute("href", "/admin/login");
    expect(document.body).not.toHaveTextContent("untrusted internal diagnostic");
  });
});
