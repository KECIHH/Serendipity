import { LoaderCircle } from "lucide-react";

import { cn } from "@/lib/utils";

type LoadingStateProps = {
  label?: string;
  className?: string;
};

export function LoadingState({ label = "加载中…", className }: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn("flex min-w-0 items-center gap-2 py-6 text-sm text-foreground", className)}
    >
      <LoaderCircle aria-hidden="true" className="size-5 shrink-0 motion-safe:animate-spin" />
      <span className="min-w-0 leading-6">{label}</span>
    </div>
  );
}
