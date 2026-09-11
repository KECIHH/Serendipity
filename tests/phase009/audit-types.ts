import type { Prisma, PrismaClient } from "@prisma/client";
import { createAuditContext } from "@/server/audit-log";
import {
  writeAuditLog,
  type AuditLogRef,
  type AuditTransactionClient,
} from "@/server/services/audit-log-service";

export async function verifyAuditTypes(
  db: PrismaClient,
  tx: AuditTransactionClient,
): Promise<void> {
  const ordinary = null as unknown as Prisma.TransactionClient;
  // @ts-expect-error Only the server transaction boundary supplies the private provenance brand.
  await writeAuditLog(ordinary, {
    actor: { kind: "SYSTEM", systemActor: "SCHEDULER" },
    action: "CONFIG_UPDATE",
    targetType: "SystemConfig",
  });
  const context = createAuditContext({ trace: true });
  const input = {
    actor: { kind: "SYSTEM", systemActor: "SCHEDULER" },
    action: "CONFIG_UPDATE",
    targetType: "SystemConfig",
    targetId: null,
    context,
  } as const;
  const ref: AuditLogRef = await writeAuditLog(tx, input);
  const timestamp: Date = ref.createdAt;
  void timestamp;
  // @ts-expect-error Global PrismaClient is not an interactive transaction.
  await writeAuditLog(db, input);
  // @ts-expect-error Reversed or arbitrary action codes are not registered.
  await writeAuditLog(tx, { ...input, action: "UPDATE_CONFIG" });
  // @ts-expect-error USER requires its bounded email snapshot.
  await writeAuditLog(tx, { ...input, actor: { kind: "USER", id: "user" } });
  // @ts-expect-error Raw request IDs cannot replace the opaque server context.
  await writeAuditLog(tx, { ...input, context: { requestId: "client" } });
  // @ts-expect-error Safe reference contains no detail payload or actor email.
  void ref.detailJson;
  await writeAuditLog(tx, {
    actor: { kind: "USER", id: "user", emailSnapshot: "user@example.invalid" },
    action: "USER_DISABLE",
    targetType: "User",
  });
}
