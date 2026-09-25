import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";
import {
  canonicalJson,
  PlannerGenerateOutputSchema,
  promptKeyContract,
  TravelPlanSummaryDraftSchema,
  TravelRequirementSchema,
} from "@/lib/ai/schemas";
import type {
  PlannerGenerateOutput,
  PromptSummaryRequirementInput,
  TravelPlanSummaryDraft,
  TravelRequirement,
} from "@/lib/ai/schema-types";
import {
  PLANNER_GENERATE_PROMPT_KEY,
  PLANNER_GENERATE_VARIABLES,
} from "@/lib/ai/prompts/planner-generate";
import { requirementHash, canonicalHash } from "@/server/ai/canonical-hash";
import { guardedJsonChat, type GuardedAiClientOptions } from "@/server/ai/guarded-client";
import { assertNluContext, nluBudgetSnapshot, type NluContext } from "@/server/ai/nlu-context";
import { validateSummaryBinding } from "@/server/ai/summary-binding";
import { db } from "@/server/db";
import {
  defaultCapabilities,
  evaluateRequirementReadiness,
  readinessPolicy,
  type ModuleCapabilities,
  type ReadinessAssumption,
  type RequirementReadiness,
} from "./nlu/detect-missing";

const SERVICE_CODES = [
  "CANCELLED",
  "CONFIG_ERROR",
  "COST_LIMIT",
  "FEATURE_DISABLED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "VALIDATION_ERROR",
] as const;

const INTERESTS = [
  "摄影",
  "美食",
  "徒步",
  "City Walk",
  "滑雪",
  "温泉",
  "博物馆",
  "自然风光",
] as const;
const PACE_WORDS = {
  slow: ["慢节奏", "悠闲"],
  fast: ["快节奏", "特种兵"],
} as const;
const DAY_WORDS: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

export class PlannerServiceError extends Error {
  readonly code: (typeof SERVICE_CODES)[number];
  readonly reason: string;

  constructor(code: PlannerServiceError["code"], reason: string) {
    super(code);
    this.name = "PlannerServiceError";
    this.code = code;
    this.reason = reason;
  }
}

export interface PlannerHandoffManifest {
  readonly schemaVersion: 1;
  readonly handoffStage: "REQUIREMENT_SUMMARY";
  readonly requirementRevision: number;
  readonly requirementHash: string;
  readonly orderedDestinationIds: readonly string[];
  readonly durationDays: number | null;
  readonly assumptions: readonly ReadinessAssumption[];
  readonly confirmationStatus: "READY_FOR_PLANNING";
  readonly formalPlanWritten: false;
  readonly sourceRefs: readonly [];
}

export interface PlannerSummaryResult {
  readonly summary: TravelPlanSummaryDraft;
  readonly handoff: PlannerHandoffManifest;
  readonly replayed: boolean;
}

export interface StoredSummary {
  readonly requirementHash: string;
  readonly result: PlannerSummaryResult;
}

export type SummaryLedger = Map<string, StoredSummary>;

type Options = Omit<GuardedAiClientOptions, "db" | "owner" | "nluContext"> & {
  readonly db?: PrismaClient;
  readonly attemptNo?: number;
  readonly ledger?: SummaryLedger;
  readonly capabilities?: ModuleCapabilities;
};

const processLedger: SummaryLedger = new Map();

function fail(code: PlannerServiceError["code"], reason: string): never {
  throw new PlannerServiceError(code, reason);
}

function asServiceError(error: unknown): never {
  if (error instanceof PlannerServiceError) throw error;
  const code = error instanceof Error ? error.message : "CONFIG_ERROR";
  if ((SERVICE_CODES as readonly string[]).includes(code))
    fail(code as PlannerServiceError["code"], code);
  throw error;
}

function sameVariables(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === PLANNER_GENERATE_VARIABLES.length &&
    PLANNER_GENERATE_VARIABLES.every((expected, index) => {
      const actual = value[index] as Record<string, unknown> | undefined;
      return (
        !!actual &&
        actual.name === expected.name &&
        actual.required === expected.required &&
        actual.nullable === expected.nullable &&
        actual.maxLength === expected.maxLength &&
        actual.delivery === expected.delivery &&
        actual.sensitivity === expected.sensitivity
      );
    })
  );
}

function ownerScope(ctx: NluContext): string {
  const owner = ctx.ownerContext;
  if (owner.kind === "SYNTHETIC") return `SYNTHETIC:${owner.runId}`;
  if (owner.kind === "USER") return `USER:${owner.userId}`;
  return `COMMAND:${owner.commandId}`;
}

function projectSummaryRequirement(requirement: TravelRequirement): PromptSummaryRequirementInput {
  return {
    origin: requirement.origin
      ? { city: requirement.origin.city, country: requirement.origin.country }
      : null,
    destinations: requirement.destinations.map((item) => ({
      name: item.name,
      city: item.city,
      country: item.country,
      type: item.type,
    })),
    dateRange: requirement.dateRange
      ? {
          startDate: requirement.dateRange.startDate,
          endDate: requirement.dateRange.endDate,
          isFlexible: requirement.dateRange.isFlexible,
          timezone: requirement.dateRange.timezone,
        }
      : null,
    durationDays: requirement.durationDays,
    travelers: {
      totalCount: requirement.travelers.totalCount,
      adultCount: requirement.travelers.adultCount,
      childCount: requirement.travelers.childCount,
      elderCount: requirement.travelers.elderCount,
      ageUnknownCount: requirement.travelers.ageUnknownCount,
      relationship: requirement.travelers.relationship,
    },
    budget: {
      amount: requirement.budget.amount,
      currency: requirement.budget.currency,
      level: requirement.budget.level,
      isFlexible: requirement.budget.isFlexible,
      perPerson: requirement.budget.perPerson,
      hardLimit: requirement.budget.hardLimit,
    },
    preferences: {
      pace: requirement.preferences.pace,
      interests: requirement.preferences.interests,
      transport: requirement.preferences.transport,
    },
  };
}

function assumptionLine(item: ReadinessAssumption): string {
  return `${item.field} 使用已登记快速默认值 ${String(item.value)}（${item.reasonCode}），不是用户明确事实。`;
}

function resolveDuration(
  requirement: TravelRequirement,
  readiness: RequirementReadiness,
): number | null {
  if (requirement.durationDays !== null) return requirement.durationDays;
  const assumed = readiness.assumptions.find((item) => item.field === "durationDays");
  return typeof assumed?.value === "number" ? assumed.value : null;
}

function effectivePace(
  requirement: TravelRequirement,
  readiness: RequirementReadiness,
): TravelRequirement["preferences"]["pace"] {
  if (requirement.preferences.pace) return requirement.preferences.pace;
  const assumed = readiness.assumptions.find((item) => item.field === "preferences.pace");
  return assumed?.value === "slow" || assumed?.value === "moderate" || assumed?.value === "fast"
    ? assumed.value
    : null;
}

function durationMentions(text: string): number[] {
  return [...text.matchAll(/(\d{1,3}|[一二两三四五六七八九十])\s*[天日]/gu)].flatMap((match) => {
    const token = match[1] ?? "";
    const value = /^\d+$/.test(token) ? Number(token) : DAY_WORDS[token];
    return value ? [value] : [];
  });
}

function conflicts(
  text: string,
  requirement: TravelRequirement,
  durationDays: number | null,
  pace: TravelRequirement["preferences"]["pace"],
): boolean {
  if (/sourceRefs|已核验|可保存|坐标|票价|经纬度/u.test(text)) return true;
  if (pace === "slow" && PACE_WORDS.fast.some((word) => text.includes(word))) return true;
  if (pace === "fast" && PACE_WORDS.slow.some((word) => text.includes(word))) return true;
  if (
    pace === "moderate" &&
    [...PACE_WORDS.slow, ...PACE_WORDS.fast].some((word) => text.includes(word))
  )
    return true;
  if (
    requirement.preferences.interests.length > 0 &&
    INTERESTS.some(
      (item) => !requirement.preferences.interests.includes(item) && text.includes(item),
    )
  )
    return true;
  if (requirement.preferences.avoid.some((item) => item.trim().length >= 2 && text.includes(item)))
    return true;
  const days = durationMentions(text);
  if (days.some((value) => value !== durationDays)) return true;
  for (const match of text.matchAll(/(\d+(?:\.\d{1,2})?)\s*元/gu)) {
    if (match[1] !== requirement.budget.amount) return true;
  }
  return false;
}

function bindTitle(title: string, requirement: TravelRequirement): string {
  const names = [
    ...requirement.destinations.map((item) => item.name),
    ...(requirement.origin?.city ? [requirement.origin.city] : []),
  ];
  if (names.some((name) => title.includes(name))) return title;
  return Array.from(`${requirement.destinations.map((item) => item.name).join("、")}：${title}`)
    .slice(0, 80)
    .join("");
}

/** Structural draft check. Server binding stays in generateTravelPlanSummary. */
export function validateTravelPlanSummaryDraft(summary: unknown): TravelPlanSummaryDraft {
  return TravelPlanSummaryDraftSchema.parse(summary);
}

async function ensurePlannerPrompt(database: PrismaClient): Promise<void> {
  const contract = promptKeyContract(PLANNER_GENERATE_PROMPT_KEY);
  if (
    !sameVariables(PLANNER_GENERATE_VARIABLES) ||
    !sameVariables(contract.variables) ||
    contract.responseSchemaVersion !== 1
  )
    fail("CONFIG_ERROR", "PROMPT_CONTRACT");
  const definition = await database.promptDefinition.findUnique({
    where: { key: PLANNER_GENERATE_PROMPT_KEY },
    include: { activation: { include: { championVersion: true } } },
  });
  const active = definition?.activation?.championVersion;
  if (!definition || !active || active.responseSchemaVersion !== 1)
    fail("CONFIG_ERROR", "PROMPT_ACTIVATION");
  if (!sameVariables(active.variablesJson) || active.contentHash !== canonicalHash(active.content))
    fail("CONFIG_ERROR", "PROMPT_ACTIVATION");
}

export async function generateTravelPlanSummary(
  requirement: TravelRequirement,
  ctx: NluContext,
  options: Options = {},
): Promise<PlannerSummaryResult> {
  try {
    assertNluContext(ctx);
  } catch (error) {
    const code = error instanceof Error ? error.message : "CONFIG_ERROR";
    if (code === "CANCELLED" || code === "PROVIDER_TIMEOUT") fail(code, code);
    fail("CONFIG_ERROR", "CONTEXT");
  }
  const spent = nluBudgetSnapshot(ctx);
  if (
    spent.tokensUsedOrReserved >= ctx.tokenBudget ||
    new Prisma.Decimal(spent.costUsedOrReserved).gte(ctx.costBudget)
  )
    fail("COST_LIMIT", "BUDGET_EXHAUSTED");
  const rawDestinations = (requirement as { destinations?: unknown } | null)?.destinations;
  if (typeof rawDestinations === "string") fail("VALIDATION_ERROR", "FOLDED_DESTINATION");
  const parsed = TravelRequirementSchema.safeParse(requirement);
  if (!parsed.success) fail("VALIDATION_ERROR", "REQUIREMENT_SCHEMA");
  const snapshot = parsed.data;
  if (snapshot.destinations.length === 0) fail("VALIDATION_ERROR", "EMPTY_DESTINATIONS");
  const { db: callerDb, attemptNo, ledger = processLedger, capabilities, ...guarded } = options;
  const database = callerDb ?? db;
  const policy = await readinessPolicy(database, ctx);
  const readiness = evaluateRequirementReadiness(
    snapshot,
    ctx,
    policy,
    capabilities ?? defaultCapabilities,
  );
  if (readiness.confirmationStatus !== "READY_FOR_PLANNING") fail("VALIDATION_ERROR", "NOT_READY");
  const hash = requirementHash(snapshot);
  const durationDays = resolveDuration(snapshot, readiness);
  const remembered = ledger.get(`${ownerScope(ctx)}:${snapshot.revision}`);
  if (remembered) {
    if (remembered.requirementHash !== hash) fail("VALIDATION_ERROR", "REVISION_HASH_CONFLICT");
    return { ...structuredClone(remembered.result), replayed: true };
  }
  await ensurePlannerPrompt(database);
  const projection = projectSummaryRequirement(snapshot);
  const assumptionSummaries = readiness.assumptions.map(assumptionLine);
  let generated;
  try {
    generated = await guardedJsonChat(
      {
        promptKey: PLANNER_GENERATE_PROMPT_KEY,
        variables: { requirement: projection, assumptionSummaries, locale: ctx.locale },
        userMessage: canonicalJson({ requirement: projection, assumptionSummaries }),
        context: ctx,
        ...(attemptNo ? { attemptNo } : {}),
      },
      { ...guarded, db: database },
    );
  } catch (error) {
    asServiceError(error);
  }
  if (!generated.ok) fail(generated.errorCode, generated.internalCode ?? generated.errorCode);
  let output: PlannerGenerateOutput;
  try {
    output = PlannerGenerateOutputSchema.parse(generated.output);
  } catch (error) {
    asServiceError(error instanceof Error ? new Error("VALIDATION_ERROR") : error);
  }
  const summaryText = [
    output.title,
    output.description,
    output.overallRecommendation,
    output.recommendedReason,
    ...output.bestFor,
  ].join("\n");
  const pace = effectivePace(snapshot, readiness);
  if (conflicts(summaryText, snapshot, durationDays, pace))
    fail("VALIDATION_ERROR", "CONFLICTING_PREFERENCE");
  if (readiness.assumptions.length > 0 && /用户明确|您已确定|你已经确定/u.test(summaryText))
    fail("VALIDATION_ERROR", "ASSUMPTION_AS_FACT");
  const orderedDestinations = snapshot.destinations.map((item) => ({ ...item }));
  const draft = {
    schemaVersion: 1 as const,
    title: bindTitle(output.title, snapshot),
    description: output.description,
    durationDays,
    destinations: orderedDestinations,
    bestFor: [...output.bestFor],
    overallRecommendation: output.overallRecommendation,
    recommendedReason: output.recommendedReason,
    requirementRevision: snapshot.revision,
    requirementHash: hash,
  };
  let summary: TravelPlanSummaryDraft;
  try {
    summary = validateTravelPlanSummaryDraft(draft);
    const assumedDuration = readiness.assumptions.find(
      (item) => item.field === "durationDays" && item.source === "REGISTERED_QUICK_DEFAULT",
    );
    const durationBound =
      summary.durationDays === snapshot.durationDays ||
      (snapshot.durationDays === null &&
        typeof assumedDuration?.value === "number" &&
        summary.durationDays === assumedDuration.value);
    if (
      !durationBound ||
      summary.requirementRevision !== snapshot.revision ||
      summary.requirementHash !== hash ||
      canonicalJson(summary.destinations) !== canonicalJson(snapshot.destinations)
    )
      fail("VALIDATION_ERROR", "BINDING");
    if (summary.durationDays === snapshot.durationDays) validateSummaryBinding(summary, snapshot);
  } catch (error) {
    asServiceError(error);
  }
  const result: PlannerSummaryResult = {
    summary,
    handoff: {
      schemaVersion: 1,
      handoffStage: "REQUIREMENT_SUMMARY",
      requirementRevision: snapshot.revision,
      requirementHash: hash,
      orderedDestinationIds: summary.destinations.map((item) => item.id),
      durationDays,
      assumptions: readiness.assumptions.map((item) => ({ ...item })),
      confirmationStatus: "READY_FOR_PLANNING",
      formalPlanWritten: false,
      sourceRefs: [],
    },
    replayed: false,
  };
  ledger.set(`${ownerScope(ctx)}:${snapshot.revision}`, {
    requirementHash: hash,
    result: structuredClone(result),
  });
  return result;
}
