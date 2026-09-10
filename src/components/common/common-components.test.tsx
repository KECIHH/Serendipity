import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EmptyState } from "@/components/common/empty-state";
import { ErrorState } from "@/components/common/error-state";
import { LoadingState } from "@/components/common/loading-state";
import { PageHeader } from "@/components/common/page-header";
import { AdminShell } from "@/components/layout/admin-shell";
import { SiteHeader } from "@/components/layout/site-header";

describe("LoadingState", () => {
  it("announces a polite, busy status with a visible default label", () => {
    render(<LoadingState />);

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("加载中…");
    expect(status.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("renders a custom loading label", () => {
    render(<LoadingState label="正在加载记录" />);

    expect(screen.getByText("正在加载记录")).toBeInTheDocument();
  });
});

describe("EmptyState", () => {
  it("renders its title without adding an empty description paragraph", () => {
    const { container } = render(<EmptyState title="暂无记录" />);

    expect(screen.getByRole("heading", { name: "暂无记录", level: 2 })).toBeInTheDocument();
    expect(container.querySelector("p")).toBeNull();
  });

  it("renders an optional description", () => {
    render(<EmptyState title="暂无记录" description="保存的记录会显示在这里。" />);

    expect(screen.getByText("保存的记录会显示在这里。")).toBeInTheDocument();
  });

  it("renders the action slot", () => {
    render(<EmptyState title="暂无记录" action={<button type="button">创建记录</button>} />);

    expect(screen.getByRole("button", { name: "创建记录" })).toBeInTheDocument();
  });
});

describe("ErrorState", () => {
  it("announces the error message as an alert", () => {
    render(<ErrorState message="加载失败，请稍后重试。" />);

    expect(screen.getByRole("alert")).toHaveTextContent("加载失败，请稍后重试。");
  });

  it("invokes the retry handler once when the retry button is clicked", () => {
    const onRetry = vi.fn();
    render(<ErrorState message="加载失败" onRetry={onRetry} />);

    const retryButton = screen.getByRole("button", { name: "重试" });
    expect(retryButton).toHaveAttribute("type", "button");
    fireEvent.click(retryButton);

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("omits the retry button when there is no retry handler", () => {
    render(<ErrorState message="内容不可用" />);

    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
  });
});

describe("PageHeader", () => {
  it("renders the page title as the level-one heading", () => {
    render(<PageHeader title="记录列表" />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("记录列表");
  });

  it("renders the actions slot", () => {
    render(<PageHeader title="记录列表" actions={<button type="button">刷新记录</button>} />);

    expect(screen.getByRole("button", { name: "刷新记录" })).toBeInTheDocument();
  });
});

describe("layout shells", () => {
  it("links the site name to home and keeps the navigation static", () => {
    render(<SiteHeader />);

    expect(screen.getByRole("link", { name: "Serendipity · 际遇" })).toHaveAttribute("href", "/");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    const navigation = screen.getByRole("navigation", { name: "主导航" });
    expect(navigation).toHaveTextContent("旅行规划");
    expect(navigation).toHaveTextContent("历史计划");
    expect(within(navigation).queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders all four static admin items and preserves its children", () => {
    render(
      <AdminShell>
        <h1>后台内容</h1>
      </AdminShell>,
    );

    const navigation = screen.getByRole("navigation", { name: "后台导航" });
    for (const item of ["概览", "用户", "AI 配置", "审计日志"]) {
      expect(within(navigation).getByText(item)).toBeInTheDocument();
    }
    expect(navigation.querySelector("a, button, [tabindex]")).toBeNull();
    expect(within(screen.getByRole("main")).getByRole("heading", { level: 1 })).toHaveTextContent(
      "后台内容",
    );
  });
});
