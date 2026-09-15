import "server-only";
import { safeParseAiJson, type ParseResult } from "@/lib/ai/json-parser";
import { preservesJsonFacts } from "@/lib/ai/syntax-proof";
import {
  repairTargetSchema,
  validatePromptReferences,
  type RuntimeSchema,
  type PromptKey,
  type PromptInputMap,
  type PromptOutputMap,
} from "@/lib/ai/schemas";
import type { AiErrorCode } from "@/lib/ai/provider";
import { canonicalHash } from "./canonical-hash";
import {
  guardedJsonChat,
  claimOriginalJsonAttempt,
  type GuardedAiClientOptions,
} from "./guarded-client";
import { assertNluContext, type NluContext } from "./nlu-context";

export interface JsonRepairContext<T> {
  readonly nluContext: NluContext;
  readonly targetSchema: RuntimeSchema<T>;
  readonly originalAttemptNo: number;
  readonly originalPromptKey: Exclude<PromptKey, "planner.repair_json">;
  readonly originalVariables: PromptInputMap[Exclude<PromptKey, "planner.repair_json">];
  readonly travelRecordId?: string;
  readonly commandId?: string;
  readonly clientOptions: Omit<
    GuardedAiClientOptions,
    "owner" | "nluContext" | "validateOutput" | "onInvalidOutput"
  >;
  readonly validateSemantics?: (data: T) => void;
}
export type JsonRepairResult<T> =
  | { readonly ok: true; readonly data: T; readonly repairAttempts: number }
  | {
      readonly ok: false;
      readonly errorCode: AiErrorCode | "VALIDATION_ERROR";
      readonly internalCode?: "INVALID_JSON" | "SCHEMA_MISMATCH" | "VALIDATION_ERROR";
      readonly repairAttempts: number;
    };

export async function repairJsonWithAi<T>(
  rawText: string,
  errors: Extract<ParseResult<T>, { ok: false }>,
  context: JsonRepairContext<T>,
): Promise<JsonRepairResult<T>> {
  let repairAttempts = 0;
  try {
    context = {
      ...context,
      originalVariables: structuredClone(context.originalVariables),
      clientOptions: { ...context.clientOptions },
    };
    assertNluContext(context.nluContext);
    if (
      repairTargetSchema(context.targetSchema.schemaId) !== context.targetSchema ||
      !Number.isSafeInteger(context.originalAttemptNo) ||
      context.originalAttemptNo < 1 ||
      typeof rawText !== "string" ||
      !rawText.trim() ||
      rawText.length > 16384 ||
      !["INVALID_JSON", "SCHEMA_MISMATCH"].includes(errors.errorCode)
    )
      throw new Error("CONFIG_ERROR");
    // Raw bytes must belong to a real failed attempt in this exact request, never a client claim.
    const original = await context.clientOptions.db.aiOutputRecord.findUnique({
      where: {
        traceId_attemptNo: {
          traceId: context.nluContext.traceId,
          attemptNo: context.originalAttemptNo,
        },
      },
      include: { promptVersion: { include: { definition: true } } },
    });
    if (
      !original ||
      original.parsedOk ||
      original.status !== "FAILED" ||
      !["INVALID_JSON", "SCHEMA_MISMATCH"].includes(original.errorCode ?? "") ||
      original.outputHash !== canonicalHash(rawText) ||
      original.promptVersion.definition.key !== context.originalPromptKey ||
      original.travelRecordId !== (context.travelRecordId ?? null) ||
      original.commandId !== (context.commandId ?? null) ||
      !claimOriginalJsonAttempt(context.nluContext, context.originalAttemptNo, {
        promptKey: context.originalPromptKey,
        schemaId: context.targetSchema.schemaId,
        variablesHash: canonicalHash(context.originalVariables),
        outputHash: canonicalHash(rawText),
      })
    )
      throw new Error("CONFIG_ERROR");
    const previous = await context.clientOptions.db.aiOutputRecord.count({
      where: { traceId: context.nluContext.traceId, attemptNo: { gt: context.originalAttemptNo } },
    });
    if (previous) throw new Error("CONFIG_ERROR");
    let failure = safeParseAiJson(rawText, context.targetSchema);
    if (failure.ok) throw new Error("CONFIG_ERROR");
    // A fixed bound also prevents changing options, a fresh context or provider retries from multiplying calls.
    for (let index = 0; index < 2; index++) {
      assertNluContext(context.nluContext);
      let parsed: ParseResult<T> | undefined;
      const result = await guardedJsonChat(
        {
          promptKey: "planner.repair_json",
          variables: {
            rawText,
            errors: failure.details.map((issue) => ({
              path: issue.path,
              code: failure.ok ? ("INVALID_JSON" as const) : failure.errorCode,
            })),
            targetSchemaId: context.targetSchema
              .schemaId as PromptInputMap["planner.repair_json"]["targetSchemaId"],
            locale: context.nluContext.locale,
          },
          userMessage: "Repair only the supplied JSON syntax and preserve every field and value.",
          context: context.nluContext,
          travelRecordId: context.travelRecordId,
          commandId: context.commandId,
          attemptNo: context.originalAttemptNo + index + 1,
        },
        {
          ...context.clientOptions,
          validateOutput(value) {
            const output = value as PromptOutputMap["planner.repair_json"];
            if (!preservesJsonFacts(rawText, output.repairedText))
              throw new Error("VALIDATION_ERROR");
            parsed = safeParseAiJson(output.repairedText, context.targetSchema);
            if (!parsed.ok) throw new Error(parsed.errorCode);
            if (context.targetSchema.schemaId === `${context.originalPromptKey}:v1`)
              validatePromptReferences(
                context.originalPromptKey,
                context.originalVariables,
                parsed.data as PromptOutputMap[typeof context.originalPromptKey],
              );
            context.validateSemantics?.(parsed.data);
            return parsed.data;
          },
        },
      );
      // Count actual persisted repair calls; zero-call guards do not consume an attempt or imply a provider result.
      const record = await context.clientOptions.db.aiOutputRecord.findUnique({
        where: {
          traceId_attemptNo: {
            traceId: context.nluContext.traceId,
            attemptNo: context.originalAttemptNo + index + 1,
          },
        },
      });
      if (record) repairAttempts++;
      if (result.ok && parsed?.ok) return { ok: true, data: parsed.data, repairAttempts };
      if (!result.ok && result.internalCode === "VALIDATION_ERROR")
        return {
          ok: false,
          errorCode: "VALIDATION_ERROR",
          internalCode: "VALIDATION_ERROR",
          repairAttempts,
        };
      if (!result.ok && !result.internalCode)
        return { ok: false, errorCode: result.errorCode, repairAttempts };
      if (parsed && !parsed.ok) failure = parsed;
    }
    return {
      ok: false,
      errorCode: "PROVIDER_UNAVAILABLE",
      internalCode: failure.errorCode,
      repairAttempts,
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : "CONFIG_ERROR";
    return {
      ok: false,
      errorCode: ["CANCELLED", "PROVIDER_TIMEOUT", "COST_LIMIT"].includes(code)
        ? (code as AiErrorCode)
        : "CONFIG_ERROR",
      repairAttempts,
    };
  }
}

/** Ordinary API projection deliberately contains no parser classification or raw diagnostics. */
export function publicAiOutputFailure(failure: Extract<JsonRepairResult<unknown>, { ok: false }>) {
  const errorCode = failure.errorCode;
  return Object.freeze({
    status:
      errorCode === "VALIDATION_ERROR"
        ? 400
        : errorCode === "RATE_LIMITED" || errorCode === "COST_LIMIT"
          ? 429
          : errorCode === "CANCELLED"
            ? 409
            : 503,
    errorCode,
  });
}
