import { createHash } from "node:crypto";
import type { FieldPath, FieldSource, TravelRequirement } from "@/lib/ai/schema-types";

export function inputHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function source(
  field: FieldPath,
  method: FieldSource["method"],
  hash: string,
  confidence = method === "DERIVED" || method === "CLEAR" ? 1 : 0,
): FieldSource {
  return { field, messageId: null, inputHash: hash, method, confidence };
}

export function emptyRequirement(revision = 0): TravelRequirement {
  return {
    schemaVersion: 1,
    revision,
    origin: null,
    destinations: [],
    dateRange: null,
    durationDays: null,
    travelers: {
      totalCount: null,
      adultCount: null,
      childCount: null,
      elderCount: null,
      ageUnknownCount: null,
      relationship: null,
      notes: [],
      hasChild: null,
      hasElder: null,
      isCouple: null,
      isFamily: null,
      confidence: 0,
    },
    budget: {
      amount: null,
      currency: null,
      level: null,
      isFlexible: null,
      perPerson: null,
      hardLimit: null,
      confidence: 0,
    },
    preferences: {
      pace: null,
      interests: [],
      avoid: [],
      transport: [],
      hardConstraints: [],
      accessibility: { stepFreeRequired: null, maxWalkingMinutes: null, notes: [] },
      consent: { sensitiveRequirementProcessing: null },
      confidence: 0,
    },
    specialFlags: { isSelfDriving: null, isHiking: null, isOverseas: null },
    fieldSources: [],
    missingFields: [],
  };
}
