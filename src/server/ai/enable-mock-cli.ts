import "server-only";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { bootstrapAiGovernance, enableMockAi } from "@/server/services/ai-governance-service";

async function main() {
  const index = process.argv.indexOf("--fixture-config");
  if (index < 0 || !process.argv[index + 1]) throw new Error("CONFIG_ERROR");
  const config = JSON.parse(fs.readFileSync(path.resolve(process.argv[index + 1]), "utf8")) as {
    database: string;
    appUrl: string;
  };
  const client = new PrismaClient({ datasourceUrl: config.appUrl, log: [] });
  try {
    const actor = await client.user.findUnique({
      where: { email: "phase015-admin@serendipity.invalid" },
    });
    if (!actor) throw new Error("CONFIG_ERROR");
    await client.$transaction((tx) => bootstrapAiGovernance(tx));
    const result = await enableMockAi(client, {
      actorId: actor.id,
      runId: config.database,
      databaseUrl: config.appUrl,
    });
    process.stdout.write(`${JSON.stringify({ ...result, productionRequests: 0 })}\n`);
  } finally {
    await client.$disconnect();
  }
}
void main().catch(() => {
  process.stderr.write("AI mock enablement failed safely.\n");
  process.exitCode = 1;
});
