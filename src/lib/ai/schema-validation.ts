import { canonicalJson } from "./canonical-json";
import travel from "./travel-contract.json";

export interface JsonSchema {
  readonly $schema?: string;
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JsonSchema>>;
  readonly type?: string | readonly string[];
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
  readonly format?: string;
}
export interface SchemaIssue {
  readonly path: string;
  readonly summary:
    | "TYPE"
    | "REQUIRED"
    | "UNKNOWN_KEY"
    | "VERSION"
    | "ENUM"
    | "RANGE"
    | "FORMAT"
    | "REFERENCE"
    | "CONSTRAINT"
    | "LIMIT";
}
export type SchemaResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly issues: readonly SchemaIssue[] };
export interface RuntimeSchema<T> {
  readonly schemaId: string;
  readonly maxBytes: number;
  safeParse(value: unknown): SchemaResult<T>;
  parse(value: unknown): T;
}
export class SchemaValidationError extends Error {
  constructor(readonly issues: readonly SchemaIssue[]) {
    super("SCHEMA_MISMATCH");
    this.name = "SchemaValidationError";
  }
}
export function validScalarFormat(value: string, format: string): boolean {
  if (!value.isWellFormed()) return false;
  try {
    if (format === "nonblank-text") return value.trim().length > 0;
    if (format === "bcp47-locale")
      return Intl.getCanonicalLocales(value)[0] === value && /^[A-Za-z0-9-]+$/.test(value);
    if (format === "iana-timezone")
      return (
        (value === "UTC" || value.includes("/")) &&
        !!new Intl.DateTimeFormat("en", { timeZone: value }).format(0)
      );
    if (format === "date")
      return (
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        !value.startsWith("0000-") &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
      );
    if (format === "iso-country") return travel.scalars.countryCodes.includes(value);
    if (format === "iso-currency") return Object.hasOwn(travel.scalars.currencyMinorUnits, value);
    if (format === "decimal-string") return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
  } catch {
    return false;
  }
  return false;
}
function matchesType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}
export function validateJsonSchema(
  value: unknown,
  schema: JsonSchema,
  definitions: Readonly<Record<string, JsonSchema>> = {},
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const add = (path: string, summary: SchemaIssue["summary"]) => {
    if (issues.length < 20) issues.push({ path: path.length <= 160 ? path : "$", summary });
  };
  function visit(
    current: unknown,
    rule: JsonSchema,
    defs: Readonly<Record<string, JsonSchema>>,
    at: string,
    depth: number,
  ) {
    if (issues.length >= 20) return;
    if (depth > 40) {
      add(at, "LIMIT");
      return;
    }
    if (rule.$ref) {
      const [document, key] = rule.$ref.split("#/$defs/");
      const nextDefs = document === "travel-requirement-v1" ? travel.requirement.$defs : defs;
      if (
        !["", "travel-requirement-v1"].includes(document) ||
        !key ||
        !Object.hasOwn(nextDefs, key)
      ) {
        add(at, "REFERENCE");
        return;
      }
      visit(
        current,
        (nextDefs as Readonly<Record<string, JsonSchema>>)[key],
        nextDefs,
        at,
        depth + 1,
      );
      return;
    }
    const choices = rule.anyOf ?? rule.oneOf;
    if (choices) {
      const start = issues.length;
      let matches = 0;
      for (const choice of choices) {
        visit(current, choice, defs, at, depth + 1);
        if (issues.length === start) matches++;
        issues.length = start;
      }
      if (rule.oneOf ? matches !== 1 : matches === 0) {
        add(at, "CONSTRAINT");
        return;
      }
    }
    if (Object.hasOwn(rule, "const") && canonicalJson(current) !== canonicalJson(rule.const))
      add(at, "VERSION");
    if (rule.enum && !rule.enum.some((entry) => canonicalJson(entry) === canonicalJson(current)))
      add(at, "ENUM");
    if (
      rule.type &&
      !(typeof rule.type === "string" ? [rule.type] : rule.type).some((type) =>
        matchesType(current, type),
      )
    ) {
      add(at, "TYPE");
      return;
    }
    if (typeof current === "string") {
      const length = Array.from(current).length;
      if (length < (rule.minLength ?? 0) || length > (rule.maxLength ?? Infinity)) add(at, "RANGE");
      if (
        !current.isWellFormed() ||
        (rule.pattern && !new RegExp(rule.pattern, "u").test(current)) ||
        (rule.format && !validScalarFormat(current, rule.format))
      )
        add(at, "FORMAT");
    }
    if (
      typeof current === "number" &&
      (!Number.isFinite(current) ||
        current < (rule.minimum ?? -Infinity) ||
        current > (rule.maximum ?? Infinity))
    )
      add(at, "RANGE");
    if (Array.isArray(current)) {
      if (current.length < (rule.minItems ?? 0) || current.length > (rule.maxItems ?? Infinity)) {
        add(at, "RANGE");
        return;
      }
      if (rule.uniqueItems && new Set(current.map(canonicalJson)).size !== current.length)
        add(at, "CONSTRAINT");
      current.forEach((item, index) => {
        if (rule.items) visit(item, rule.items, defs, `${at}[${index}]`, depth + 1);
      });
    } else if (current !== null && typeof current === "object") {
      if (
        Object.getPrototypeOf(current) !== Object.prototype &&
        Object.getPrototypeOf(current) !== null
      ) {
        add(at, "TYPE");
        return;
      }
      const row = current as Record<string, unknown>;
      for (const key of rule.required ?? [])
        if (!Object.hasOwn(row, key) || row[key] === undefined) add(`${at}.${key}`, "REQUIRED");
      for (const key of Object.keys(row)) {
        // Never reflect an unknown, attacker-controlled key into an error or a repair prompt.
        if (
          ["__proto__", "prototype", "constructor"].includes(key) ||
          !Object.hasOwn(rule.properties ?? {}, key)
        ) {
          if (rule.additionalProperties === false) add(at, "UNKNOWN_KEY");
          continue;
        }
        visit(row[key], rule.properties![key], defs, `${at}.${key}`, depth + 1);
      }
    }
  }
  try {
    visit(value, schema, schema.$defs ?? definitions, "$", 0);
  } catch {
    add("$", "CONSTRAINT");
  }
  return issues;
}
export function createRuntimeSchema<T>(
  schemaId: string,
  schema: JsonSchema,
  definitions: Readonly<Record<string, JsonSchema>>,
  maxBytes: number,
  refine?: (data: T) => readonly SchemaIssue[],
): RuntimeSchema<T> {
  const result: RuntimeSchema<T> = {
    schemaId,
    maxBytes,
    safeParse(value) {
      try {
        if (new TextEncoder().encode(canonicalJson(value)).byteLength > maxBytes)
          return { success: false, issues: [{ path: "$", summary: "LIMIT" }] };
        const issues = validateJsonSchema(value, schema, definitions);
        if (issues.length) return { success: false, issues };
        const data = structuredClone(value) as T;
        const semantic = refine?.(data) ?? [];
        return semantic.length
          ? { success: false, issues: semantic.slice(0, 20) }
          : { success: true, data };
      } catch {
        return { success: false, issues: [{ path: "$", summary: "CONSTRAINT" }] };
      }
    },
    parse(value) {
      const parsed = result.safeParse(value);
      if (!parsed.success) throw new SchemaValidationError(parsed.issues);
      return parsed.data;
    },
  };
  return Object.freeze(result);
}
