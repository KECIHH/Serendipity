import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardClient } from "@/components/admin/dashboard-client";
import { RECORD_STATUSES } from "@/lib/admin-dashboard";

const data = {
  widgets: {
    users: { status: "ok", data: { total: 9, active: 7 } },
    configs: { status: "ok", data: { total: 3, public: 0 } },
    travelRecords: {
      status: "ok",
      data: {
        total: 0,
        byStatus: Object.fromEntries(RECORD_STATUSES.map((status) => [status, 0])),
      },
    },
    recentAudits: { status: "ok", data: [] },
  },
};
const reply = (payload: unknown, status = 200) =>
  ({
    ok: status === 200,
    json: async () => ({
      success: status === 200,
      data: payload,
      error: { message: "PRIVATE_DATABASE_DIAGNOSTIC" },
    }),
  }) as Response;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("admin/dashboard error display", () => {
  it("[dashboard] shows independent failure without fabricating zero and keeps the other cards usable", async () => {
    const partial = {
      widgets: {
        ...data.widgets,
        users: { status: "error", error: { code: "INTERNAL_ERROR", requestId: "fixture-query" } },
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(partial)));
    render(<DashboardClient />);
    const users = await screen.findByRole("region", { name: "用户" });
    expect(within(users).getByRole("alert")).toHaveTextContent("fixture-query");
    expect(within(users).queryByText("0")).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "系统配置" })).getByText("3"),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "暂无旅行记录" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "暂无审计记录" })).toBeInTheDocument();
  });
  it("[dashboard] distinguishes loading and whole-database failure, then retries actual returned counts", async () => {
    let resolve!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((done) => {
              resolve = done;
            }),
        )
        .mockResolvedValueOnce(reply(data)),
    );
    render(<DashboardClient />);
    expect(screen.getByRole("status")).toHaveTextContent("正在加载后台概览");
    resolve(reply(null, 503));
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法读取");
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.queryByText("PRIVATE_DATABASE_DIAGNOSTIC")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("9")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });
});
