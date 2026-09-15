import "server-only";
import { createHash } from "node:crypto";
import type { Prisma, TravelRecord } from "@prisma/client";
import { parseTravelRecordOwner, type TravelRecordOwner } from "@/server/anonymous-owner";
import { ChatCommandError } from "./error-codes";

/** Phase082 may register consumed-token and historical-alias lookups here. No future table is read. */
export interface OwnerExtensions {
  consumed(tx: Prisma.TransactionClient, anonTokenHash: string): Promise<boolean>;
  aliases(tx: Prisma.TransactionClient, userId: string): Promise<readonly string[]>;
}
let extensions: OwnerExtensions = {
  consumed: async () => false,
  aliases: async () => [],
};
export function registerOwnerExtensions(next: OwnerExtensions): () => void {
  const prior = extensions;
  extensions = next;
  return () => {
    extensions = prior;
  };
}
export function ownerKeyHash(input: TravelRecordOwner): string {
  const owner = parseTravelRecordOwner(input);
  return createHash("sha256")
    .update(owner.userId !== undefined ? "USER:" + owner.userId : "ANON:" + owner.anonTokenHash)
    .digest("hex");
}
export async function ownerDomains(
  tx: Prisma.TransactionClient,
  input: TravelRecordOwner,
): Promise<string[]> {
  const owner = parseTravelRecordOwner(input);
  if (owner.anonTokenHash !== undefined && (await extensions.consumed(tx, owner.anonTokenHash)))
    throw new ChatCommandError("NOT_FOUND", 404);
  const aliases = owner.userId === undefined ? [] : await extensions.aliases(tx, owner.userId);
  if (aliases.some((hash) => !/^[0-9a-f]{64}$/.test(hash)))
    throw new ChatCommandError("CONFIG_ERROR", 503);
  return [...new Set([ownerKeyHash(owner), ...aliases])];
}
const requestChecks = new WeakMap<object, (tx: Prisma.TransactionClient) => Promise<void>>();
export function bindOwnerAuthorization(
  owner: TravelRecordOwner,
  check: (tx: Prisma.TransactionClient) => Promise<void>,
) {
  requestChecks.set(owner, check);
  return owner;
}
export async function authorizeRecord(
  tx: Prisma.TransactionClient,
  input: { owner: TravelRecordOwner; travelRecordId: string; write?: boolean },
): Promise<TravelRecord> {
  const owner = parseTravelRecordOwner(input.owner);
  await requestChecks.get(input.owner)?.(tx);
  if (owner.anonTokenHash !== undefined) {
    // Anonymous merge/accept use the same ordering: anonymous domain, then record.
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      "anon:" + owner.anonTokenHash,
    );
  }
  await ownerDomains(tx, owner);
  const rows = await tx.$queryRawUnsafe<TravelRecord[]>(
    'SELECT * FROM "TravelRecord" WHERE id=$1 FOR UPDATE',
    input.travelRecordId,
  );
  const record = rows[0];
  if (
    !record ||
    (owner.userId !== undefined
      ? record.userId !== owner.userId || record.anonTokenHash !== null
      : record.anonTokenHash !== owner.anonTokenHash || record.userId !== null)
  )
    throw new ChatCommandError("NOT_FOUND", 404);
  if (owner.userId !== undefined) {
    await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id=$1 FOR SHARE', owner.userId);
    const user = await tx.user.findUnique({
      where: { id: owner.userId },
      select: { status: true },
    });
    if (!user || user.status !== "ACTIVE") throw new ChatCommandError("NOT_FOUND", 404);
  }
  if (input.write && record.status === "ARCHIVED") throw new ChatCommandError("NOT_FOUND", 404);
  return record;
}
export async function authorizeCommand(
  tx: Prisma.TransactionClient,
  owner: TravelRecordOwner,
  commandId: string,
  write = false,
) {
  const found = await tx.chatCommand.findUnique({ where: { id: commandId } });
  if (!found) throw new ChatCommandError("NOT_FOUND", 404);
  await authorizeRecord(tx, { owner, travelRecordId: found.travelRecordId, write });
  return tx.chatCommand.findUniqueOrThrow({ where: { id: commandId } });
}
export async function authorizeWorkerCommand(tx: Prisma.TransactionClient, commandId: string) {
  const command = await tx.chatCommand.findUnique({ where: { id: commandId } });
  if (!command) throw new ChatCommandError("NOT_FOUND", 404);
  const record = await tx.travelRecord.findUnique({ where: { id: command.travelRecordId } });
  if (!record) throw new ChatCommandError("NOT_FOUND", 404);
  const owner = parseTravelRecordOwner(
    record.userId !== null ? { userId: record.userId } : { anonTokenHash: record.anonTokenHash },
  );
  await authorizeRecord(tx, { owner, travelRecordId: record.id, write: true });
  if (!(await ownerDomains(tx, owner)).includes(command.ownerKeyHash))
    throw new ChatCommandError("NOT_FOUND", 404);
  return { command: await tx.chatCommand.findUniqueOrThrow({ where: { id: command.id } }), owner };
}
