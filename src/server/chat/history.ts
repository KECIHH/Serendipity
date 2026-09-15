import "server-only";
import type { PrismaClient } from "@prisma/client";
import { db } from "@/server/db";
import {
  lockOwnedTravelRecord,
  type OwnedTravelRecordInput,
} from "@/server/repositories/travel-record";
import { DataLayerError } from "@/server/repositories/data-layer-error";

/** Internal history reader: recheck ownership under the same lock, with a bounded recent window. */
export async function getChatHistory(
  input: OwnedTravelRecordInput & { readonly maxMessages?: number },
  client: PrismaClient = db,
) {
  const maxMessages = input.maxMessages ?? 20;
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 100)
    throw new DataLayerError("VALIDATION_ERROR");
  return client.$transaction(async (tx) => {
    await lockOwnedTravelRecord(tx, { owner: input.owner, travelRecordId: input.travelRecordId });
    const recent = await tx.chatMessage.findMany({
      where: { travelRecordId: input.travelRecordId },
      orderBy: { sequence: "desc" },
      take: maxMessages,
    });
    const system = await tx.chatMessage.findFirst({
      where: { travelRecordId: input.travelRecordId, role: "SYSTEM" },
      orderBy: { sequence: "asc" },
    });
    if (system && !recent.some((message) => message.id === system.id)) recent.push(system);
    return recent.sort((a, b) => a.sequence - b.sequence);
  });
}
