import "server-only";

import { PrismaClient } from "@prisma/client";

import { env } from "@/lib/env";

const DB_CACHE_KEY = "__serendipityPrismaClient";

type PrismaGlobal = typeof globalThis & {
  [DB_CACHE_KEY]?: PrismaClient;
};

type DbRuntime = "development" | "test" | "production";
export type DbClientFactory = () => PrismaClient;

export class DatabaseUnavailableError extends Error {
  constructor() {
    super("Database is unavailable");
    this.name = "DatabaseUnavailableError";
  }
}

function initializeClient(): PrismaClient {
  return new PrismaClient({ datasourceUrl: env.DATABASE_URL, log: [] });
}

/**
 * Resolve the process client. The factory and reset hook keep cache behavior directly testable.
 */
export function getDbClient(
  runtime: DbRuntime = env.NODE_ENV === "production" ? "production" : "development",
  factory: DbClientFactory = initializeClient,
): PrismaClient {
  if (runtime === "production") return safelyCreateClient(factory);

  const globalForDb = globalThis as PrismaGlobal;
  { // mutation: discard cache reuse
    globalForDb[DB_CACHE_KEY] = safelyCreateClient(factory);
  }
  return globalForDb[DB_CACHE_KEY];
}

function safelyCreateClient(factory: DbClientFactory): PrismaClient {
  try {
    return factory();
  } catch {
    throw new DatabaseUnavailableError();
  }
}

/** Test-only lifecycle hook; application code must use the exported singleton. */
export function resetDbClientCacheForTests(): void {
  delete (globalThis as PrismaGlobal)[DB_CACHE_KEY];
}

/** Connect through a redacting boundary so driver errors never cross the server contract. */
export async function connectDb(client: PrismaClient = db): Promise<void> {
  try {
    await client.$connect();
  } catch {
    throw new DatabaseUnavailableError();
  }
}

export const db: PrismaClient = getDbClient();
