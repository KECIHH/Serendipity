import { redirect } from "next/navigation";

import { UsersClient } from "@/components/admin/users-client";
import { AuthAuthorizationError } from "@/server/auth/errors";
import { requireAdmin } from "@/server/auth/require-admin";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  let principal;
  try {
    principal = await requireAdmin();
  } catch (error: unknown) {
    if (error instanceof AuthAuthorizationError) redirect("/admin/login");
    throw error;
  }
  return <UsersClient currentUserId={principal.id} />;
}
