"use client";

import { CircleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ErrorStateProps = {
  message: string;
  onRetry?: () => void;
  className?: string;
};

export function ErrorState({ message, onRetry, className }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn("flex min-w-0 items-start gap-3 py-6 text-foreground", className)}
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-destructive" />
      <div className="min-w-0 space-y-4">
        <p className="text-sm leading-6">{message}</p>
        {onRetry ? (
          <Button
            type="button"
            variant="outline"
            onClick={onRetry}
            className="min-h-11 border-input motion-reduce:transition-none"
          >
            重试
          </Button>
        ) : null}
      </div>
    </div>
  );
}
