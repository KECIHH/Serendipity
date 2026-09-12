import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  pathname: "/admin/users",
  guard: vi.fn(),
  redirect: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => boundary.pathname,
  useRouter: () => ({ replace: boundary.replace, refresh: boundary.refresh }),
  redirect: boundary.redirect,
}));
vi.mock("@/server/auth/require-admin", () => ({ requireAdmin: boundary.guard }));

import AdminLayout from "@/app/admin/layout";
import ProtectedAdminLayout from "@/app/admin/(protected)/layout";
import AdminPage from "@/app/admin/(protected)/page";
import AdminUsersPage from "@/app/admin/(protected)/users/page";
import AdminApiKeysPage from "@/app/admin/(protected)/api-keys/page";
import AdminLogsPage from "@/app/admin/(protected)/logs/page";
import AdminSettingsPage from "@/app/admin/(protected)/settings/page";
import { DashboardClient } from "@/components/admin/dashboard-client";
import AdminLoginPage from "@/app/admin/(public)/login/page";
import { activeAdminHref, ADMIN_NAV } from "@/components/admin/admin-nav";
import { AdminShell } from "@/components/layout/admin-shell";
import { AuthAuthorizationError, AuthUnavailableError } from "@/server/auth/errors";

const currentUser = { id: "fixture_admin", email: "navigation@example.invalid" };

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(filename) : [filename];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  boundary.pathname = "/admin/users";
  boundary.guard.mockResolvedValue({ ...currentUser, role: "ADMIN", audience: "ADMIN" });
  boundary.redirect.mockImplementation((href: string) => {
    throw new Error(`redirect:${href}`);
  });
});

afterEach(() => cleanup());

describe("admin/layout navigation and route boundaries", () => {
  it("checks every configured href against a real page and has exactly one production shell and navigation source", () => {
    const root = path.resolve("src/app");
    const routes = sourceFiles(root)
      .filter((file) => /[/\\]page\.tsx$/.test(file))
      .map((file) => {
        const segments = path
          .relative(root, path.dirname(file))
          .split(path.sep)
          .filter((segment) => segment && !/^\(.+\)$/.test(segment));
        return `/${segments.join("/")}`;
      });
    const links = ADMIN_NAV.filter((item) => item.kind === "link");
    expect(links.map((item) => item.href)).toEqual([
      "/admin",
      "/admin/users",
      "/admin/api-keys",
      "/admin/logs",
      "/admin/settings",
    ]);
    for (const item of links) expect(routes, `Missing page for ${item.href}`).toContain(item.href);
    expect(ADMIN_NAV.filter((item) => item.kind === "action")).toEqual([
      { kind: "action", action: "logout", label: "退出登录" },
    ]);
    const implementations = sourceFiles(path.resolve("src"))
      .filter((file) => /\.[jt]sx?$/.test(file) && !/\.test\./.test(file))
      .filter((file) =>
        /export\s+(?:default\s+)?function\s+AdminShell\b/.test(readFileSync(file, "utf8")),
      );
    expect(implementations).toEqual([path.resolve("src/components/layout/admin-shell.tsx")]);
    expect(
      sourceFiles(path.resolve("src/components")).filter(
        (file) => path.basename(file) === "admin-nav.ts",
      ),
    ).toEqual([path.resolve("src/components/admin/admin-nav.ts")]);
    expect(routes.filter((href) => href.startsWith("/admin")).sort()).toEqual([
      "/admin",
      "/admin/api-keys",
      "/admin/login",
      "/admin/logs",
      "/admin/settings",
      "/admin/users",
    ]);
  });

  it("selects the longest match only at a path-segment boundary", () => {
    expect(activeAdminHref("/admin/users")).toBe("/admin/users");
    expect(activeAdminHref("/admin/users/member")).toBe("/admin/users");
    expect(activeAdminHref("/admin/user")).toBeNull();
    expect(activeAdminHref("/admin/users-extra")).toBeNull();
    expect(
      activeAdminHref("/admin/users/member", [
        { kind: "link", href: "/admin", label: "Root fixture" },
        { kind: "link", href: "/admin/users", label: "Users fixture" },
        { kind: "link", href: "/admin/users/member", label: "Nested fixture" },
      ]),
    ).toBe("/admin/users/member");
  });

  it("keeps public login and neutral root free of the protected shell", () => {
    render(
      <AdminLayout>
        <AdminLoginPage />
      </AdminLayout>,
    );
    expect(screen.getByRole("heading", { name: "管理员登录" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "后台导航" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-admin-shell]")).toBeNull();
    expect(boundary.guard).not.toHaveBeenCalled();
  });

  it("authorizes the protected layout and exposes only the safe current administrator identity", async () => {
    render(await ProtectedAdminLayout({ children: <h1>受保护内容</h1> }));
    expect(boundary.guard).toHaveBeenCalledOnce();
    expect(screen.getByText(currentUser.email)).toBeInTheDocument();
    expect(
      within(screen.getByRole("main")).getByRole("heading", { name: "受保护内容" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "用户管理" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "跳到主要内容" })).toHaveAttribute(
      "href",
      "#admin-main-content",
    );
  });

  it("renders the protected dashboard and guards all five pages independently", async () => {
    expect((await AdminPage()).type).toBe(DashboardClient);
    expect(boundary.guard).toHaveBeenCalledOnce();
    const page = await AdminUsersPage();
    expect(page.props).toEqual({ currentUserId: currentUser.id });
    expect(boundary.guard).toHaveBeenCalledTimes(2);
    await AdminApiKeysPage();
    await AdminLogsPage();
    await AdminSettingsPage();
    expect(boundary.guard).toHaveBeenCalledTimes(5);
  });

  it.each([401, 403] as const)(
    "rejects %s before rendering any shell or users content",
    async (status) => {
      const error = new AuthAuthorizationError(
        status,
        status === 401 ? "AUTH_REQUIRED" : "FORBIDDEN",
      );
      boundary.guard.mockRejectedValue(error);
      await expect(ProtectedAdminLayout({ children: <h1>Private</h1> })).rejects.toThrow(
        "redirect:/admin/login",
      );
      await expect(AdminUsersPage()).rejects.toThrow("redirect:/admin/login");
      await expect(AdminPage()).rejects.toThrow("redirect:/admin/login");
      await expect(AdminApiKeysPage()).rejects.toThrow("redirect:/admin/login");
      await expect(AdminLogsPage()).rejects.toThrow("redirect:/admin/login");
      await expect(AdminSettingsPage()).rejects.toThrow("redirect:/admin/login");
      expect(boundary.redirect).toHaveBeenCalledTimes(6);
    },
  );

  it("does not disguise an unavailable authorization database as a successful empty page", async () => {
    const error = new AuthUnavailableError();
    boundary.guard.mockRejectedValue(error);
    await expect(ProtectedAdminLayout({ children: null })).rejects.toBe(error);
    await expect(AdminUsersPage()).rejects.toBe(error);
    await expect(AdminApiKeysPage()).rejects.toBe(error);
    await expect(AdminLogsPage()).rejects.toBe(error);
    await expect(AdminSettingsPage()).rejects.toBe(error);
    await expect(AdminPage()).rejects.toBe(error);
    expect(boundary.redirect).not.toHaveBeenCalled();
  });

  it("supports visible current navigation, arrow focus, Escape collapse and focus return", () => {
    render(
      <AdminShell currentUser={currentUser}>
        <h1>用户管理内容</h1>
      </AdminShell>,
    );
    const navigation = screen.getByRole("navigation", { name: "后台导航" });
    const users = within(navigation).getByRole("link", { name: "用户管理" });
    const logout = within(navigation).getByRole("button", { name: "退出登录" });
    users.focus();
    fireEvent.keyDown(users, { key: "ArrowDown" });
    expect(within(navigation).getByRole("link", { name: "密钥管理" })).toHaveFocus();
    fireEvent.keyDown(logout, { key: "Home" });
    expect(within(navigation).getByRole("link", { name: "Dashboard" })).toHaveFocus();
    fireEvent.keyDown(users, { key: "End" });
    expect(logout).toHaveFocus();
    fireEvent.keyDown(logout, { key: "Escape" });
    const toggle = screen.getByRole("button", { name: "展开后台导航" });
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("navigation", { name: "后台导航" })).not.toBeInTheDocument();
    expect(navigation).toHaveAttribute("hidden");
    fireEvent.click(toggle);
    expect(screen.getByRole("navigation", { name: "后台导航" })).toBeVisible();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});
