import { redirect } from "next/navigation";
import { SettingsClient } from "@/components/admin/settings-client";
import { AuthAuthorizationError } from "@/server/auth/errors";
import { requireAdmin } from "@/server/auth/require-admin";

export const dynamic = "force-dynamic";
export default async function AdminSettingsPage() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof AuthAuthorizationError) redirect("/admin/login");
    throw error;
  }
  return <SettingsClient />;
}
