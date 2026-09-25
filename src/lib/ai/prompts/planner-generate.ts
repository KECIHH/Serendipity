import type { PromptVariableContract } from "@/lib/ai/schemas";
import { PlannerGenerateOutputSchema } from "@/lib/ai/schemas";

/** Stable registry binding for summary wording. The active prompt text stays in PromptVersion. */
export const PLANNER_GENERATE_PROMPT_KEY = "planner.generate" as const;

/** Variables are owned by the frozen prompt registry; this module carries no prompt text. */
export const PLANNER_GENERATE_VARIABLES = Object.freeze([
  {
    name: "requirement",
    required: true,
    nullable: false,
    maxLength: 32768,
    delivery: "user_data",
    sensitivity: "private_minimized",
  },
  {
    name: "assumptionSummaries",
    required: true,
    nullable: false,
    maxLength: 4000,
    delivery: "user_data",
    sensitivity: "private_minimized",
  },
  {
    name: "locale",
    required: true,
    nullable: false,
    maxLength: 35,
    delivery: "system_scalar",
    sensitivity: "non_sensitive",
  },
] satisfies readonly PromptVariableContract[]);

export const PLANNER_GENERATE_RESPONSE_SCHEMA = PlannerGenerateOutputSchema;
