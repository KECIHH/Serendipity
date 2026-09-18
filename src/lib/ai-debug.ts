import { PROMPT_KEY_CONTRACTS } from "./ai/schemas";

/**
 * Phase018 administrator AI debug contract. This module is client safe: it carries no
 * Prompt body, no secret reference, no provider URL and no server-only import.
 */
export const AI_DEBUG_FAILURE_PROFILES = [
  "success",
  "timeout",
  "rate_limit",
  "server_error",
  "invalid_json",
  "schema_mismatch",
  "network_error",
  "cancel",
  "cost",
  "repair",
] as const;
export type AiDebugFailureProfile = (typeof AI_DEBUG_FAILURE_PROFILES)[number];

export const AI_DEBUG_STATUSES = [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;
export type AiDebugRunStatusValue = (typeof AI_DEBUG_STATUSES)[number];

export const AI_DEBUG_DIAGNOSTIC_CATEGORIES = ["INVALID_JSON", "SCHEMA_MISMATCH"] as const;
export type AiDebugDiagnosticCategory = (typeof AI_DEBUG_DIAGNOSTIC_CATEGORIES)[number];

export const AI_DEBUG_MAX_VARIABLE_BYTES = 16384;
export const AI_DEBUG_MAX_RAW_OUTPUT_CHARS = 1024;

export interface AiDebugRequest {
  readonly promptKey: string;
  readonly variables: Record<string, unknown>;
  readonly failureProfile: AiDebugFailureProfile;
}
export interface AiDebugReceipt {
  readonly debugRunId: string;
  readonly status: AiDebugRunStatusValue;
  readonly replayed: boolean;
}
export interface SchemaValidationDto {
  readonly valid: boolean;
  readonly diagnosticCategory: AiDebugDiagnosticCategory | null;
  readonly issuePaths: readonly string[];
}
export interface AiDebugSummaryDto {
  readonly promptVersionId: string;
  readonly promptHash: string;
  readonly deploymentId: string;
  readonly deploymentConfigVersion: number;
  readonly providerId: string;
  readonly providerConfigVersion: number;
  readonly rawOutput: string | null;
  readonly parsedData: unknown | null;
  readonly schemaValidation: SchemaValidationDto;
  readonly aiOutputRecordId: string;
}
export interface AiDebugStatusDto {
  readonly debugRunId: string;
  readonly status: AiDebugRunStatusValue;
  readonly attemptIds: readonly string[];
  readonly finalSummary: AiDebugSummaryDto | null;
  readonly errorCode: string | null;
}

export class AiDebugInputError extends Error {
  constructor() {
    super("VALIDATION_ERROR");
    this.name = "AiDebugInputError";
  }
}
function invalid(): never {
  throw new AiDebugInputError();
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): string =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : invalid();
const hex = (value: unknown): string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : invalid();
const positive = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : invalid();
const exact = (value: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) invalid();
};
/** No caller may select a deployment, provider, secret or system Prompt through this DTO. */
const REQUEST_KEYS = ["promptKey", "variables", "failureProfile"] as const;
export const AI_DEBUG_PROMPT_KEYS = Object.freeze(
  PROMPT_KEY_CONTRACTS.map((contract) => contract.key),
);

export function parseAiDebugRequest(value: unknown): AiDebugRequest {
  if (!isObject(value)) invalid();
  exact(value, REQUEST_KEYS);
  const promptKey = value.promptKey;
  if (typeof promptKey !== "string" || !AI_DEBUG_PROMPT_KEYS.includes(promptKey as never))
    invalid();
  if (!isObject(value.variables)) invalid();
  if (
    !(AI_DEBUG_FAILURE_PROFILES as readonly string[]).includes(value.failureProfile as string) ||
    typeof value.failureProfile !== "string"
  )
    invalid();
  const variables: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value.variables)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key)) invalid();
    if (item === undefined) invalid();
    variables[key] = item;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(variables);
  } catch {
    return invalid();
  }
  if (new TextEncoder().encode(serialized).byteLength > AI_DEBUG_MAX_VARIABLE_BYTES) invalid();
  if (
    /"(?:password|plainKey|secret|secretRef|encryptedKey|ciphertext|cookie|authorization|token|apiKey|baseUrl|systemPrompt)"\s*:/i.test(
      serialized,
    ) ||
    /(?:authorization\s*:|bearer\s+[a-z0-9._-]{20,}|cookie\s*:)/i.test(serialized)
  )
    invalid();
  return Object.freeze({
    promptKey: promptKey as string,
    variables: Object.freeze(variables) as Record<string, unknown>,
    failureProfile: value.failureProfile as AiDebugFailureProfile,
  });
}

export function parseAiDebugReceipt(value: unknown): AiDebugReceipt {
  if (!isObject(value)) invalid();
  exact(value, ["debugRunId", "status", "replayed"]);
  if (
    !(AI_DEBUG_STATUSES as readonly string[]).includes(value.status as string) ||
    typeof value.replayed !== "boolean"
  )
    invalid();
  return Object.freeze({
    debugRunId: identifier(value.debugRunId),
    status: value.status as AiDebugRunStatusValue,
    replayed: value.replayed,
  });
}

export function parseSchemaValidation(value: unknown): SchemaValidationDto {
  if (!isObject(value)) invalid();
  exact(value, ["valid", "diagnosticCategory", "issuePaths"]);
  if (typeof value.valid !== "boolean" || !Array.isArray(value.issuePaths)) invalid();
  const category = value.diagnosticCategory;
  if (
    category !== null &&
    !(AI_DEBUG_DIAGNOSTIC_CATEGORIES as readonly string[]).includes(category as string)
  )
    invalid();
  if (value.issuePaths.length > 64) invalid();
  const issuePaths = value.issuePaths.map((path) => {
    if (typeof path !== "string" || path.length < 1 || path.length > 200) return invalid();
    if (!/^\$[\w.[\]'"-]*$/.test(path)) return invalid();
    return path;
  });
  // A valid payload has no diagnostic classification; an invalid one may be unclassified
  // (transport or budget failure) or carry exactly one parse classification.
  if (value.valid && category !== null) invalid();
  return Object.freeze({
    valid: value.valid,
    diagnosticCategory: category as AiDebugDiagnosticCategory | null,
    issuePaths: Object.freeze(issuePaths),
  });
}

export function parseAiDebugSummary(value: unknown): AiDebugSummaryDto {
  if (!isObject(value)) invalid();
  exact(value, [
    "promptVersionId",
    "promptHash",
    "deploymentId",
    "deploymentConfigVersion",
    "providerId",
    "providerConfigVersion",
    "rawOutput",
    "parsedData",
    "schemaValidation",
    "aiOutputRecordId",
  ]);
  if (value.rawOutput !== null) {
    if (typeof value.rawOutput !== "string") invalid();
    if (Array.from(value.rawOutput).length > AI_DEBUG_MAX_RAW_OUTPUT_CHARS) invalid();
  }
  return Object.freeze({
    promptVersionId: identifier(value.promptVersionId),
    promptHash: hex(value.promptHash),
    deploymentId: identifier(value.deploymentId),
    deploymentConfigVersion: positive(value.deploymentConfigVersion),
    providerId: identifier(value.providerId),
    providerConfigVersion: positive(value.providerConfigVersion),
    rawOutput: value.rawOutput as string | null,
    parsedData: value.parsedData === undefined ? null : value.parsedData,
    schemaValidation: parseSchemaValidation(value.schemaValidation),
    aiOutputRecordId: identifier(value.aiOutputRecordId),
  });
}

export function parseAiDebugStatus(value: unknown): AiDebugStatusDto {
  if (!isObject(value)) invalid();
  exact(value, ["debugRunId", "status", "attemptIds", "finalSummary", "errorCode"]);
  if (
    !(AI_DEBUG_STATUSES as readonly string[]).includes(value.status as string) ||
    !Array.isArray(value.attemptIds)
  )
    invalid();
  if (value.attemptIds.length > 8) invalid();
  if (
    value.errorCode !== null &&
    (typeof value.errorCode !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/.test(value.errorCode))
  )
    invalid();
  return Object.freeze({
    debugRunId: identifier(value.debugRunId),
    status: value.status as AiDebugRunStatusValue,
    attemptIds: Object.freeze(value.attemptIds.map((id) => identifier(id))),
    finalSummary: value.finalSummary === null ? null : parseAiDebugSummary(value.finalSummary),
    errorCode: value.errorCode as string | null,
  });
}

/** Ordered labels for the fixture matrix rendered by the administrator page. */
export const AI_DEBUG_FIXTURE_MATRIX = Object.freeze([
  { id: "success", profile: "success" as AiDebugFailureProfile },
  { id: "timeout", profile: "timeout" as AiDebugFailureProfile },
  { id: "invalid-json", profile: "invalid_json" as AiDebugFailureProfile },
  { id: "schema-mismatch", profile: "schema_mismatch" as AiDebugFailureProfile },
  { id: "repair", profile: "repair" as AiDebugFailureProfile },
  { id: "stream-interruption", profile: "success" as AiDebugFailureProfile },
  { id: "cost", profile: "cost" as AiDebugFailureProfile },
  { id: "authorization", profile: "success" as AiDebugFailureProfile },
]);
