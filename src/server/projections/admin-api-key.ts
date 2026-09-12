import "server-only";

import { Prisma } from "@prisma/client";
import { parseApiKeyDto, type ApiKeyDto, type ApiKeyStatus } from "@/lib/admin-api-keys";

export interface AdminApiKeyRow {
  id: string;
  name: string;
  provider: string;
  keyFingerprintDisplay: string;
  status: ApiKeyStatus;
  revision: number;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** PostgreSQL derives the display; full fingerprints and envelopes never enter a list projection. */
export const ADMIN_API_KEY_COLUMNS = Prisma.sql`
  id, name, provider, left("keyFingerprint"::text,12) || '…' AS "keyFingerprintDisplay",
  status, revision, "lastUsedAt", "revokedAt", "createdAt", "updatedAt"
`;

export function adminApiKeyDto(row: AdminApiKeyRow): ApiKeyDto {
  return parseApiKeyDto({
    id: row.id,
    name: row.name,
    provider: row.provider,
    keyFingerprintDisplay: row.keyFingerprintDisplay,
    status: row.status,
    revision: row.revision,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export async function readAdminApiKey(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<ApiKeyDto | null> {
  const rows = await tx.$queryRaw<AdminApiKeyRow[]>(Prisma.sql`
    SELECT ${ADMIN_API_KEY_COLUMNS} FROM "ApiKeyConfig" WHERE id=${id}
  `);
  return rows.length === 1 ? adminApiKeyDto(rows[0]) : null;
}
