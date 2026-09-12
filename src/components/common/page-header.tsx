import type { ReactNode, Ref } from "react";

import { cn } from "@/lib/utils";

type PageHeaderProps = {
  title: string;
  actions?: ReactNode;
  className?: string;
  description?: string;
  titleId?: string;
  titleRef?: Ref<HTMLHeadingElement>;
};

export function PageHeader({
  title,
  actions,
  className,
  description,
  titleId,
  titleRef,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "flex min-w-0 flex-col gap-4 border-b border-border-subtle pb-4 text-foreground sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <h1
          id={titleId}
          ref={titleRef}
          tabIndex={titleRef ? -1 : undefined}
          className="min-w-0 text-2xl leading-8 font-semibold"
        >
          {title}
        </h1>
        {description ? (
          <p className="text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions != null ? (
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
