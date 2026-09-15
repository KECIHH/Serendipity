import "server-only";
import { Prisma } from "@prisma/client";
import { validScalarFormat } from "@/lib/ai/schema-validation";
import type { AiOwnerContext } from "./guarded-client";

interface NluContextFields {
  readonly serverDate: string;
  readonly timezone: string;
  readonly locale: string;
  readonly planningMode: "quick" | "precise";
  readonly ownerContext: AiOwnerContext;
  readonly traceId: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly tokenBudget: number;
  readonly costBudget: string;
}
declare const contextBrand: unique symbol;
export type NluContext = Readonly<NluContextFields> & { readonly [contextBrand]: true };
export type NluContextInput = Omit<NluContextFields, "serverDate">;
interface ContextState {
  readonly clock: () => number;
  tokens: number;
  cost: Prisma.Decimal;
}
const states = new WeakMap<NluContext, ContextState>();
function fail(code = "CONFIG_ERROR"): never {
  throw new Error(code);
}
function exact(value: object, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("|") !== [...fields].sort().join("|")
  )
    fail();
}
function ownerSnapshot(owner: AiOwnerContext): AiOwnerContext {
  if (!owner || typeof owner !== "object") return fail();
  if (owner.kind === "SYNTHETIC") {
    exact(owner, ["kind", "runId"]);
    if (
      typeof owner.runId !== "string" ||
      !/^phase\d{3}_disposable_[a-f0-9]{12}$/.test(owner.runId)
    )
      fail();
    return Object.freeze({ ...owner });
  }
  if (owner.kind === "USER") {
    exact(owner, ["kind", "userId", "privateInputAllowed"]);
    if (
      typeof owner.userId !== "string" ||
      !owner.userId ||
      typeof owner.privateInputAllowed !== "boolean"
    )
      fail();
    return Object.freeze({ ...owner });
  }
  if (owner.kind === "COMMAND") {
    exact(owner, ["kind", "commandId", "lease"]);
    exact(owner.lease, ["taskId", "leaseOwner", "fencingToken"]);
    if (
      typeof owner.commandId !== "string" ||
      !owner.commandId ||
      typeof owner.lease.taskId !== "string" ||
      !owner.lease.taskId ||
      typeof owner.lease.leaseOwner !== "string" ||
      !owner.lease.leaseOwner ||
      !Number.isSafeInteger(owner.lease.fencingToken) ||
      owner.lease.fencingToken < 1
    )
      fail();
    return Object.freeze({ ...owner, lease: Object.freeze({ ...owner.lease }) });
  }
  return fail();
}

/** Only a server entry point supplies identity, clock and limits; model output is never accepted here. */
export function createNluContext(input: NluContextInput, clock: () => number): NluContext {
  exact(input, [
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
  ]);
  if (
    typeof clock !== "function" ||
    typeof input.timezone !== "string" ||
    typeof input.locale !== "string" ||
    !validScalarFormat(input.timezone, "iana-timezone") ||
    !validScalarFormat(input.locale, "bcp47-locale") ||
    !["quick", "precise"].includes(input.planningMode) ||
    !(input.signal instanceof AbortSignal) ||
    !Number.isSafeInteger(input.deadlineAt) ||
    !Number.isSafeInteger(input.tokenBudget) ||
    input.tokenBudget < 1 ||
    input.tokenBudget > 10_000_000 ||
    typeof input.costBudget !== "string" ||
    !/^(?:0|[1-9]\d{0,7})(?:\.\d{1,8})?$/.test(input.costBudget) ||
    typeof input.traceId !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.traceId) ||
    typeof input.requestId !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.requestId)
  )
    fail();
  const now = clock();
  if (!Number.isSafeInteger(now) || input.deadlineAt <= now || input.deadlineAt - now > 3600000)
    fail();
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: input.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (name: string) => parts.find((item) => item.type === name)?.value;
  const serverDate = `${part("year")?.padStart(4, "0")}-${part("month")}-${part("day")}`;
  if (!validScalarFormat(serverDate, "date")) fail();
  const context = Object.freeze({
    ...input,
    serverDate,
    ownerContext: ownerSnapshot(input.ownerContext),
  }) as NluContext;
  states.set(context, { clock, tokens: 0, cost: new Prisma.Decimal(0) });
  return context;
}
export function assertNluContext(context: NluContext): void {
  const state = states.get(context);
  if (!state) fail();
  if (context.signal.aborted) fail("CANCELLED");
  if (state.clock() >= context.deadlineAt) fail("PROVIDER_TIMEOUT");
}
export function nluRemainingMilliseconds(context: NluContext): number {
  assertNluContext(context);
  return context.deadlineAt - states.get(context)!.clock();
}
export function reserveNluBudget(context: NluContext, tokens: number, cost: Prisma.Decimal) {
  assertNluContext(context);
  const state = states.get(context)!;
  if (!Number.isSafeInteger(tokens) || tokens < 0 || !cost.isFinite() || cost.isNegative()) fail();
  if (state.tokens + tokens > context.tokenBudget || state.cost.add(cost).gt(context.costBudget))
    fail("COST_LIMIT");
  state.tokens += tokens;
  state.cost = state.cost.add(cost);
  let settled = false;
  return {
    settle(actual?: { tokens: number; cost: Prisma.Decimal }) {
      if (settled) return;
      settled = true;
      // Missing/untrusted usage keeps the reserved upper bound; cancellation never creates free spend.
      if (
        actual &&
        Number.isSafeInteger(actual.tokens) &&
        actual.tokens >= 0 &&
        actual.tokens <= tokens &&
        actual.cost.isFinite() &&
        !actual.cost.isNegative() &&
        actual.cost.lte(cost)
      ) {
        state.tokens -= tokens - actual.tokens;
        state.cost = state.cost.sub(cost).add(actual.cost);
      }
    },
  };
}
export function nluBudgetSnapshot(context: NluContext) {
  const state = states.get(context);
  if (!state) return fail();
  return Object.freeze({
    tokensUsedOrReserved: state.tokens,
    costUsedOrReserved: state.cost.toString(),
  });
}
