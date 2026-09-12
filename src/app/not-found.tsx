import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-start justify-center gap-5 px-6 py-16">
      <p className="text-sm text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold">页面未找到</h1>
      <p className="text-muted-foreground">此页面可能已移除，或暂时无法访问。</p>
      <Button asChild className="min-h-11">
        <Link href="/">返回首页</Link>
      </Button>
    </main>
  );
}
