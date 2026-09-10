import type { ReactNode } from "react";

type AdminShellProps = {
  children: ReactNode;
};

const navigationItems = ["概览", "用户", "AI 配置", "审计日志"];

export function AdminShell({ children }: AdminShellProps) {
  return (
    <div className="mx-auto flex min-h-screen w-full min-w-0 max-w-[90rem] flex-col bg-surface-muted text-foreground md:flex-row">
      <aside className="w-full shrink-0 border-b border-border-subtle bg-surface p-gutter md:w-56 md:border-r md:border-b-0">
        <h2 className="mb-4 text-lg leading-7 font-semibold">管理后台</h2>
        <nav aria-label="后台导航">
          <ul className="flex flex-wrap gap-2 text-sm md:flex-col">
            {navigationItems.map((item) => (
              <li key={item} className="px-2 py-2">
                {item}
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <main className="min-w-0 flex-1 p-gutter md:p-6">{children}</main>
    </div>
  );
}
