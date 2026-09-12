import Link from "next/link";

import { LoginForm } from "@/components/auth/login-form";

export default function AdminLoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <section
        className="w-full max-w-sm space-y-7 rounded-xl border bg-card p-7 shadow-sm"
        aria-labelledby="admin-login-title"
      >
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Serendipity · 际遇</p>
          <h1 id="admin-login-title" className="text-2xl font-semibold">
            管理员登录
          </h1>
        </div>
        <LoginForm audience="ADMIN" />
        <Link
          href="/"
          className="block text-center text-sm text-muted-foreground underline underline-offset-4"
        >
          返回首页
        </Link>
      </section>
    </main>
  );
}
