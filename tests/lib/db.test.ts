// @vitest-environment node
import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  connectDb,
  DatabaseUnavailableError,
  db,
  getDbClient,
  resetDbClientCacheForTests,
} from "@/server/db";

const fakeClient = (): PrismaClient => ({}) as PrismaClient;
const cacheKey = "__serendipityPrismaClient";
const globals = globalThis as typeof globalThis & { [cacheKey]?: PrismaClient };

beforeEach(() => {
  resetDbClientCacheForTests();
});
afterEach(() => {
  resetDbClientCacheForTests();
  vi.restoreAllMocks();
});

describe("Prisma client lifecycle", () => {
  it("cache: repeated resolutions and module imports reuse one client", async () => {
    const first = fakeClient();
    const secondFactory = vi.fn(fakeClient);
    expect(getDbClient("test", () => first)).toBe(first);
    expect(getDbClient("test", secondFactory)).toBe(first);
    expect(secondFactory).not.toHaveBeenCalled();
    resetDbClientCacheForTests();
    // A real, unconnected PrismaClient survives module cache resets via the explicit hook.
    getDbClient("test", () => db);
    vi.resetModules();
    const reloaded = await import("@/server/db");
    expect(reloaded.db).toBe(db);
    const importedAgain = await import("@/server/db");
    expect(importedAgain.db).toBe(reloaded.db);
    await db.$disconnect();
  });

  it("errors: initialization and connection failures are classified and redacted", async () => {
    const rawUrl = "postgresql://fixture:synthetic-password@invalid.internal:5432/synthetic";
    const raw = new Error(`Driver initialization failed: ${rawUrl}`);
    const logs = [vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "log")];
    const factory = () => {
      throw raw;
    };
    for (const runtime of ["development", "test", "production"] as const) {
      let caught: unknown;
      try {
        getDbClient(runtime, factory);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DatabaseUnavailableError);
      expect(String(caught)).toBe("DatabaseUnavailableError: Database is unavailable");
      expect((caught as Error).cause).toBeUndefined();
      expect((caught as Error).stack).not.toContain(rawUrl);
      expect(globals[cacheKey]).toBeUndefined();
    }
    const failedClient = { $connect: vi.fn().mockRejectedValue(raw) } as unknown as PrismaClient;
    await expect(connectDb(failedClient)).rejects.toMatchObject({
      name: "DatabaseUnavailableError",
      message: "Database is unavailable",
    });
    const healthyClient = {
      $connect: vi.fn().mockResolvedValue(undefined),
    } as unknown as PrismaClient;
    await expect(connectDb(healthyClient)).resolves.toBeUndefined();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("modes: production leaves globals untouched; development and test reuse cache", () => {
    const productionClient = fakeClient();
    const developmentClient = fakeClient();
    expect(getDbClient("production", () => productionClient)).toBe(productionClient);
    expect(Object.hasOwn(globals, cacheKey)).toBe(false);
    expect(getDbClient("development", () => developmentClient)).toBe(developmentClient);
    expect(globals[cacheKey]).toBe(developmentClient);
    expect(getDbClient("test", fakeClient)).toBe(developmentClient);
    expect(getDbClient("production", () => productionClient)).toBe(productionClient);
    expect(globals[cacheKey]).toBe(developmentClient);
  });
});
