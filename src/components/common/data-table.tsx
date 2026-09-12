import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Keep the scroll region at the caller so its label and busy state describe the whole dataset. */
export function DataTable({
  caption,
  children,
  className,
}: {
  caption: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <table className={cn("w-full border-collapse text-left text-sm", className)}>
      <caption className="sr-only">{caption}</caption>
      {children}
    </table>
  );
}
