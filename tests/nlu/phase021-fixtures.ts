import { createNluContext, type NluContext } from "@/server/ai/nlu-context";
import { deriveSpecialFlags, mapConstraints } from "@/server/services/nlu/constraint-mapping";
import { emptyRequirement } from "@/server/services/nlu/requirement-snapshot";
import type { NluExtractOutput, TravelRequirement } from "@/lib/ai/schema-types";

export function fixtureContext(
  planningMode: NluContext["planningMode"] = "precise",
  aborted = false,
): NluContext {
  const controller = new AbortController();
  const ctx = createNluContext(
    {
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      planningMode,
      ownerContext: { kind: "SYNTHETIC", runId: "phase021_disposable_000000000000" },
      traceId: "trace_phase021_fixture",
      requestId: "request_phase021_fixture",
      signal: controller.signal,
      deadlineAt: Date.parse("2026-09-03T00:00:30Z"),
      tokenBudget: 1000,
      costBudget: "1",
    },
    () => Date.parse("2026-09-03T00:00:00Z"),
  );
  if (aborted) controller.abort();
  return ctx;
}
export function constraints(text: string, spans: NluExtractOutput["candidates"] = []) {
  return mapConstraints(text, { schemaVersion: 1, candidates: spans });
}
export function requirement(overrides: Partial<TravelRequirement> = {}): TravelRequirement {
  return {
    ...emptyRequirement(),
    ...overrides,
    preferences: { ...emptyRequirement().preferences, ...overrides.preferences },
    travelers: { ...emptyRequirement().travelers, ...overrides.travelers },
    budget: { ...emptyRequirement().budget, ...overrides.budget },
    specialFlags: { ...emptyRequirement().specialFlags, ...overrides.specialFlags },
  };
}

import { source } from "@/server/services/nlu/requirement-snapshot";

const hash = "a".repeat(64);
export function readyRequirement(overrides: Partial<TravelRequirement> = {}): TravelRequirement {
  const value = requirement({
    origin: { city: "深圳", country: "CN", confidence: 1 },
    destinations: [
      {
        id: "destination-1",
        name: "武功山",
        city: null,
        country: "CN",
        type: "attraction",
        confidence: 1,
      },
    ],
    dateRange: {
      startDate: "2026-09-05",
      endDate: "2026-09-07",
      text: "三天",
      isFlexible: false,
      timezone: "Asia/Shanghai",
      confidence: 1,
    },
    durationDays: 3,
    travelers: {
      totalCount: 2,
      adultCount: 2,
      childCount: 0,
      elderCount: 0,
      ageUnknownCount: 0,
      relationship: "couple",
      notes: [],
      hasChild: false,
      hasElder: false,
      isCouple: true,
      isFamily: false,
      confidence: 1,
    },
    budget: {
      amount: "3000",
      currency: "CNY",
      level: null,
      isFlexible: null,
      perPerson: true,
      hardLimit: null,
      confidence: 1,
    },
    preferences: {
      ...emptyRequirement().preferences,
      pace: "moderate",
      interests: ["徒步"],
      confidence: 1,
    },
    ...overrides,
  });
  const draft = value as {
    -readonly [K in keyof TravelRequirement]: TravelRequirement[K] extends ReadonlyArray<infer Item>
      ? Item[]
      : TravelRequirement[K];
  };
  draft.preferences = {
    ...emptyRequirement().preferences,
    ...value.preferences,
    ...(overrides.preferences ?? {}),
  };
  const fields = [
    "origin",
    "destinations",
    "dateRange",
    "durationDays",
    "travelers",
    "budget",
    "preferences.pace",
    "preferences.interests",
  ] as const;
  draft.fieldSources = fields.map((field) => source(field, "USER_TEXT", hash, 1));
  if (draft.preferences.transport.length)
    draft.fieldSources.push(source("preferences.transport", "USER_TEXT", hash, 1));
  draft.specialFlags = deriveSpecialFlags(draft);
  return draft;
}
