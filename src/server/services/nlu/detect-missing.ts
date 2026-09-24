import type { PrismaClient } from "@prisma/client";
import type { FieldPath, TravelRequirement } from "@/lib/ai/schema-types";
import type { NluContext } from "@/server/ai/nlu-context";
import { fieldOrder } from "./constraint-mapping";

export interface RequirementReadinessPolicy {
  readonly planningMode: "quick" | "precise";
  readonly quickDefaults: {
    readonly durationDays: number;
    readonly travelerCount: number;
    readonly pace: "slow" | "moderate" | "fast";
  };
}

export interface ModuleCapabilities {
  readonly selfDriving: boolean | null;
  readonly hiking: boolean | null;
  readonly overseas: boolean | null;
}

export interface MissingFieldSpec {
  readonly field: FieldPath;
  readonly priority: "blocking" | "normal" | "optional";
  readonly reasonCode: string;
}

export interface ReadinessAssumption {
  readonly field: FieldPath;
  readonly value: number | string;
  readonly source: "REGISTERED_QUICK_DEFAULT";
  readonly reasonCode: string;
}

export interface ModuleDecision {
  readonly module: "destination" | "self_driving" | "hiking" | "overseas";
  readonly status: "allowed" | "blocked" | "unknown";
  readonly reasonCode: string;
}

export interface RequirementReadiness {
  readonly missingSpecs: readonly MissingFieldSpec[];
  readonly assumptions: readonly ReadinessAssumption[];
  readonly moduleDecisions: readonly ModuleDecision[];
  readonly confirmationStatus: "NEEDS_INFORMATION" | "READY_FOR_PLANNING";
}

const priorityRank = { blocking: 0, normal: 1, optional: 2 } as const;

function domestic(requirement: Partial<TravelRequirement>): boolean | null {
  const destinations = requirement.destinations ?? [];
  if (!destinations.length || destinations.some((item) => item.country === null)) return null;
  return destinations.every((item) => item.country === "CN");
}

function add(
  specs: MissingFieldSpec[],
  field: FieldPath,
  priority: MissingFieldSpec["priority"],
  reasonCode: string,
) {
  if (!specs.some((item) => item.field === field)) specs.push({ field, priority, reasonCode });
}

function knownTravelers(requirement: Partial<TravelRequirement>): boolean {
  const people = requirement.travelers;
  return people?.totalCount !== null && people?.totalCount !== undefined;
}

function knownDuration(requirement: Partial<TravelRequirement>): boolean {
  return requirement.durationDays !== null && requirement.durationDays !== undefined;
}

/** Project every readiness gap. Callers must not truncate this list before admission. */
export function evaluateRequirementReadiness(
  requirement: Partial<TravelRequirement>,
  ctx: NluContext,
  policy: RequirementReadinessPolicy,
  capabilities: ModuleCapabilities,
): RequirementReadiness {
  if (policy.planningMode !== ctx.planningMode) throw new Error("CONFIG_ERROR");
  const specs: MissingFieldSpec[] = [];
  const assumptions: ReadinessAssumption[] = [];
  const decisions: ModuleDecision[] = [];
  const destinations = requirement.destinations ?? [];
  const resolvable = destinations.some((item) => item.name.trim() && item.confidence >= 0.5);
  if (!resolvable) {
    add(specs, "destinations", "blocking", "DESTINATION_UNRESOLVED");
    decisions.push({
      module: "destination",
      status: "blocked",
      reasonCode: "DESTINATION_UNRESOLVED",
    });
  } else
    decisions.push({
      module: "destination",
      status: "allowed",
      reasonCode: "DESTINATION_RESOLVED",
    });

  const precise = ctx.planningMode === "precise";
  if (!requirement.dateRange?.startDate) {
    if (precise) add(specs, "dateRange", "blocking", "DATE_REQUIRED");
    else
      assumptions.push({
        field: "dateRange",
        value: ctx.serverDate,
        source: "REGISTERED_QUICK_DEFAULT",
        reasonCode: "QUICK_RELATIVE_DATE",
      });
  }
  if (!knownDuration(requirement) && !requirement.dateRange?.startDate) {
    if (precise) add(specs, "durationDays", "blocking", "DURATION_REQUIRED");
    else
      assumptions.push({
        field: "durationDays",
        value: policy.quickDefaults.durationDays,
        source: "REGISTERED_QUICK_DEFAULT",
        reasonCode: "QUICK_DEFAULT_DURATION",
      });
  }
  if (!knownTravelers(requirement)) {
    if (precise) add(specs, "travelers", "blocking", "TRAVELERS_REQUIRED");
    else
      assumptions.push({
        field: "travelers",
        value: policy.quickDefaults.travelerCount,
        source: "REGISTERED_QUICK_DEFAULT",
        reasonCode: "QUICK_DEFAULT_TRAVELERS",
      });
  }
  const home = domestic(requirement);
  if (!requirement.origin && home === true)
    add(specs, "origin", "optional", "DOMESTIC_ORIGIN_UNKNOWN");
  else if (precise && !requirement.origin && home !== true)
    add(specs, "origin", "blocking", "ORIGIN_REQUIRED");
  if (requirement.budget?.amount === null || requirement.budget?.amount === undefined) {
    if (precise) add(specs, "budget", "normal", "BUDGET_UNKNOWN");
    else
      assumptions.push({
        field: "budget",
        value: "unknown",
        source: "REGISTERED_QUICK_DEFAULT",
        reasonCode: "QUICK_BUDGET_UNKNOWN",
      });
  }
  if (!requirement.preferences?.pace && !precise)
    assumptions.push({
      field: "preferences.pace",
      value: policy.quickDefaults.pace,
      source: "REGISTERED_QUICK_DEFAULT",
      reasonCode: "QUICK_DEFAULT_PACE",
    });
  if (
    precise &&
    (requirement.preferences?.interests.length ?? 0) === 0 &&
    !requirement.fieldSources?.some((item) => item.field === "preferences.interests")
  ) {
    add(specs, "preferences.interests", "normal", "PREFERENCES_EMPTY");
  }

  const modules = [
    ["self_driving", "selfDriving", "preferences.transport"],
    ["hiking", "hiking", "preferences.transport"],
    ["overseas", "overseas", "destinations"],
  ] as const;
  const requested = {
    self_driving: requirement.preferences?.transport.includes("self_driving") === true,
    hiking: requirement.preferences?.transport.includes("hiking") === true,
    overseas: requirement.specialFlags?.isOverseas === true,
  };
  for (const [module, capability, field] of modules) {
    if (!requested[module]) continue;
    const available = capabilities[capability];
    if (available === true)
      decisions.push({ module, status: "allowed", reasonCode: "CAPABILITY_AVAILABLE" });
    else {
      add(
        specs,
        field,
        "blocking",
        available === false ? "SAFETY_CAPABILITY_UNAVAILABLE" : "SAFETY_CAPABILITY_UNKNOWN",
      );
      decisions.push({
        module,
        status: available === false ? "blocked" : "unknown",
        reasonCode:
          available === false ? "SAFETY_CAPABILITY_UNAVAILABLE" : "SAFETY_CAPABILITY_UNKNOWN",
      });
    }
  }
  const missingSpecs = [...specs].sort(
    (left, right) =>
      priorityRank[left.priority] - priorityRank[right.priority] ||
      fieldOrder.indexOf(left.field) - fieldOrder.indexOf(right.field),
  );
  return {
    missingSpecs,
    assumptions,
    moduleDecisions: decisions,
    confirmationStatus: missingSpecs.some((item) => item.priority === "blocking")
      ? "NEEDS_INFORMATION"
      : "READY_FOR_PLANNING",
  };
}

export function detectMissingFields(
  requirement: Partial<TravelRequirement>,
  ctx: NluContext,
  policy: RequirementReadinessPolicy,
  capabilities: ModuleCapabilities,
): MissingFieldSpec[] {
  return [...evaluateRequirementReadiness(requirement, ctx, policy, capabilities).missingSpecs];
}

export async function readinessPolicy(
  database: PrismaClient,
  ctx: NluContext,
): Promise<RequirementReadinessPolicy> {
  const keys = [
    "planner.quick.defaultDurationDays",
    "planner.quick.defaultTravelerCount",
    "planner.quick.defaultPace",
  ] as const;
  const rows = await database.systemConfig.findMany({ where: { key: { in: [...keys] } } });
  const value = (key: (typeof keys)[number]) => rows.find((item) => item.key === key)?.valueJson;
  const durationDays = value(keys[0]);
  const travelerCount = value(keys[1]);
  const pace = value(keys[2]);
  if (
    typeof durationDays !== "number" ||
    typeof travelerCount !== "number" ||
    (pace !== "slow" && pace !== "moderate" && pace !== "fast")
  )
    throw new Error("CONFIG_ERROR");
  return { planningMode: ctx.planningMode, quickDefaults: { durationDays, travelerCount, pace } };
}

export const defaultCapabilities: ModuleCapabilities = {
  selfDriving: null,
  hiking: null,
  overseas: null,
};
