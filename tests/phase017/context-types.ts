import type { NluContext, NluContextInput, createNluContext } from "@/server/ai/nlu-context";
import type { TravelRequirement, TravelPlanSummaryDraft } from "@/lib/ai/schemas";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assignable<A, B> = [A] extends [B] ? true : false;
export type ContextContracts = [
  Assert<Equal<Assignable<Omit<NluContextInput, "signal">, NluContextInput>, false>>,
  Assert<Equal<Assignable<Omit<NluContextInput, "ownerContext">, NluContextInput>, false>>,
  Assert<Equal<Assignable<Omit<NluContextInput, "traceId">, NluContextInput>, false>>,
  Assert<
    Equal<Assignable<Omit<NluContextInput, "tokenBudget" | "costBudget">, NluContextInput>, false>
  >,
  Assert<Equal<Parameters<typeof createNluContext>[1], () => number>>,
  Assert<Equal<NluContext["signal"], AbortSignal>>,
  Assert<Equal<TravelRequirement["schemaVersion"], 1>>,
  Assert<Equal<TravelPlanSummaryDraft["schemaVersion"], 1>>,
  Assert<Equal<TravelRequirement["budget"]["amount"], string | null>>,
];
