import type { ApiKeyConfig, ApiKeyStatus, Prisma } from "@prisma/client";

export const status: ApiKeyStatus = "REVOKED";
export const accepted: Prisma.ApiKeyConfigCreateInput = {
  name: "Synthetic type fixture",
  provider: "synthetic",
  encryptedKey: "runtime-validated",
  encryptionKeyId: "runtime-validated",
  keyFingerprint: "runtime-validated",
};
export function requiredFields(row: ApiKeyConfig): [string, number, Date | null] {
  return [row.encryptionKeyId, row.revision, row.revokedAt];
}
// @ts-expect-error API key storage is global, not per-user.
accepted.userId = "forbidden";
// @ts-expect-error Short display fingerprints are derived at runtime, never stored.
accepted.maskedKey = "forbidden";
