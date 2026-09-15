import type { RuntimeSchema, SchemaIssue } from "./schema-validation";

export type ParseResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly errorCode: "INVALID_JSON" | "SCHEMA_MISMATCH";
      readonly details: readonly SchemaIssue[];
    };

export function cleanAiOutput(rawText: string): string {
  const clean = rawText.replace(/^\uFEFF/, "").trim();
  const fence = clean.match(/^(`{3,}|~{3,})(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n\1$/i);
  return fence ? fence[2].trim() : clean;
}

export function safeParseAiJson<T>(rawText: string, schema: RuntimeSchema<T>): ParseResult<T> {
  let value: unknown;
  try {
    if (
      typeof rawText !== "string" ||
      rawText.length > schema.maxBytes + 256 ||
      new TextEncoder().encode(rawText).byteLength > schema.maxBytes + 256
    )
      return {
        ok: false,
        errorCode: "SCHEMA_MISMATCH",
        details: [{ path: "$", summary: "LIMIT" }],
      };
    value = JSON.parse(cleanAiOutput(rawText));
  } catch {
    return { ok: false, errorCode: "INVALID_JSON", details: [{ path: "$", summary: "FORMAT" }] };
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, errorCode: "SCHEMA_MISMATCH", details: parsed.issues };
}
