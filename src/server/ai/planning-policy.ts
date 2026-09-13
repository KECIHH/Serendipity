import "server-only";
import { Prisma } from "@prisma/client";
import bootstrap from "./planning-policy-bootstrap.json";
import { canonicalJson } from "@/lib/ai/schemas";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CONFIG_ERROR");
  return value as Record<string, unknown>;
}
function sameKeys(value: Record<string, unknown>, expected: object) {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson(Object.keys(expected).sort()))
    throw new Error("CONFIG_ERROR");
}
export function parsePlanningPolicy(value: unknown): typeof bootstrap {
  const policy = record(value);
  sameKeys(policy, bootstrap);
  if (
    policy.schemaVersion !== 1 ||
    policy.producerPhase !== 15 ||
    policy.scope !== "SYNTHETIC_ONLY" ||
    typeof policy.source !== "string" ||
    !policy.source.trim() ||
    policy.source.length > 1024
  )
    throw new Error("CONFIG_ERROR");
  for (const group of ["freshness", "planning", "quality"] as const) {
    const row = record(policy[group]);
    sameKeys(row, bootstrap[group]);
    for (const [name, spec] of Object.entries(bootstrap[group])) {
      if (typeof spec === "boolean") {
        if (row[name] !== true) throw new Error("CONFIG_ERROR");
        continue;
      }
      const threshold = record(row[name]);
      sameKeys(threshold, spec);
      if (
        threshold.unit !== spec.unit ||
        threshold.min !== spec.min ||
        threshold.max !== spec.max ||
        typeof threshold.source !== "string" ||
        !threshold.source.trim() ||
        threshold.source.length > 512 ||
        typeof threshold.reason !== "string" ||
        !threshold.reason.trim() ||
        threshold.reason.length > 1024
      )
        throw new Error("CONFIG_ERROR");
      if (typeof spec.value === "number") {
        if (
          !Number.isSafeInteger(threshold.value) ||
          Number(threshold.value) < Number(spec.min) ||
          Number(threshold.value) > Number(spec.max)
        )
          throw new Error("CONFIG_ERROR");
      } else {
        if (
          typeof threshold.value !== "string" ||
          !/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(threshold.value)
        )
          throw new Error("CONFIG_ERROR");
        const amount = new Prisma.Decimal(threshold.value);
        if (amount.lt(spec.min) || amount.gt(spec.max)) throw new Error("CONFIG_ERROR");
      }
    }
  }
  const parsed = policy as typeof bootstrap;
  if (
    parsed.freshness.agingAfterSeconds.value > parsed.freshness.ttlSeconds.value ||
    parsed.freshness.ttlSeconds.value > parsed.freshness.maxStaleSeconds.value
  )
    throw new Error("CONFIG_ERROR");
  return structuredClone(parsed);
}
