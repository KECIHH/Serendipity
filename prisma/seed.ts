import { readSeedEnv } from "../src/lib/env-cli";
import { EnvConfigError } from "../src/lib/env-schema";
import { SeedError } from "../src/server/seed-input";
import { seedDatabase } from "../src/server/services/seed-service";

async function main(): Promise<void> {
  try {
    const result = await seedDatabase(readSeedEnv());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error: unknown) {
    const code =
      error instanceof SeedError
        ? error.code
        : error instanceof EnvConfigError
          ? "INVALID_INPUT"
          : "DATABASE_FAILURE";
    process.stderr.write(`Seed refused: ${code}.\n`);
    process.exitCode = 1;
  }
}

void main();
