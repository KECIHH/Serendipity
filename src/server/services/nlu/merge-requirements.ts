import { canonicalJson, TravelRequirementSchema } from "@/lib/ai/schemas";
import type { FieldPath, MissingField, TravelRequirement } from "@/lib/ai/schema-types";
import type { NluContext } from "@/server/ai/nlu-context";
import { deriveSpecialFlags } from "./constraint-mapping";
import { askMissingFields } from "./ask-missing";
import {
  defaultCapabilities,
  evaluateRequirementReadiness,
  readinessPolicy,
  type ModuleCapabilities,
  type RequirementReadinessPolicy,
} from "./detect-missing";
import { emptyRequirement, source } from "./requirement-snapshot";

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export interface RequirementPatch {
  readonly baseRevision: number;
  readonly set: Readonly<Partial<Record<FieldPath, Json>>>;
  readonly clearFields: readonly FieldPath[];
  readonly arrayOps: readonly {
    readonly field: FieldPath;
    readonly op: "add" | "remove" | "replace";
    readonly values: readonly Json[];
  }[];
}
export type MergeResult =
  | {
      readonly ok: true;
      readonly requirement: TravelRequirement;
      readonly nextRevision: number;
      readonly diff: readonly {
        readonly field: FieldPath;
        readonly before: Json;
        readonly after: Json;
      }[];
      readonly missingFields: readonly MissingField[];
      readonly questions: readonly string[];
    }
  | {
      readonly ok: false;
      readonly status: 409;
      readonly code: "VERSION_CONFLICT";
      readonly currentRevision: number;
      readonly reload: true;
    };

const arrayFields = new Set([
  "destinations",
  "preferences.interests",
  "preferences.avoid",
  "preferences.transport",
  "preferences.hardConstraints",
]);
const scalarFields = new Set<FieldPath>([
  "origin",
  "destinations",
  "dateRange",
  "durationDays",
  "travelers",
  "budget",
  "preferences.pace",
  "preferences.interests",
  "preferences.avoid",
  "preferences.transport",
  "preferences.hardConstraints",
  "preferences.accessibility",
  "preferences.consent",
]);

function valueAt(requirement: TravelRequirement, field: FieldPath): Json {
  return field
    .split(".")
    .reduce<unknown>((item, key) => (item as Record<string, unknown>)[key], requirement) as Json;
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
function stable(value: Json): string {
  return canonicalJson(value);
}
function setValue(target: TravelRequirement, field: FieldPath, value: Json) {
  const names = field.split(".");
  const parent = names
    .slice(0, -1)
    .reduce<
      Record<string, unknown>
    >((item, key) => item[key] as Record<string, unknown>, target as unknown as Record<string, unknown>);
  parent[names.at(-1)!] = value;
}
function cleared(field: FieldPath): Json {
  if (["origin", "dateRange", "durationDays", "preferences.pace"].includes(field)) return null;
  if (field === "travelers") return emptyRequirement().travelers as unknown as Json;
  if (field === "budget") return emptyRequirement().budget as unknown as Json;
  if (field === "preferences.accessibility")
    return emptyRequirement().preferences.accessibility as unknown as Json;
  if (field === "preferences.consent") return { sensitiveRequirementProcessing: false };
  return [];
}
function idOf(item: Json): string | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
  const id = (item as { readonly id?: Json }).id;
  return typeof id === "string" ? id : null;
}
function clearsKnown(before: Json, after: Json): boolean {
  if (after === null) return before !== null;
  if (typeof after !== "object") return false;
  if (Array.isArray(after)) {
    if (!Array.isArray(before)) return false;
    return after.some((item) => {
      const id = idOf(item);
      const previous = id
        ? before.find((entry) => idOf(entry) === id)
        : before.find((entry) => stable(entry) === stable(item));
      return previous ? clearsKnown(previous, item) : false;
    });
  }
  if (before === null || typeof before !== "object" || Array.isArray(before)) return false;
  const prior = before as { readonly [key: string]: Json };
  return Object.entries(after).some(([key, value]) =>
    clearsKnown(prior[key] ?? null, value as Json),
  );
}
function validateArray(
  field: FieldPath,
  current: readonly Json[],
  op: RequirementPatch["arrayOps"][number],
) {
  if (!arrayFields.has(field)) throw new Error("VALIDATION_ERROR");
  if (op.op === "replace") return [...op.values];
  const next = [...current];
  for (const value of op.values) {
    const id = idOf(value);
    const index = id
      ? next.findIndex((item) => idOf(item) === id)
      : next.findIndex((item) => stable(item) === stable(value));
    if (op.op === "remove") {
      if (index < 0) throw new Error("VALIDATION_ERROR");
      next.splice(index, 1);
    } else if (index >= 0) {
      if (stable(next[index]) !== stable(value)) throw new Error("VALIDATION_ERROR");
    } else next.push(value);
  }
  return next;
}

/** Apply one explicit patch. The supplied snapshot is never mutated. */
export async function mergeRequirements(
  current: TravelRequirement,
  patch: RequirementPatch,
  ctx: NluContext,
  options: {
    readonly policy?: RequirementReadinessPolicy;
    readonly capabilities?: ModuleCapabilities;
    readonly hash?: string;
    readonly database?: Parameters<typeof readinessPolicy>[0];
    readonly skipMissing?: boolean;
    readonly attemptNo?: number;
  } = {},
): Promise<MergeResult> {
  if (patch.baseRevision !== current.revision)
    return {
      ok: false,
      status: 409,
      code: "VERSION_CONFLICT",
      currentRevision: current.revision,
      reload: true,
    };
  const clearFields = [...patch.clearFields];
  if (
    clearFields.includes("dateRange") &&
    !Object.hasOwn(patch.set, "durationDays") &&
    !clearFields.includes("durationDays") &&
    current.fieldSources.some((item) => item.field === "durationDays" && item.method === "DERIVED")
  )
    clearFields.push("durationDays");
  const fields = [
    ...Object.keys(patch.set),
    ...clearFields,
    ...patch.arrayOps.map((item) => item.field),
  ];
  if (
    new Set(fields).size !== fields.length ||
    fields.some((field) => !scalarFields.has(field as FieldPath))
  )
    throw new Error("VALIDATION_ERROR");
  const next = clone(current) as {
    -readonly [K in keyof TravelRequirement]: TravelRequirement[K] extends ReadonlyArray<infer Item>
      ? Item[]
      : TravelRequirement[K];
  };
  const hash = options.hash ?? "0".repeat(64);
  const diff: { field: FieldPath; before: Json; after: Json }[] = [];
  for (const [field, value] of Object.entries(patch.set) as [FieldPath, Json][]) {
    const before = valueAt(current, field);
    if (clearsKnown(before, value)) throw new Error("VALIDATION_ERROR");
    setValue(next, field, clone(value));
    next.fieldSources.push(source(field, "USER_CONTROL", hash, 1));
    diff.push({ field, before, after: value });
  }
  for (const field of clearFields) {
    const before = valueAt(current, field);
    const after = cleared(field);
    setValue(next, field, clone(after));
    next.fieldSources.push(source(field, "CLEAR", hash));
    diff.push({ field, before, after });
  }
  for (const operation of patch.arrayOps) {
    const before = valueAt(current, operation.field);
    if (!Array.isArray(before)) throw new Error("VALIDATION_ERROR");
    const after = validateArray(operation.field, before, operation);
    setValue(next, operation.field, after);
    next.fieldSources.push(
      source(
        operation.field,
        operation.op === "remove" || (operation.op === "replace" && !operation.values.length)
          ? "CLEAR"
          : "USER_CONTROL",
        hash,
        1,
      ),
    );
    diff.push({ field: operation.field, before, after });
  }
  next.revision += 1;
  if (
    !Object.hasOwn(patch.set, "durationDays") &&
    !clearFields.includes("durationDays") &&
    next.dateRange &&
    !next.dateRange.isFlexible &&
    next.dateRange.startDate &&
    next.dateRange.endDate
  ) {
    const days =
      (Date.parse(`${next.dateRange.endDate}T00:00:00Z`) -
        Date.parse(`${next.dateRange.startDate}T00:00:00Z`)) /
        86400000 +
      1;
    if (Number.isInteger(days) && days >= 1 && next.durationDays !== days) {
      const before = valueAt(current, "durationDays");
      next.durationDays = days;
      next.fieldSources.push(source("durationDays", "DERIVED", hash));
      diff.push({ field: "durationDays", before, after: days });
    }
  }
  next.specialFlags = deriveSpecialFlags(next);
  next.fieldSources = [...new Map(next.fieldSources.map((item) => [item.field, item])).values()];
  const parsed = TravelRequirementSchema.safeParse(next);
  if (!parsed.success) throw new Error("VALIDATION_ERROR");
  if (options.skipMissing)
    return {
      ok: true,
      requirement: parsed.data,
      nextRevision: parsed.data.revision,
      diff,
      missingFields: [],
      questions: [],
    };
  const policy = options.policy ?? (await readinessPolicy(options.database!, ctx));
  const readiness = evaluateRequirementReadiness(
    parsed.data,
    ctx,
    policy,
    options.capabilities ?? defaultCapabilities,
  );
  const asked = await askMissingFields(readiness.missingSpecs, ctx, {
    ...(options.database ? { db: options.database } : {}),
    ...(options.attemptNo ? { attemptNo: options.attemptNo } : {}),
  });
  const requirement = { ...parsed.data, missingFields: asked.missingFields };
  const checked = TravelRequirementSchema.safeParse(requirement);
  if (!checked.success) throw new Error("VALIDATION_ERROR");
  return {
    ok: true,
    requirement: checked.data,
    nextRevision: checked.data.revision,
    diff,
    missingFields: asked.missingFields,
    questions: asked.questions,
  };
}

export type PatchLedger = Map<string, Extract<MergeResult, { ok: true }>>;

/** Replay an identical patch from the caller ledger. A second apply must not append or bump revision. */
export function requirementPatchKey(patch: RequirementPatch): string {
  return canonicalJson(patch);
}

export async function replayOrMerge(
  ledger: PatchLedger,
  current: TravelRequirement,
  patch: RequirementPatch,
  ctx: NluContext,
  options: Parameters<typeof mergeRequirements>[3] = {},
): Promise<MergeResult> {
  const key = requirementPatchKey(patch);
  const saved = ledger.get(key);
  if (saved) return saved;
  const result = await mergeRequirements(current, patch, ctx, options);
  if (result.ok) ledger.set(key, result);
  return result;
}
