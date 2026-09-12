"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

/** Never render or log framework errors, their digest, request data or stack. */
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section
      role="alert"
      className="mx-auto flex min-h-[50vh] max-w-lg flex-col items-start justify-center gap-5 px-6 py-16"
    >
      <h1 className="text-2xl font-semibold">页面暂时无法加载</h1>
      <p className="text-muted-foreground">请稍后重试。如果问题持续，可以返回首页。</p>
      <div className="flex gap-3">
        <Button onClick={reset} className="min-h-11">
          重试
        </Button>
        <Button asChild variant="outline" className="min-h-11">
          <Link href="/">返回首页</Link>
        </Button>
      </div>
    </section>
  );
}
