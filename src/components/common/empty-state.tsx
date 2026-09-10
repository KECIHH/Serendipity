import { Inbox } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type EmptyStateProps = {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
};

export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <section
      className={cn("flex min-w-0 flex-col items-start gap-4 py-6 text-foreground", className)}
    >
      <Inbox aria-hidden="true" className="size-6 shrink-0 text-foreground/75" />
      <div className="min-w-0 space-y-2">
        <h2 className="text-lg leading-7 font-semibold">{title}</h2>
        {description ? <p className="text-sm leading-6 text-foreground/75">{description}</p> : null}
      </div>
      {action != null ? (
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{action}</div>
      ) : null}
    </section>
  );
}
