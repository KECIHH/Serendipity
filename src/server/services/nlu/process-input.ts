import "server-only";

import type { PrismaClient } from "@prisma/client";
import { canonicalJson } from "@/lib/ai/schemas";
import type { FieldPath, MissingField, TravelRequirement } from "@/lib/ai/schema-types";
import type { GuardedAiClientOptions } from "@/server/ai/guarded-client";
import type { NluContext } from "@/server/ai/nlu-context";
import { db } from "@/server/db";
import { extractCoreEntities } from "./extract-core-entities";
import { extractTravelParameters } from "./extract-parameters";
import { extractConstraints } from "./extract-constraints";
import {
  mergeRequirements,
  replayOrMerge,
  type MergeResult,
  type PatchLedger,
  type RequirementPatch,
} from "./merge-requirements";
import { defaultCapabilities, readinessPolicy, type ModuleCapabilities } from "./detect-missing";
import { emptyRequirement, inputHash } from "./requirement-snapshot";

export type RequirementStatus = "DRAFT" | "NEEDS_INFO";
export interface NluProcessResult {
  readonly requirement: TravelRequirement;
  readonly missingFields: readonly MissingField[];
  readonly questions: readonly string[];
  readonly confirmationStatus: "NEEDS_INFORMATION" | "READY_FOR_PLANNING";
  readonly recordStatus: RequirementStatus;
}
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Options = Omit<GuardedAiClientOptions, "db" | "owner" | "nluContext"> & {
  readonly db?: PrismaClient;
  readonly capabilities?: ModuleCapabilities;
  readonly calls?: { count: number };
  readonly ledger?: PatchLedger;
  readonly stageOutputs?: Partial<Record<"CORE" | "PARAMETERS" | "CONSTRAINTS", string>>;
};

function meaningful(value: Json): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object")
    return Object.values(value).some((item) => meaningful(item as Json));
  return value !== null;
}
function at(requirement: TravelRequirement, field: FieldPath): Json {
  return field
    .split(".")
    .reduce<unknown>((item, key) => (item as Record<string, unknown>)[key], requirement) as Json;
}

function patchFrom(
  current: TravelRequirement | null,
  extracted: TravelRequirement,
  userInput: string,
): RequirementPatch {
  const set: Partial<Record<FieldPath, Json>> = {};
  const clearFields: FieldPath[] = [];
  const base = current ?? emptyRequirement();
  const scalarFields = [
    "origin",
    "dateRange",
    "durationDays",
    "travelers",
    "budget",
    "preferences.pace",
  ] as const satisfies readonly FieldPath[];
  const arrayFields = [
    "destinations",
    "preferences.interests",
    "preferences.avoid",
    "preferences.transport",
  ] as const satisfies readonly FieldPath[];
  const withdraw = /清空|取消|不要了|撤回/.test(userInput);
  if (!withdraw) {
    for (const field of scalarFields) {
      const value = at(extracted, field);
      if (canonicalJson(value) !== canonicalJson(at(base, field)) && meaningful(value))
        set[field] = value;
    }
  }
  if (withdraw) {
    for (const field of [...scalarFields, ...arrayFields]) {
      if (meaningful(at(base, field))) clearFields.push(field);
    }
  }
  const arrayOps = withdraw
    ? []
    : arrayFields.flatMap((field) => {
        const values = at(extracted, field);
        return Array.isArray(values) && values.length
          ? [{ field, op: "add" as const, values }]
          : [];
      });
  return { baseRevision: base.revision, set, clearFields, arrayOps };
}

export function requirementStatus(missingFields: readonly MissingField[]): RequirementStatus {
  return missingFields.some((item) => item.priority === "blocking") ? "NEEDS_INFO" : "DRAFT";
}

/** Run all extractors through one guarded patch. Cancellation stops before any downstream call. */
export async function processNLUInput(
  userInput: string,
  existingRequirement: TravelRequirement | null,
  baseRevision: number,
  ctx: NluContext,
  options: Options = {},
): Promise<NluProcessResult> {
  if (ctx.signal.aborted) throw new Error("CANCELLED");
  const current = existingRequirement ?? emptyRequirement(baseRevision);
  if (current.revision !== baseRevision) throw new Error("VERSION_CONFLICT");
  const database = options.db ?? db;
  const calls = options.calls ?? { count: 0 };
  const tracked = {
    ...options,
    db: database,
    onDebugCapture: () => {
      calls.count += 1;
    },
  };
  const staged = (stage: "CORE" | "PARAMETERS" | "CONSTRAINTS", attemptNo: number) => ({
    ...tracked,
    ...(options.stageOutputs?.[stage] === undefined
      ? {}
      : { mockOutput: options.stageOutputs[stage] }),
    attemptNo,
  });
  const core = await extractCoreEntities(userInput, ctx, staged("CORE", 1));
  if (ctx.signal.aborted) throw new Error("CANCELLED");
  const parameters = await extractTravelParameters(userInput, ctx, staged("PARAMETERS", 2));
  if (ctx.signal.aborted) throw new Error("CANCELLED");
  const constraints = await extractConstraints(userInput, ctx, staged("CONSTRAINTS", 3));
  const extracted = emptyRequirement();
  const draft = {
    ...extracted,
    origin: core.origin,
    destinations: [...core.destinations],
    dateRange: core.dateRange,
    travelers: parameters.travelers,
    budget: parameters.budget,
    preferences: {
      ...parameters.preferences,
      transport: [...constraints.transport],
      hardConstraints: [...constraints.hardConstraints],
      accessibility: constraints.accessibility,
    },
  };
  const patch = patchFrom(current, draft, userInput);
  const mergeOptions = {
    database,
    capabilities: options.capabilities ?? defaultCapabilities,
    hash: inputHash(userInput),
    policy: await readinessPolicy(database, ctx),
    attemptNo: 4,
  };
  const merged = options.ledger
    ? await replayOrMerge(options.ledger, current, patch, ctx, mergeOptions)
    : await mergeRequirements(current, patch, ctx, mergeOptions);
  if (!merged.ok) throw new Error(merged.code);
  return {
    requirement: merged.requirement,
    missingFields: merged.missingFields,
    questions: merged.questions,
    confirmationStatus: merged.missingFields.some((item) => item.priority === "blocking")
      ? "NEEDS_INFORMATION"
      : "READY_FOR_PLANNING",
    recordStatus: requirementStatus(merged.missingFields),
  };
}

export type { MergeResult };
