import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { EnvConfigError, REQUIRED_ENV_KEYS, readEnv } from "@/lib/env";
import { envRegistry, type EnvRegistryEntry } from "@/lib/env-schema";

function validSource(): Record<string, string | undefined> {
  return Object.fromEntries(REQUIRED_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function expectInvalid(source: Record<string, string | undefined>, key: string): void {
  try {
    readEnv(source);
    throw new Error("expected readEnv to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(EnvConfigError);
    expect((error as EnvConfigError).invalid).toContain(key);
  }
}

describe("readEnv", () => {
  it("valid configuration accepts all nine required values and coerces typed values", () => {
    const result = readEnv(validSource());
    expect(Object.isFrozen(result)).toBe(true);
    expect(typeof result.AI_TIMEOUT_MS).toBe("number");
    expect(typeof result.AI_MOCK).toBe("boolean");
  });

  it("reports a missing DATABASE_URL", () => {
    const source = validSource();
    delete source.DATABASE_URL;
    expect(() => readEnv(source)).toThrowError(EnvConfigError);
    try {
      readEnv(source);
    } catch (error) {
      expect((error as EnvConfigError).message).toContain("DATABASE_URL");
      expect((error as EnvConfigError).missing).toContain("DATABASE_URL");
    }
  });

  it("reports two missing values in one error", () => {
    const source = validSource();
    delete source.DATABASE_URL;
    delete source.AUTH_SECRET;
    expect(() => readEnv(source)).toThrowError(EnvConfigError);
    try {
      readEnv(source);
    } catch (error) {
      const configError = error as EnvConfigError;
      expect(configError.missing).toHaveLength(2);
      expect(configError.message).toContain("DATABASE_URL");
      expect(configError.message).toContain("AUTH_SECRET");
    }
  });

  it("rejects a mysql database URL", () => {
    const source = validSource();
    source.DATABASE_URL = "mysql://user:pw@localhost:3306/db";
    expectInvalid(source, "DATABASE_URL");
  });

  it("rejects an AUTH_SECRET shorter than 32 characters", () => {
    const source = validSource();
    source.AUTH_SECRET = "x".repeat(31);
    expectInvalid(source, "AUTH_SECRET");
  });

  it("rejects a 31-byte ENCRYPTION_KEY", () => {
    const source = validSource();
    source.ENCRYPTION_KEY = Buffer.alloc(31, 7).toString("base64");
    expectInvalid(source, "ENCRYPTION_KEY");
  });

  it("accepts a 32-byte ENCRYPTION_KEY", () => {
    const source = validSource();
    source.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    expect(readEnv(source).ENCRYPTION_KEY).toBe(source.ENCRYPTION_KEY);
  });

  it("rejects TRUE for AI_MOCK", () => {
    const source = validSource();
    source.AI_MOCK = "TRUE";
    expectInvalid(source, "AI_MOCK");
  });

  it("API key required when AI_MOCK is false", () => {
    const source = validSource();
    source.AI_MOCK = "false";
    source.AI_API_KEY = "";
    expectInvalid(source, "AI_API_KEY");
  });

  it("mock optional allows an empty AI_API_KEY", () => {
    const source = validSource();
    source.AI_MOCK = "true";
    source.AI_API_KEY = "";
    expect(readEnv(source).AI_API_KEY).toBe("");
  });

  it("rejects http for AI_BASE_URL", () => {
    const source = validSource();
    source.AI_BASE_URL = "http://api.deepseek.com";
    expectInvalid(source, "AI_BASE_URL");
  });

  it("rejects invalid and too-small timeout values", () => {
    const source = validSource();
    source.AI_TIMEOUT_MS = "abc";
    expectInvalid(source, "AI_TIMEOUT_MS");
    source.AI_TIMEOUT_MS = "999";
    expectInvalid(source, "AI_TIMEOUT_MS");
  });

  it("requires a positive cost limit", () => {
    const source = validSource();
    source.AI_DAILY_COST_LIMIT = "0";
    expectInvalid(source, "AI_DAILY_COST_LIMIT");
  });

  it("matches .env.example to the active documented server registry", () => {
    const registryDocument = JSON.parse(
      readFileSync(resolve(process.cwd(), "docs/env-registry.json"), "utf8"),
    ) as EnvRegistryEntry[];
    expect(registryDocument).toEqual(envRegistry);
    const envExample = readFileSync(resolve(process.cwd(), ".env.example"), "utf8");
    const documentedKeys = envExample
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
      .filter((key): key is string => key !== undefined);
    const expectedKeys = registryDocument
      .filter(
        (entry) =>
          entry.documentInExample &&
          entry.producerPhase <= 4 &&
          (entry.scope === "server" || entry.scope === "client"),
      )
      .map((entry) => entry.key);
    expect([...new Set(documentedKeys)].sort()).toEqual([...new Set(expectedKeys)].sort());
    expect(
      registryDocument.filter((entry) => entry.scope === "cli" && entry.documentInExample),
    ).toHaveLength(0);
    expect(
      registryDocument.filter(
        (entry) => entry.scope === "client" && entry.secret && entry.documentInExample,
      ),
    ).toHaveLength(0);
    expect(expectedKeys).toHaveLength(9);
  });
});
