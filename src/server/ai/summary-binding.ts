import "server-only";
import {
  canonicalJson,
  TravelRequirementSchema,
  TravelPlanSummaryDraftSchema,
} from "@/lib/ai/schemas";
import { requirementHash } from "./canonical-hash";

/** Structural/reference validation only. Later readiness and formal saving remain separate services. */
export function validateSummaryBinding(summary: unknown, requirement: unknown) {
  const parsed = TravelPlanSummaryDraftSchema.parse(summary);
  const snapshot = TravelRequirementSchema.parse(requirement);
  if (
    parsed.requirementRevision !== snapshot.revision ||
    parsed.requirementHash !== requirementHash(snapshot) ||
    canonicalJson(parsed.destinations) !== canonicalJson(snapshot.destinations) ||
    parsed.durationDays !== snapshot.durationDays
  )
    throw new Error("VALIDATION_ERROR");
  return parsed;
}
