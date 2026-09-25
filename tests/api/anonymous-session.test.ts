// @vitest-environment node
import "./plan-draft-fixture";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { bootstrap, businessCounts, cookiePair, openDb } from "./plan-draft-fixture";

let db: PrismaClient;

beforeAll(async () => {
  db = await openDb();
}, 120_000);

afterAll(async () => {
  await db.$disconnect();
});

describe("anonymous session", () => {
  it("anonymous bootstrap 只下发安全 Cookie 且不写业务表", async () => {
    const before = await businessCounts(db);
    const first = await bootstrap();
    const setCookie = first.headers.get("set-cookie") ?? "";
    const body = await first.json();
    expect(first.status).toBe(200);
    expect(body.data).toEqual({ anonymousSessionReady: true });
    expect(setCookie).toMatch(/anon_token=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(JSON.stringify(body)).not.toContain(cookiePair(setCookie).split("=")[1] ?? "missing");
    expect(await businessCounts(db)).toEqual(before);

    const second = await bootstrap(cookiePair(setCookie));
    const again = second.headers.get("set-cookie") ?? "";
    expect(second.status).toBe(200);
    expect(cookiePair(again)).toBe(cookiePair(setCookie));
    expect(await businessCounts(db)).toEqual(before);
  });
});
