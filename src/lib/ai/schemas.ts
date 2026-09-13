import { createHash } from "node:crypto";
import registry from "./prompt-contract.json";

export type PromptKey =
  | "nlu.extract"
  | "nlu.ask_missing"
  | "planner.generate"
  | "planner.repair_json"
  | "conversation.modify"
  | "planner.score"
  | "planner.final_summary"
  | "export.markdown";
type JsonSchema = {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  format?: string;
};
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
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("CONFIG_ERROR");
}
export function canonicalHash(value: unknown): string {
  return createHash("sha256")
    .update(`${canonicalJson(value)}\n`, "utf8")
    .digest("hex");
}
function invalid(): never {
  throw new Error("CONFIG_ERROR");
}
function matchesType(value: unknown, type: string) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}
function validFormat(value: string, format: string) {
  try {
    if (format === "nonblank-text") return value.trim().length > 0;
    if (format === "bcp47-locale")
      return Intl.getCanonicalLocales(value)[0] === value && /^[A-Za-z0-9-]+$/.test(value);
    if (format === "iana-timezone")
      return (
        new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone.length > 0
      );
    if (format === "date")
      return (
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
      );
    if (format === "decimal-string") return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
    return true;
  } catch {
    return false;
  }
}
function validate(
  value: unknown,
  schema: JsonSchema,
  depth = 0,
  definitions = registry.definitions as Record<string, JsonSchema>,
): void {
  if (depth > 40) invalid();
  if (schema.$ref) {
    const [document, key] = schema.$ref.split("#/$defs/");
    if (document !== "" && document !== "travel-requirement-v1") invalid();
    const defs =
      document === "travel-requirement-v1"
        ? (registry.travelDefinitions as Record<string, JsonSchema>)
        : definitions;
    if (!defs[key]) invalid();
    validate(value, defs[key], depth + 1, defs);
    return;
  }
  const choices = schema.anyOf ?? schema.oneOf;
  if (choices) {
    const count = choices.filter((choice) => {
      try {
        validate(value, choice, depth + 1, definitions);
        return true;
      } catch {
        return false;
      }
    }).length;
    if (schema.oneOf ? count !== 1 : count === 0) invalid();
  }
  if (Object.hasOwn(schema, "const") && canonicalJson(value) !== canonicalJson(schema.const))
    invalid();
  if (schema.enum && !schema.enum.some((entry) => canonicalJson(entry) === canonicalJson(value)))
    invalid();
  if (
    schema.type &&
    !(Array.isArray(schema.type) ? schema.type : [schema.type]).some((type) =>
      matchesType(value, type),
    )
  )
    invalid();
  if (typeof value === "string") {
    const length = Array.from(value).length;
    if (length < (schema.minLength ?? 0) || length > (schema.maxLength ?? Infinity)) invalid();
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) invalid();
    if (schema.format && !validFormat(value, schema.format)) invalid();
  }
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity))
  )
    invalid();
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity))
      invalid();
    if (schema.uniqueItems && new Set(value.map(canonicalJson)).size !== value.length) invalid();
    for (const entry of value) {
      if (schema.items) validate(entry, schema.items, depth + 1, definitions);
    }
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      invalid();
    for (const key of schema.required ?? [])
      if (!Object.hasOwn(record, key) || record[key] === undefined) invalid();
    for (const [key, entry] of Object.entries(record)) {
      const child = schema.properties?.[key];
      if (!child && schema.additionalProperties === false) invalid();
      if (entry === undefined || ["__proto__", "constructor", "prototype"].includes(key)) invalid();
      if (child) validate(entry, child, depth + 1, definitions);
    }
  }
}
export function parsePromptVariables(
  key: string,
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const contract = promptKeyContract(key);
  validate(input, contract.inputSchema);
  if (Buffer.byteLength(canonicalJson(input), "utf8") > contract.maxInputBytes) invalid();
  for (const definition of contract.variables) {
    const value = input[definition.name];
    if (
      value !== null &&
      value !== undefined &&
      Array.from(typeof value === "string" ? value : canonicalJson(value)).length >
        definition.maxLength
    )
      invalid();
  }
  return structuredClone(input);
}
export function parsePromptResponse(key: string, output: string): unknown {
  const contract = promptKeyContract(key);
  if (Buffer.byteLength(output, "utf8") > contract.maxOutputBytes)
    throw new Error("SCHEMA_MISMATCH");
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("INVALID_JSON");
  }
  try {
    validate(value, contract.responseSchema);
    if (
      key === "export.markdown" &&
      /<[^>]+>|(?:javascript|data|vbscript)\s*:/i.test((value as { markdown: string }).markdown)
    )
      invalid();
  } catch {
    throw new Error("SCHEMA_MISMATCH");
  }
  return value;
}
