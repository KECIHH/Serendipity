import registry from "./prompt-contract.json";
import travel from "./travel-contract.json";
import { canonicalJson } from "./canonical-json";
import { safeParseAiJson } from "./json-parser";
import { requirementIssues } from "./requirement-validation";
import {
  createRuntimeSchema,
  validateJsonSchema,
  type JsonSchema,
  type RuntimeSchema,
} from "./schema-validation";
import type {
  PromptInputMap,
  PromptOutputMap,
  TravelRequirement,
  TravelPlanSummaryDraft,
} from "./schema-types";

export { canonicalJson } from "./canonical-json";
export type * from "./schema-types";
export type { RuntimeSchema, SchemaIssue } from "./schema-validation";
export type PromptKey = keyof PromptOutputMap;
export interface PromptVariableContract {
  readonly name: string;
  readonly required: boolean;
  readonly nullable: boolean;
  readonly maxLength: number;
  readonly delivery: string;
  readonly sensitivity: string;
}
export interface PromptKeyContract {
  readonly key: PromptKey;
  readonly purpose: string;
  readonly responseSchemaVersion: number;
  readonly variables: readonly PromptVariableContract[];
  readonly inputSchema: JsonSchema;
  readonly responseSchema: JsonSchema;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly templateRules: readonly string[];
  readonly fixtureInput: Record<string, unknown>;
  readonly fixtureOutput: unknown;
}
export const PROMPT_KEY_CONTRACTS = registry.keys.map((row) => ({
  ...row,
  responseSchemaVersion: row.outputSchemaVersion,
})) as unknown as readonly PromptKeyContract[];
export function promptKeyContract(key: string): PromptKeyContract {
  const contract = PROMPT_KEY_CONTRACTS.find((item) => item.key === key);
  if (!contract) throw new Error("CONFIG_ERROR");
  return contract;
}
function promptSchema<K extends PromptKey>(key: K): RuntimeSchema<PromptOutputMap[K]> {
  const contract = promptKeyContract(key);
  return createRuntimeSchema<PromptOutputMap[K]>(
    `${key}:v1`,
    contract.responseSchema,
    registry.definitions,
    contract.maxOutputBytes,
    (value) => {
      if (
        key === "export.markdown" &&
        /<[^>]+>|(?:javascript|data|vbscript)\s*:/i.test(
          (value as PromptOutputMap["export.markdown"]).markdown,
        )
      )
        return [{ path: "$.markdown", summary: "CONSTRAINT" }];
      return [];
    },
  );
}
export const TravelRequirementSchema = createRuntimeSchema<TravelRequirement>(
  "travel-requirement-v1",
  travel.requirement,
  travel.requirement.$defs,
  131072,
  requirementIssues,
);
export const TravelPlanSummaryDraftSchema = createRuntimeSchema<TravelPlanSummaryDraft>(
  "travel-summary-v1",
  travel.summary,
  travel.requirement.$defs,
  32768,
  (value) =>
    new Set(value.destinations.map((item) => item.id)).size === value.destinations.length
      ? []
      : [{ path: "$.destinations", summary: "REFERENCE" }],
);
export const NluExtractOutputSchema = promptSchema("nlu.extract");
export const NluAskMissingOutputSchema = promptSchema("nlu.ask_missing");
export const PlannerGenerateOutputSchema = promptSchema("planner.generate");
export const PlannerRepairJsonOutputSchema = promptSchema("planner.repair_json");
export const ConversationModifyOutputSchema = promptSchema("conversation.modify");
export const PlannerScoreOutputSchema = promptSchema("planner.score");
export const PlannerFinalSummaryOutputSchema = promptSchema("planner.final_summary");
export const ExportMarkdownOutputSchema = promptSchema("export.markdown");
export const PromptOutputSchemas = Object.freeze({
  "nlu.extract": NluExtractOutputSchema,
  "nlu.ask_missing": NluAskMissingOutputSchema,
  "planner.generate": PlannerGenerateOutputSchema,
  "planner.repair_json": PlannerRepairJsonOutputSchema,
  "conversation.modify": ConversationModifyOutputSchema,
  "planner.score": PlannerScoreOutputSchema,
  "planner.final_summary": PlannerFinalSummaryOutputSchema,
  "export.markdown": ExportMarkdownOutputSchema,
});
export type RepairTargetSchemaId =
  | `${Exclude<PromptKey, "planner.repair_json">}:v1`
  | "travel-requirement-v1"
  | "travel-summary-v1";
export function repairTargetSchema(id: string): RuntimeSchema<unknown> {
  if (id === TravelRequirementSchema.schemaId) return TravelRequirementSchema;
  if (id === TravelPlanSummaryDraftSchema.schemaId) return TravelPlanSummaryDraftSchema;
  const schema = Object.values(PromptOutputSchemas).find(
    (item) => item.schemaId === id && item !== PlannerRepairJsonOutputSchema,
  );
  if (!schema) throw new Error("CONFIG_ERROR");
  return schema;
}
export function parsePromptVariables(
  key: string,
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const contract = promptKeyContract(key);
  if (
    validateJsonSchema(input, contract.inputSchema, registry.definitions).length ||
    new TextEncoder().encode(canonicalJson(input)).byteLength > contract.maxInputBytes
  )
    throw new Error("CONFIG_ERROR");
  for (const definition of contract.variables) {
    const value = input[definition.name];
    if (
      value !== null &&
      value !== undefined &&
      Array.from(typeof value === "string" ? value : canonicalJson(value)).length >
        definition.maxLength
    )
      throw new Error("CONFIG_ERROR");
  }
  return structuredClone(input);
}
export function parsePromptResponse(key: string, output: string): unknown {
  const parsed = safeParseAiJson(
    output,
    PromptOutputSchemas[promptKeyContract(key).key] as RuntimeSchema<unknown>,
  );
  if (!parsed.ok) throw new Error(parsed.errorCode);
  return parsed.data;
}

/** Input-bound references are a separate semantic boundary, never model-provided authority. */
export function validatePromptReferences<K extends PromptKey>(
  key: K,
  input: PromptInputMap[K],
  output: PromptOutputMap[K],
): void {
  let valid = true;
  if (key === "nlu.extract") {
    const request = input as PromptInputMap["nlu.extract"],
      response = output as PromptOutputMap["nlu.extract"];
    const fields: Record<string, readonly string[]> = {
      CORE: ["origin", "destinations", "dateRange"],
      PARAMETERS: [
        "durationDays",
        "travelers",
        "budget",
        "preferences.pace",
        "preferences.interests",
        "preferences.avoid",
      ],
      CONSTRAINTS: [
        "preferences.transport",
        "preferences.hardConstraints",
        "preferences.accessibility",
      ],
    };
    valid = response.candidates.every(
      (candidate) =>
        request.userText.includes(candidate.text) &&
        fields[request.stage].includes(candidate.field),
    );
  }
  if (key === "nlu.ask_missing") {
    const request = input as PromptInputMap["nlu.ask_missing"],
      response = output as PromptOutputMap["nlu.ask_missing"];
    const fields = response.questions.map((item) => item.field);
    valid =
      new Set(fields).size === fields.length &&
      canonicalJson([...fields].sort()) ===
        canonicalJson(request.specs.map((item) => item.field).sort());
  }
  if (key === "conversation.modify") {
    const request = input as PromptInputMap["conversation.modify"],
      response = output as PromptOutputMap["conversation.modify"];
    valid =
      response.targetCandidateIds.every((id) =>
        request.candidates.some(
          (candidate) =>
            candidate.candidateId === id &&
            candidate.allowedOperations.includes(response.operation),
        ),
      ) && request.userText.includes(response.requestedText);
  }
  if (key === "planner.score") {
    const request = input as PromptInputMap["planner.score"],
      response = output as PromptOutputMap["planner.score"];
    const dimensions = response.explanations.map((item) => item.dimension);
    valid =
      new Set(dimensions).size === dimensions.length &&
      canonicalJson([...dimensions].sort()) ===
        canonicalJson(request.scoreReasons.map((item) => item.dimension).sort());
  }
  if (!valid) throw new Error("VALIDATION_ERROR");
}
