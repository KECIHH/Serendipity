"use client";

import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AdminPagination({
  summary,
  previousDisabled,
  nextDisabled,
  onPrevious,
  onNext,
}: {
  summary: ReactNode;
  previousDisabled: boolean;
  nextDisabled: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <nav
      aria-label="列表分页"
      className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground"
    >
      <p aria-live="polite">{summary}</p>
      <div className="flex gap-2 text-foreground">
        <Button
          type="button"
          variant="outline"
          className="min-h-11 border-input motion-reduce:transition-none"
          disabled={previousDisabled}
          onClick={onPrevious}
          aria-label="上一页"
        >
          <ChevronLeft aria-hidden="true" />
          上一页
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 border-input motion-reduce:transition-none"
          disabled={nextDisabled}
          onClick={onNext}
          aria-label="下一页"
        >
          下一页
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
