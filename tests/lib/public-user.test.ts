// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSystemConfigGroup, SYSTEM_CONFIG_GROUPS } from "@/lib/schemas/system-config";
import { ADMIN_USER_FIELDS, ADMIN_USER_SELECT } from "@/server/projections/admin-user";
import { PUBLIC_USER_FIELDS, PUBLIC_USER_SELECT } from "@/server/projections/public-user";
import {
  EXPECTED_ADMIN_USER_FIELDS,
  EXPECTED_PUBLIC_USER_FIELDS,
} from "../phase007/config-fixture";

describe("public-user projection contract", () => {
  it("projection: public fields are exactly the eight authorized account fields", () => {
    expect(PUBLIC_USER_FIELDS).toEqual(EXPECTED_PUBLIC_USER_FIELDS);
    expect(new Set(PUBLIC_USER_FIELDS).size).toBe(8);
    for (const field of ["passwordHash", "sessionVersion", "phone", "revision"]) {
      expect(PUBLIC_USER_FIELDS).not.toContain(field);
      expect(PUBLIC_USER_SELECT).not.toHaveProperty(field);
    }
  });

  it("projection: admin fields add only the management revision", () => {
    expect(ADMIN_USER_FIELDS).toEqual(EXPECTED_ADMIN_USER_FIELDS);
    expect(new Set(ADMIN_USER_FIELDS).size).toBe(9);
    expect(ADMIN_USER_FIELDS.slice(0, -1)).toEqual(PUBLIC_USER_FIELDS);
    for (const field of ["passwordHash", "sessionVersion", "phone"]) {
      expect(ADMIN_USER_FIELDS).not.toContain(field);
      expect(ADMIN_USER_SELECT).not.toHaveProperty(field);
    }
  });

  it("projection: immutable Prisma selects contain only their exact whitelist", () => {
    expect(Object.keys(PUBLIC_USER_SELECT)).toEqual(EXPECTED_PUBLIC_USER_FIELDS);
    expect(Object.keys(ADMIN_USER_SELECT)).toEqual(EXPECTED_ADMIN_USER_FIELDS);
    expect(Object.values(PUBLIC_USER_SELECT)).toEqual(Array(8).fill(true));
    expect(Object.values(ADMIN_USER_SELECT)).toEqual(Array(9).fill(true));
    expect(Object.isFrozen(PUBLIC_USER_SELECT)).toBe(true);
    expect(Object.isFrozen(ADMIN_USER_SELECT)).toBe(true);
  });

  it("projection: both runtime projection modules retain the server-only boundary", () => {
    for (const file of ["public-user.ts", "admin-user.ts"]) {
      const source = readFileSync(
        new URL(`../../src/server/projections/${file}`, import.meta.url),
        "utf8",
      );
      expect(source).toMatch(/^import "server-only";/);
      expect(source).toContain("as const satisfies readonly (keyof User)[]");
    }
  });
});

describe("SystemConfig group schema", () => {
  it("group-validation: the closed group registry contains exactly five values", () => {
    expect(SYSTEM_CONFIG_GROUPS).toEqual(["AI", "UI", "EXPORT", "SECURITY", "GENERAL"]);
  });

  it.each(["AI", "UI", "EXPORT", "SECURITY", "GENERAL"])(
    "group-validation: parses the registered group %s",
    (group) => {
      expect(parseSystemConfigGroup(group)).toBe(group);
    },
  );

  it.each(["UNKNOWN", "general", " GENERAL ", "", null, undefined, 7, {}, [], ["GENERAL"]])(
    "group-validation: rejects unregistered runtime input %j",
    (input) => {
      expect(() => parseSystemConfigGroup(input)).toThrow(TypeError);
      expect(() => parseSystemConfigGroup(input)).toThrow("System configuration group is invalid");
    },
  );
});
