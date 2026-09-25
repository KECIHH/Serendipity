// @vitest-environment node
import "./plan-draft-fixture";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  bootstrap,
  businessCounts,
  cookiePair,
  draftBody,
  emptyStages,
  idempotencyKey,
  mockExtract,
  openDb,
  postDraft,
  summaryOutput,
} from "./plan-draft-fixture";

let db: PrismaClient;
const root = path.resolve(import.meta.dirname, "../..");
const forbidden = ["/api/nlu/parse", "/api/nlu/extract", "/api/plan/generate"];

beforeAll(async () => {
  db = await openDb();
}, 120_000);

afterAll(async () => {
  await db.$disconnect();
});

function filesUnder(relative: string): string[] {
  const start = path.join(root, relative);
  if (!fs.existsSync(start)) return [];
  return fs.readdirSync(start, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [child.replaceAll("\\", "/")];
  });
}

describe("plan draft e2e", () => {
  it("丢失响应后同键只读回原收据", async () => {
    const cookie = cookiePair((await bootstrap()).headers.get("set-cookie") ?? "");
    const body = draftBody({ content: "这周末从深圳去武功山", planningMode: "quick" });
    const key = idempotencyKey();
    const overrides = {
      stageOutputs: {
        CORE: mockExtract([
          { field: "origin", text: "深圳", confidence: 1 },
          { field: "destinations", text: "武功山", confidence: 1 },
          { field: "dateRange", text: "这周末", confidence: 1 },
        ]),
        PARAMETERS: mockExtract(),
        CONSTRAINTS: mockExtract(),
      },
      summaryOutput: summaryOutput("武功山行程概要"),
    };
    const first = await postDraft(cookie, body, key, overrides);
    const created = await first.response.json();
    expect(first.response.status).toBe(200);
    const before = await businessCounts(db);
    const second = await postDraft(cookie, body, key, overrides);
    const replayed = await second.response.json();
    expect(second.providerCalls).toBe(0);
    expect(replayed.data).toEqual({ ...created.data, replayed: true });
    expect(await businessCounts(db)).toEqual(before);
  });

  it("三条旧入口没有 route 文件，源码也不引用它们", () => {
    const routes = filesUnder("src/app/api");
    for (const route of forbidden) {
      expect(routes.some((file) => file.includes(`${route}/`))).toBe(false);
      expect(fs.existsSync(path.join(root, "src/app", route, "route.ts"))).toBe(false);
    }
    const source = filesUnder("src").filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
    for (const file of source) {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      for (const route of forbidden) expect(text.includes(route)).toBe(false);
    }
  });
});
