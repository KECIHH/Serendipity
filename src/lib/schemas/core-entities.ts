import travel from "@/lib/ai/travel-contract.json";
import { createRuntimeSchema } from "@/lib/ai/schema-validation";
import type { TravelRequirement } from "@/lib/ai/schema-types";

export type CoreEntities = Pick<TravelRequirement, "origin" | "destinations" | "dateRange">;
const fields = travel.requirement.$defs.TravelRequirement.properties;

/** Reuse Phase017 fields without assigning readiness or merging a snapshot. */
export const CoreEntitiesSchema = createRuntimeSchema<CoreEntities>(
  "core-entities-v1",
  {
    type: "object",
    additionalProperties: false,
    required: ["origin", "destinations", "dateRange"],
    properties: {
      origin: fields.origin,
      destinations: fields.destinations,
      dateRange: fields.dateRange,
    },
  },
  travel.requirement.$defs,
  131072,
  (value) =>
    value.dateRange?.startDate &&
    value.dateRange.endDate &&
    value.dateRange.startDate > value.dateRange.endDate
      ? [{ path: "$.dateRange", summary: "CONSTRAINT" }]
      : [],
);
