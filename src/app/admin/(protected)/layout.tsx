import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AdminShell } from "@/components/layout/admin-shell";
import { AuthAuthorizationError } from "@/server/auth/errors";
import { requireAdmin } from "@/server/auth/require-admin";

export const dynamic = "force-dynamic";

export default async function ProtectedAdminLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  let principal;
  try {
    principal = await requireAdmin();
  } catch (error: unknown) {
    if (error instanceof AuthAuthorizationError) redirect("/admin/login");
    throw error;
  }

  return (
    <AdminShell currentUser={{ id: principal.id, email: principal.email }}>{children}</AdminShell>
  );
}
