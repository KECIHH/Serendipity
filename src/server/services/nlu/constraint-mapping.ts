import type {
  FieldPath,
  NluExtractOutput,
  SpecialFlags,
  TravelRequirement,
} from "@/lib/ai/schema-types";

export type Transport = TravelRequirement["preferences"]["transport"][number];

export interface ConstraintExtraction {
  readonly transport: readonly Transport[];
  readonly hardConstraints: TravelRequirement["preferences"]["hardConstraints"];
  readonly accessibility: TravelRequirement["preferences"]["accessibility"];
  readonly confidence: number;
}

const aliases: readonly (readonly [RegExp, Transport])[] = [
  [/自驾/u, "self_driving"],
  [/高铁/u, "high_speed_rail"],
  [/飞机|飞去|航班/u, "flight"],
  [/公共交通|公交|地铁/u, "public_transit"],
  [/包车/u, "charter"],
  [/徒步/u, "hiking"],
];

export const transportOrder: readonly Transport[] = [
  "self_driving",
  "high_speed_rail",
  "flight",
  "public_transit",
  "charter",
  "hiking",
];

/** Map only spans present in the user text. Derived flags are calculated after merge. */
export function mapConstraints(userInput: string, output: NluExtractOutput): ConstraintExtraction {
  const spans = output.candidates.filter(
    (item) => item.field === "preferences.transport" && userInput.includes(item.text),
  );
  const selected = new Set<Transport>();
  for (const span of spans) {
    for (const [pattern, value] of aliases) {
      if (pattern.test(span.text)) selected.add(value);
    }
  }
  return {
    transport: transportOrder.filter((item) => selected.has(item)),
    hardConstraints: [],
    accessibility: { stepFreeRequired: null, maxWalkingMinutes: null, notes: [] },
    confidence: spans.length
      ? Math.max(...spans.map((item) => Math.max(0, Math.min(1, item.confidence))))
      : 0,
  };
}

export function deriveSpecialFlags(
  requirement: Pick<TravelRequirement, "origin" | "destinations" | "preferences" | "fieldSources">,
): SpecialFlags {
  const explicit =
    requirement.preferences.transport.length > 0 ||
    requirement.fieldSources.some(
      (source) =>
        source.field === "preferences.transport" &&
        ["USER_TEXT", "USER_CONTROL"].includes(source.method),
    );
  const countriesKnown =
    !!requirement.origin?.country &&
    requirement.destinations.length > 0 &&
    requirement.destinations.every((item) => item.country !== null);
  return {
    isSelfDriving: explicit ? requirement.preferences.transport.includes("self_driving") : null,
    isHiking: explicit ? requirement.preferences.transport.includes("hiking") : null,
    isOverseas: countriesKnown
      ? requirement.destinations.some((item) => item.country !== requirement.origin?.country)
      : null,
  };
}

export const fieldOrder: readonly FieldPath[] = [
  "destinations",
  "dateRange",
  "durationDays",
  "travelers",
  "origin",
  "budget",
  "preferences.pace",
  "preferences.interests",
  "preferences.avoid",
  "preferences.transport",
  "preferences.hardConstraints",
  "preferences.accessibility",
  "preferences.consent",
];
