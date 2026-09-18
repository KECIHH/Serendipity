import type { PromptVariableContract } from "@/lib/ai/schemas";
import { NluExtractOutputSchema } from "@/lib/ai/schemas";

/** Stable registry binding for the core entity extraction prompt. */
export const NLU_EXTRACT_PROMPT_KEY = "nlu.extract" as const;

/** Variables are owned by the frozen prompt registry; this module carries no prompt text. */
export const NLU_EXTRACT_VARIABLES = Object.freeze([
  {
    name: "userText",
    required: true,
    nullable: false,
    maxLength: 4000,
    delivery: "user_message",
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
  {
    name: "serverDate",
    required: true,
    nullable: false,
    maxLength: 10,
    delivery: "system_scalar",
    sensitivity: "non_sensitive",
  },
  {
    name: "timezone",
    required: true,
    nullable: false,
    maxLength: 80,
    delivery: "system_scalar",
    sensitivity: "non_sensitive",
  },
  {
    name: "stage",
    required: true,
    nullable: false,
    maxLength: 11,
    delivery: "system_scalar",
    sensitivity: "non_sensitive",
  },
] satisfies readonly PromptVariableContract[]);

export const NLU_EXTRACT_RESPONSE_SCHEMA = NluExtractOutputSchema;
