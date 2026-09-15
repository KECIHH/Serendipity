// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { buildContext, truncateContext, type Message } from "@/lib/ai/context-manager";
import {
  createNluContext,
  assertNluContext,
  reserveNluBudget,
  nluBudgetSnapshot,
  type NluContext,
  type NluContextInput,
} from "@/server/ai/nlu-context";

const system = { role: "system" as const, content: "保留这条规则" };
const input = (overrides: Partial<NluContextInput> = {}): NluContextInput => ({
  timezone: "Asia/Shanghai",
  locale: "zh-CN",
  planningMode: "precise",
  ownerContext: { kind: "SYNTHETIC", runId: "phase017_disposable_111111111111" },
  traceId: "trace_unit",
  requestId: "request_unit",
  signal: new AbortController().signal,
  deadlineAt: Date.parse("2026-09-16T00:00:30Z"),
  tokenBudget: 100,
  costBudget: "1",
  ...overrides,
});

describe("context limits", () => {
  it("truncation: system and newest turns survive message limits without mutating history", () => {
    const messages: readonly Message[] = Object.freeze(
      [
        system,
        { role: "user", content: "old" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "latest" },
      ].map((row) => Object.freeze(row)) as Message[],
    );
    const before = JSON.stringify(messages);
    const result = truncateContext(messages, { maxMessages: 2, maxChars: 100 });
    expect(result.ok, "SYSTEM_RETENTION_REQUIRED").toBe(true);
    if (result.ok)
      expect(result.messages, "SYSTEM_RETENTION_REQUIRED").toEqual([system, messages[3]]);
    expect(JSON.stringify(messages)).toBe(before);
  });
  it("truncation: empty history, stable sequence, Unicode and character bounds", () => {
    expect(buildContext([], "规则", { maxMessages: 1, maxChars: 2 })).toMatchObject({
      ok: true,
      messages: [{ role: "system", content: "规则" }],
      chars: 2,
    });
    const result = buildContext(
      [
        { role: "ASSISTANT", content: "😀😀", sequence: 2 },
        { role: "USER", content: "older", sequence: 1 },
      ],
      "规则",
      { maxMessages: 3, maxChars: 4 },
    );
    expect(result).toMatchObject({
      ok: true,
      messages: [
        { role: "system", content: "规则" },
        { role: "assistant", content: "😀😀" },
      ],
      chars: 4,
    });
    expect(
      buildContext(
        [
          { role: "USER", content: "a", sequence: 1 },
          { role: "ASSISTANT", content: "b", sequence: 1 },
        ],
        "规则",
        { maxMessages: 3, maxChars: 20 },
      ),
    ).toEqual({ ok: false, errorCode: "CONFIG_ERROR" });
  });
  it("truncation: impossible system limits fail instead of deleting rules", () => {
    for (const limits of [
      { maxMessages: 0, maxChars: 10 },
      { maxMessages: 2, maxChars: 1 },
      { maxMessages: NaN, maxChars: 10 },
    ])
      expect(truncateContext([system], limits)).toEqual({ ok: false, errorCode: "CONFIG_ERROR" });
    expect(
      truncateContext([{ role: "user", content: "user" }], { maxMessages: 1, maxChars: 10 }),
    ).toEqual({ ok: false, errorCode: "CONFIG_ERROR" });
    expect(
      truncateContext([system, { role: "system", content: "second rule" }], {
        maxMessages: 1,
        maxChars: 50,
      }),
    ).toEqual({ ok: false, errorCode: "CONFIG_ERROR" });
  });
  it("truncation: one immutable context carries the local date signal and server identity", () => {
    let now = Date.parse("2026-09-15T23:59:59Z");
    const data = input(),
      context = createNluContext(data, () => now);
    expect(context.serverDate).toBe("2026-09-16");
    expect(context.signal).toBe(data.signal);
    expect(Object.keys(context).sort()).toEqual(
      [
        "serverDate",
        "timezone",
        "locale",
        "planningMode",
        "ownerContext",
        "traceId",
        "requestId",
        "signal",
        "deadlineAt",
        "tokenBudget",
        "costBudget",
      ].sort(),
    );
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.ownerContext)).toBe(true);
    now += 1500;
    assertNluContext(context);
    expect(context.serverDate).toBe("2026-09-16");
    expect(() => assertNluContext({ ...context } as NluContext)).toThrow("CONFIG_ERROR");
    for (const key of ["signal", "traceId", "requestId", "tokenBudget", "costBudget"] as const) {
      const missing = { ...data } as Partial<NluContextInput>;
      delete missing[key];
      expect(() => createNluContext(missing as NluContextInput, () => now)).toThrow("CONFIG_ERROR");
    }
    for (const key of ["traceId", "requestId"] as const)
      for (const value of [undefined, null, 123, {}]) {
        expect(() =>
          createNluContext({ ...data, [key]: value } as NluContextInput, () => now),
        ).toThrow("CONFIG_ERROR");
      }
    for (const ownerContext of [
      {
        kind: "COMMAND",
        commandId: 1,
        lease: { taskId: "task", leaseOwner: "worker", fencingToken: 1 },
      },
      {
        kind: "COMMAND",
        commandId: "command",
        lease: { taskId: 1, leaseOwner: "worker", fencingToken: 1 },
      },
      {
        kind: "COMMAND",
        commandId: "command",
        lease: { taskId: "task", leaseOwner: 1, fencingToken: 1 },
      },
    ])
      expect(() =>
        createNluContext({ ...data, ownerContext } as unknown as NluContextInput, () => now),
      ).toThrow("CONFIG_ERROR");
    expect(() => createNluContext(data, undefined as unknown as () => number)).toThrow(
      "CONFIG_ERROR",
    );
  });
  it("truncation: concurrent consumers share token cost cancellation and deadline limits", () => {
    let now = Date.parse("2026-09-16T00:00:00Z");
    const controller = new AbortController(),
      context = createNluContext(input({ signal: controller.signal }), () => now);
    const first = reserveNluBudget(context, 60, new Prisma.Decimal("0.6"));
    expect(() => reserveNluBudget(context, 50, new Prisma.Decimal("0.1"))).toThrow("COST_LIMIT");
    expect(() => reserveNluBudget(context, 1, new Prisma.Decimal("0.5"))).toThrow("COST_LIMIT");
    first.settle();
    expect(nluBudgetSnapshot(context)).toEqual({
      tokensUsedOrReserved: 60,
      costUsedOrReserved: "0.6",
    });
    first.settle({ tokens: 0, cost: new Prisma.Decimal(0) });
    expect(nluBudgetSnapshot(context).tokensUsedOrReserved).toBe(60);
    now += 31000;
    expect(() => assertNluContext(context)).toThrow("PROVIDER_TIMEOUT");
    controller.abort();
    expect(() => assertNluContext(context)).toThrow("CANCELLED");
  });
});
