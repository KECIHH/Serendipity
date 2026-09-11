import { redirect } from "next/navigation";

import { LogoutButton } from "@/components/auth/logout-button";
import { AuthAuthorizationError } from "@/server/auth/errors";
import { requireAdmin } from "@/server/auth/require-admin";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  try {
    await requireAdmin();
  } catch (error: unknown) {
    if (error instanceof AuthAuthorizationError) redirect("/admin/login");
    throw error;
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 p-6">
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">Serendipity · 际遇</p>
        <h1 className="text-2xl font-semibold">登录成功</h1>
        <p className="text-muted-foreground">你已登录管理员账户。</p>
      </div>
      <LogoutButton />
    </main>
  );
}
