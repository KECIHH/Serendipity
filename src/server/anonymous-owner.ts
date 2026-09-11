import "server-only";

import { createHash } from "node:crypto";

import {
  DataLayerError,
  parseDataIdentifier,
  readDataLayerObject,
} from "@/server/repositories/data-layer-error";

declare const anonTokenHashBrand: unique symbol;

export type AnonTokenHash = string & { readonly [anonTokenHashBrand]: "AnonTokenHash" };

export interface AnonymousTravelRecordOwner {
  anonTokenHash: AnonTokenHash;
  userId?: never;
}

export type TravelRecordOwner =
  | { userId: string; anonTokenHash?: never }
  | AnonymousTravelRecordOwner;

function isAnonTokenHash(value: unknown): value is AnonTokenHash {
  return typeof value === "string" && value.length === 64 && !/[^0-9a-f]/.test(value);
}

/** The caller verifies the Cookie envelope; this helper receives only its opaque token. */
export function hashAnonymousToken(rawToken: string): AnonTokenHash {
  if (typeof rawToken !== "string" || rawToken.length !== 43 || /[^A-Za-z0-9_-]/.test(rawToken)) {
    throw new DataLayerError("VALIDATION_ERROR");
  }
  const bytes = Buffer.from(rawToken, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== rawToken) {
    throw new DataLayerError("VALIDATION_ERROR");
  }
  const hash = createHash("sha256").update(rawToken, "utf8").digest("hex");
  if (!isAnonTokenHash(hash)) throw new DataLayerError("INTERNAL_ERROR");
  return hash;
}

export function parseTravelRecordOwner(value: unknown): TravelRecordOwner {
  const owner = readDataLayerObject(value, ["userId", "anonTokenHash"], []);
  if (Object.keys(owner).length !== 1) throw new DataLayerError("VALIDATION_ERROR");
  if (Object.hasOwn(owner, "userId")) {
    return { userId: parseDataIdentifier(owner.userId) };
  }
  if (!isAnonTokenHash(owner.anonTokenHash)) {
    throw new DataLayerError("VALIDATION_ERROR");
  }
  return { anonTokenHash: owner.anonTokenHash };
}
