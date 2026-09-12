import "server-only";

import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { PublicConfig } from "@/lib/admin-settings";
import { env } from "@/lib/env";
import { stableStringify } from "@/lib/json";
import { assertAdminReadiness } from "@/server/admin/readiness";
import { configDefinition, parseConfig, PUBLIC_CONFIG_KEYS } from "@/server/config/config-registry";

export function configCaps() {
  return { aiTimeoutMs: env.AI_TIMEOUT_MS };
}
export const canonicalConfigHash = (value: unknown) =>
  createHash("sha256").update(stableStringify(value)).digest("hex");
export function createPublicConfigService(databaseUrl = env.DATABASE_URL) {
  const client = new PrismaClient({ datasourceUrl: databaseUrl, log: [] });
  return Object.freeze({
    async read(): Promise<{ data: PublicConfig; etag: string }> {
      await assertAdminReadiness(client);
      // CONFIG_PUBLIC_ALLOWLIST: database visibility and the closed registry are independent gates.
      const rows = await client.systemConfig.findMany({
        where: { isPublic: true, key: { in: [...PUBLIC_CONFIG_KEYS] } },
        select: { key: true, valueJson: true },
        orderBy: { key: "asc" },
      });
      const data: PublicConfig = {
        items: rows.map((row) => {
          const entry = configDefinition(row.key);
          const value = entry.publicProjection(parseConfig(row.key, row.valueJson, configCaps()));
          if (!entry.public || value === null) throw new Error("Invalid public projection");
          return { key: row.key, value };
        }),
      };
      return { data, etag: `W/"${canonicalConfigHash(data)}"` };
    },
    disconnect: () => client.$disconnect(),
  });
}
let service: ReturnType<typeof createPublicConfigService> | undefined;
export function publicConfigService() {
  return (service ??= createPublicConfigService());
}
