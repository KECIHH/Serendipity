import { redirect } from "next/navigation";

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
  redirect("/admin/users");
}
