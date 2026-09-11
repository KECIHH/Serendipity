import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));

import { LoginForm } from "@/components/auth/login-form";
import { LogoutButton } from "@/components/auth/logout-button";

const request = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.clearAllMocks();
  request.mockReset();
  vi.stubGlobal("fetch", request);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function csrfResponse() {
  return Response.json({ csrfToken: "a".repeat(64) });
}

function fillAndSubmit(audience: "ADMIN" | "USER" = "ADMIN") {
  fireEvent.change(screen.getByLabelText("邮箱"), {
    target: { value: "ui-fixture@example.invalid" },
  });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "x".repeat(12) } });
  fireEvent.submit(
    screen.getByRole("form", { name: audience === "ADMIN" ? "管理员登录" : "用户登录" }),
  );
}

describe("shared administrator and user login form", () => {
  it("labels inputs, masks the password and posts only to the single Auth.js provider", async () => {
    request
      .mockResolvedValueOnce(csrfResponse())
      .mockResolvedValueOnce(Response.json({ url: "/admin" }));
    render(<LoginForm audience="ADMIN" />);
    expect(screen.getByLabelText("密码")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("邮箱")).toHaveAttribute("autocomplete", "username");
    fillAndSubmit();
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/admin"));
    expect(request.mock.calls[0][0]).toBe("/api/auth/csrf");
    expect(request.mock.calls[1][0]).toBe("/api/auth/callback/credentials");
    const options = request.mock.calls[1][1]!;
    const body = options.body as URLSearchParams;
    expect([...body.keys()].sort()).toEqual(["audience", "csrfToken", "email", "password"]);
    expect(body.get("audience")).toBe("ADMIN");
    expect(body.get("csrfToken")).toHaveLength(64);
    expect(navigation.refresh).toHaveBeenCalledOnce();
  });

  it.each([401, 429, 503])(
    "shows a safe accessible error on status %s without navigating",
    async (status) => {
      request
        .mockResolvedValueOnce(csrfResponse())
        .mockResolvedValueOnce(Response.json({ error: "untrusted diagnostic" }, { status }));
      render(<LoginForm audience="ADMIN" />);
      fillAndSubmit();
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(
        status === 401
          ? "邮箱或密码错误"
          : status === 429
            ? "登录尝试过于频繁"
            : "登录服务暂时不可用",
      );
      expect(alert).not.toHaveTextContent("untrusted diagnostic");
      expect(navigation.replace).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "登录" })).toBeEnabled();
    },
  );

  it("shares the handler for USER login and returns to the site", async () => {
    request
      .mockResolvedValueOnce(csrfResponse())
      .mockResolvedValueOnce(Response.json({ url: "/" }));
    render(<LoginForm audience="USER" />);
    fillAndSubmit("USER");
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/"));
    expect((request.mock.calls[1][1]!.body as URLSearchParams).get("audience")).toBe("USER");
  });

  it("does not submit credentials when CSRF bootstrap is unavailable", async () => {
    request.mockRejectedValueOnce(new Error("Network unavailable"));
    render(<LoginForm audience="ADMIN" />);
    fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent("登录服务暂时不可用");
    expect(request).toHaveBeenCalledTimes(1);
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});

describe("administrator logout", () => {
  it("uses Auth.js signout and navigates only after confirmed success", async () => {
    request
      .mockResolvedValueOnce(csrfResponse())
      .mockResolvedValueOnce(Response.json({ url: "/admin/login" }));
    render(<LogoutButton />);
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/admin/login"));
    expect(request.mock.calls[1][0]).toBe("/api/auth/signout");
    expect((request.mock.calls[1][1]!.body as URLSearchParams).get("csrfToken")).toHaveLength(64);
  });

  it("does not claim server logout success after the handler clears its cookie on database failure", async () => {
    request
      .mockResolvedValueOnce(csrfResponse())
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "INTERNAL_ERROR" } },
          { status: 503, headers: { "x-auth-session-cleared": "1" } },
        ),
      );
    render(<LogoutButton />);
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "本机登录已清除，服务端退出暂未完成",
    );
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "返回登录" })).toHaveAttribute("href", "/admin/login");
  });

  it("allows retry without claiming cookie cleanup when a service failure has no cleanup receipt", async () => {
    request
      .mockResolvedValueOnce(csrfResponse())
      .mockResolvedValueOnce(Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 503 }));
    render(<LogoutButton />);
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法退出，请重试");
    expect(screen.getByRole("alert")).not.toHaveTextContent("本机登录已清除");
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeEnabled();
    expect(screen.queryByRole("link", { name: "返回登录" })).not.toBeInTheDocument();
  });
});
