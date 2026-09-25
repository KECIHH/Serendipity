import "server-only";

import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { Destination, NluExtractOutput, Origin } from "@/lib/ai/schema-types";
import { NluExtractOutputSchema } from "@/lib/ai/schemas";
import { CoreEntitiesSchema, type CoreEntities } from "@/lib/schemas/core-entities";
import type { GuardedAiClientOptions } from "@/server/ai/guarded-client";
import { NLU_EXTRACT_PROMPT_KEY } from "@/lib/ai/prompts/nlu-extract";
import { db } from "@/server/db";
import { guardedJsonChat } from "@/server/ai/guarded-client";
import type { NluContext } from "@/server/ai/nlu-context";
import { nluCommandBinding } from "./command-binding";
import { parseRelativeDate } from "./date-parser";

export type { CoreEntities } from "@/lib/schemas/core-entities";

type GuardedCallOptions = Omit<GuardedAiClientOptions, "db" | "owner" | "nluContext">;

export interface ExtractCoreEntitiesOptions extends GuardedCallOptions {
  readonly db?: PrismaClient;
  readonly attemptNo?: number;
  readonly travelRecordId?: string;
}

const countryNames: Readonly<Record<string, string>> = {
  日本: "JP",
  中国: "CN",
  美国: "US",
  加拿大: "CA",
  英国: "GB",
  韩国: "KR",
  泰国: "TH",
};
const provinceNames = new Set(["云南", "四川", "新疆", "西藏", "海南", "贵州", "广东", "浙江"]);
function stableId(value: string, index: number): string {
  return `destination-${index + 1}-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}
function confidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}
function parseOrigin(text: string, score: number): Origin {
  return {
    city: countryNames[text] ? null : text,
    country: countryNames[text] ?? null,
    confidence: confidence(score),
  };
}
function destination(name: string, index: number, score: number): Destination {
  const country = countryNames[name] ?? null;
  const type: Destination["type"] = countryNames[name]
    ? "country"
    : provinceNames.has(name)
      ? "province"
      : name === "川西"
        ? "region"
        : name === "武功山"
          ? "attraction"
          : null;
  return {
    id: stableId(name, index),
    name,
    city: null,
    country,
    type,
    confidence: confidence(score),
  };
}
function splitDestinations(text: string): string[] {
  return text
    .split(/[+＋、,，]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}
function candidateText(
  output: NluExtractOutput,
  field: NluExtractOutput["candidates"][number]["field"],
): NluExtractOutput["candidates"] {
  return output.candidates.filter((item) => item.field === field);
}

function isUserSpan(userInput: string, candidate: { readonly text: string }): boolean {
  return userInput.includes(candidate.text);
}

export function mapCoreCandidates(
  userInput: string,
  output: NluExtractOutput,
  context: Pick<NluContext, "timezone" | "serverDate" | "locale">,
): CoreEntities {
  NluExtractOutputSchema.parse(output);
  const originCandidate = candidateText(output, "origin").find((item) =>
    isUserSpan(userInput, item),
  );
  const destinationCandidates = candidateText(output, "destinations")
    .filter((item) => isUserSpan(userInput, item))
    .sort((a, b) => userInput.indexOf(a.text) - userInput.indexOf(b.text));
  const dateCandidate = candidateText(output, "dateRange").find((item) =>
    isUserSpan(userInput, item),
  );
  const origin = originCandidate
    ? parseOrigin(originCandidate.text, originCandidate.confidence)
    : null;
  const destinations = destinationCandidates
    .flatMap((item) =>
      splitDestinations(item.text).map((name) => ({ name, confidence: item.confidence })),
    )
    .map((item, index) => destination(item.name, index, item.confidence));
  const holidaySpan =
    dateCandidate && /国庆/.test(dateCandidate.text)
      ? userInput
          .slice(userInput.indexOf(dateCandidate.text))
          .match(/^[^，。；！？,;.!?\n]*?(?:[0-9]+|[一二两三四五六七八九十]+)\s*天/u)?.[0]
      : null;
  const parsedDate = dateCandidate
    ? parseRelativeDate(holidaySpan ?? dateCandidate.text, context)
    : null;
  const dateRange = parsedDate
    ? {
        ...parsedDate,
        text: dateCandidate?.text ?? null,
        confidence: confidence(dateCandidate?.confidence ?? 0),
      }
    : null;
  return CoreEntitiesSchema.parse({ origin, destinations, dateRange });
}

export async function extractCoreEntities(
  userInput: string,
  ctx: NluContext,
  options: ExtractCoreEntitiesOptions = {},
): Promise<CoreEntities> {
  const { db: callerDb, attemptNo, travelRecordId, ...guardedOptions } = options;
  const result = await guardedJsonChat(
    {
      promptKey: NLU_EXTRACT_PROMPT_KEY,
      variables: {
        userText: userInput,
        locale: ctx.locale,
        serverDate: ctx.serverDate,
        timezone: ctx.timezone,
        stage: "CORE",
      },
      userMessage: userInput,
      context: ctx,
      ...(attemptNo ? { attemptNo } : {}),
      ...nluCommandBinding(ctx, travelRecordId),
    },
    { ...guardedOptions, db: callerDb ?? db },
  );
  if (!result.ok) throw new Error(result.errorCode);
  return mapCoreCandidates(userInput, result.output as NluExtractOutput, ctx);
}
