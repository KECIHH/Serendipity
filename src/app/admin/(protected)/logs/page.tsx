import { redirect } from "next/navigation";
import { LogsClient } from "@/components/admin/logs-client";
import { AuthAuthorizationError } from "@/server/auth/errors";
import { requireAdmin } from "@/server/auth/require-admin";

export const dynamic = "force-dynamic";
export default async function AdminLogsPage() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof AuthAuthorizationError) redirect("/admin/login");
    throw error;
  }
  return <LogsClient />;
}
