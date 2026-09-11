import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readSeedEnv, readCliEnv } from "@/lib/env-cli";
import { parseSeedInput, SEED_CONFIG_DEFAULTS, SEED_RETRY_DELAYS_MS } from "@/server/seed-input";

const valid = () => ({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:5432/phase010_disposable_abcdefabcdef",
  ADMIN_EMAIL: " Admin@BÜCHER.example ",
  ADMIN_INITIAL_PASSWORD: `${randomBytes(24).toString("base64url")}Aa1!`,
});
describe("seed input guard", () => {
  it("reads only command-scoped inputs without requiring Web secrets", () => {
    const env = valid();
    expect(Object.keys(readSeedEnv(env)).sort()).toEqual(Object.keys(env).sort());
    expect(readCliEnv({}, { currentPhase: 10 })).toEqual({});
    expect(() => readSeedEnv({ NODE_ENV: "test" })).toThrow();
    expect(parseSeedInput(readSeedEnv(env)).email).toBe("admin@xn--bcher-kva.example");
  });
  it("production guard: refuses production and absent or unrecognized environment before connecting", () => {
    for (const NODE_ENV of ["production", "staging", "", "TEST"])
      expect(() => parseSeedInput({ ...valid(), NODE_ENV })).toThrow();
  });
  it("refuses ambiguous URLs, shared targets, role options and duplicate/invalid query controls", () => {
    for (const databaseUrl of [
      "postgresql://fixture:fixture@localhost:5432/phase010_disposable_abcdefabcdef",
      "postgresql://fixture:fixture@127.0.0.1:5432/shared",
      `${valid().DATABASE_URL}?schema=other`,
      `${valid().DATABASE_URL}?options=role%3Downer`,
      `${valid().DATABASE_URL}?connect_timeout=1&connect_timeout=2`,
      `${valid().DATABASE_URL}#fragment`,
      `${valid().DATABASE_URL}?connection_limit=0`,
    ])
      expect(() => parseSeedInput({ ...valid(), DATABASE_URL: databaseUrl })).toThrow();
  });
  it("refuses invalid identity, weak, malformed or over-72-byte passwords without echo", () => {
    for (const password of [
      "short",
      "a".repeat(32),
      "A".repeat(32),
      `${"Aa1!".repeat(19)}`,
      "Aa1!\ud800abcdefghijkl",
      "Aa1!\nabcdefghijkl",
    ]) {
      let safe = false;
      try {
        parseSeedInput({ ...valid(), ADMIN_INITIAL_PASSWORD: password });
      } catch (error) {
        safe = error instanceof Error && error.message === "Seed refused: INVALID_INPUT.";
      }
      expect(safe).toBe(true);
    }
    expect(() => parseSeedInput({ ...valid(), ADMIN_EMAIL: "invalid" })).toThrow();
  });
  it("freezes exactly three internal defaults and three bounded retries", () => {
    expect(SEED_CONFIG_DEFAULTS.map((row) => [row.key, row.valueJson, row.isPublic])).toEqual([
      ["planner.quick.defaultDurationDays", 3, false],
      ["planner.quick.defaultTravelerCount", 1, false],
      ["planner.quick.defaultPace", "moderate", false],
    ]);
    expect(SEED_RETRY_DELAYS_MS).toEqual([25, 50, 100]);
  });
});
