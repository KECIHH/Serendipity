import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";
import { ADMIN_MIGRATIONS } from "@/server/admin/migration-inventory";

export class AdminReadinessError extends Error {
  constructor(readonly connectionLost = false) {
    super("后台数据结构尚未就绪");
    this.name = "AdminReadinessError";
  }
}
const tables = [
  "User",
  "SystemConfig",
  "TravelRecord",
  "ChatMessage",
  "AuditLog",
  "ApiKeyConfig",
  "AuthSession",
  "AuthLoginAttempt",
  "AdminCommandReceipt",
  "KeyRotationRun",
];
/** Read each time: a missing/drifted migration or table is never an empty dataset. */
export async function assertAdminReadiness(
  client: PrismaClient | Prisma.TransactionClient,
): Promise<void> {
  try {
    const rows = await client.$queryRaw<Array<{ migration_name: string; checksum: string }>>`
      SELECT migration_name, checksum FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count > 0
    `;
    for (const migration of ADMIN_MIGRATIONS) {
      if (
        rows.filter(
          (row) => row.migration_name === migration.name && row.checksum === migration.sha256,
        ).length !== 1
      )
        throw new AdminReadinessError();
    }
    const present = await client.$queryRaw<Array<{ name: string }>>`
      SELECT c.relname AS name FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r'
    `;
    if (tables.some((table) => !present.some((row) => row.name === table)))
      throw new AdminReadinessError();
  } catch (error) {
    throw new AdminReadinessError(
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P1017",
    );
  }
}
