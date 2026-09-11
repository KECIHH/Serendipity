import "server-only";

import { Prisma, type TravelRecord } from "@prisma/client";

import {
  parseTravelRecordOwner,
  type AnonymousTravelRecordOwner,
  type TravelRecordOwner,
} from "@/server/anonymous-owner";
import { db } from "@/server/db";
import {
  DataLayerError,
  parseDataIdentifier,
  readDataLayerObject,
  requireAbsentJson,
  runDataLayerOperation,
} from "@/server/repositories/data-layer-error";

export interface OwnedTravelRecordInput {
  owner: TravelRecordOwner;
  travelRecordId: string;
}

export interface CreateTravelRecordInput {
  owner: TravelRecordOwner;
  title: string;
  requirementJson?: null;
}

export interface TransferAnonymousTravelRecordInput {
  owner: AnonymousTravelRecordOwner;
  travelRecordId: string;
  userId: string;
}

function ownerWhere(owner: TravelRecordOwner): Prisma.TravelRecordWhereInput {
  return owner.userId !== undefined
    ? { userId: owner.userId, anonTokenHash: null }
    : { userId: null, anonTokenHash: owner.anonTokenHash };
}

function cleanTitle(value: unknown): string {
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new DataLayerError("VALIDATION_ERROR");
  }
  const plain = value.replace(/<[^>]*>/gu, " ").replace(/[<>]/gu, " ");
  const title = Array.from(plain)
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  if (title.length === 0) throw new DataLayerError("VALIDATION_ERROR");
  return title;
}

export async function createTravelRecord(input: CreateTravelRecordInput): Promise<TravelRecord> {
  const fields = readDataLayerObject(
    input,
    ["owner", "title", "requirementJson"],
    ["owner", "title"],
  );
  const owner = parseTravelRecordOwner(fields.owner);
  const title = cleanTitle(fields.title);
  requireAbsentJson(fields.requirementJson);
  return runDataLayerOperation(() =>
    db.travelRecord.create({
      data: { ...owner, title, requirementJson: Prisma.DbNull },
    }),
  );
}

export async function getTravelRecord(input: OwnedTravelRecordInput): Promise<TravelRecord> {
  const fields = readDataLayerObject(
    input,
    ["owner", "travelRecordId"],
    ["owner", "travelRecordId"],
  );
  const owner = parseTravelRecordOwner(fields.owner);
  const travelRecordId = parseDataIdentifier(fields.travelRecordId);
  return runDataLayerOperation(async () => {
    const record = await db.travelRecord.findFirst({
      where: { id: travelRecordId, ...ownerWhere(owner) },
    });
    if (!record) throw new DataLayerError("NOT_FOUND");
    return record;
  });
}

/** All operations on an existing record share its lock with later owner transfers. */
export async function lockOwnedTravelRecord(
  transaction: Prisma.TransactionClient,
  input: OwnedTravelRecordInput,
): Promise<TravelRecord> {
  const fields = readDataLayerObject(
    input,
    ["owner", "travelRecordId"],
    ["owner", "travelRecordId"],
  );
  const owner = parseTravelRecordOwner(fields.owner);
  const travelRecordId = parseDataIdentifier(fields.travelRecordId);
  return runDataLayerOperation(async () => {
    const records =
      owner.userId !== undefined
        ? await transaction.$queryRaw<TravelRecord[]>`
            SELECT * FROM "TravelRecord"
            WHERE id = ${travelRecordId}
              AND "userId" = ${owner.userId} AND "anonTokenHash" IS NULL
            FOR UPDATE
          `
        : await transaction.$queryRaw<TravelRecord[]>`
            SELECT * FROM "TravelRecord"
            WHERE id = ${travelRecordId}
              AND "userId" IS NULL AND "anonTokenHash" = ${owner.anonTokenHash}
            FOR UPDATE
          `;
    const record = records[0];
    if (!record) throw new DataLayerError("NOT_FOUND");
    return record;
  });
}

/** This row primitive does not consume anonymous credentials or implement merge receipts. */
export async function transferAnonymousTravelRecordToUser(
  input: TransferAnonymousTravelRecordInput,
): Promise<TravelRecord> {
  const fields = readDataLayerObject(
    input,
    ["owner", "travelRecordId", "userId"],
    ["owner", "travelRecordId", "userId"],
  );
  const owner = parseTravelRecordOwner(fields.owner);
  if (owner.anonTokenHash === undefined) throw new DataLayerError("VALIDATION_ERROR");
  const travelRecordId = parseDataIdentifier(fields.travelRecordId);
  const userId = parseDataIdentifier(fields.userId);
  return runDataLayerOperation(() =>
    db.$transaction(async (transaction) => {
      await lockOwnedTravelRecord(transaction, { owner, travelRecordId });
      return transaction.travelRecord.update({
        where: { id: travelRecordId },
        data: { userId, anonTokenHash: null },
      });
    }),
  );
}
