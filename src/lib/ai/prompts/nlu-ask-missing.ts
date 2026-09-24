import type { PromptVariableContract } from "@/lib/ai/schemas";
import { NluAskMissingOutputSchema } from "@/lib/ai/schemas";

/** Stable registry binding for missing-field wording. The active prompt text stays in the registry. */
export const NLU_ASK_MISSING_PROMPT_KEY = "nlu.ask_missing" as const;

export const NLU_ASK_MISSING_VARIABLES = Object.freeze([
  {
    name: "specs",
    required: true,
    nullable: false,
    maxLength: 2000,
    delivery: "user_data",
    sensitivity: "private",
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

export const NLU_ASK_MISSING_RESPONSE_SCHEMA = NluAskMissingOutputSchema;
