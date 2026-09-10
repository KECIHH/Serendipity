import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type PageHeaderProps = {
  title: string;
  actions?: ReactNode;
  className?: string;
};

export function PageHeader({ title, actions, className }: PageHeaderProps) {
  return (
    <header
      className={cn(
        "flex min-w-0 flex-col gap-4 border-b border-border-subtle pb-4 text-foreground sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <h1 className="min-w-0 text-2xl leading-8 font-semibold">{title}</h1>
      {actions != null ? (
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
