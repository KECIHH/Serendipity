import "server-only";

import { createHash } from "node:crypto";
import type { Destination, NluExtractOutput, Origin, DateRange } from "@/lib/ai/schema-types";
import { db } from "@/server/db";
import { guardedJsonChat } from "@/server/ai/guarded-client";
import type { NluContext } from "@/server/ai/nlu-context";
import { parseRelativeDate } from "./date-parser";

export interface CoreEntities {
  readonly origin: Origin | null;
  readonly destinations: ReadonlyArray<Destination>;
  readonly dateRange: DateRange | null;
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
const provinceNames = new Set([
  "云南",
  "四川",
  "川西",
  "新疆",
  "西藏",
  "海南",
  "贵州",
  "广东",
  "浙江",
]);
const cityNames = new Set(["深圳", "广州", "北京", "上海", "成都", "杭州", "重庆", "西安"]);
function stableId(value: string, index: number): string {
  return `destination-${index + 1}-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}
function confidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}
function parseOrigin(text: string, score: number): Origin {
  return { city: text, country: "CN", confidence: confidence(score) };
}
function destination(name: string, index: number, score: number): Destination {
  const country = countryNames[name] ?? (name.includes("中国") ? "CN" : null);
  const type: Destination["type"] = countryNames[name]
    ? "country"
    : provinceNames.has(name)
      ? "province"
      : /山|湖|古镇|稻城|武功/.test(name)
        ? "attraction"
        : cityNames.has(name)
          ? "city"
          : "region";
  return {
    id: stableId(name, index),
    name,
    city: type === "city" ? name : null,
    country,
    type,
    confidence: confidence(score),
  };
}
function splitDestinations(text: string): string[] {
  return text
    .split(/[+＋、,，及和与]/u)
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
  const originCandidate = candidateText(output, "origin").find((item) =>
    isUserSpan(userInput, item),
  );
  const destinationCandidates = candidateText(output, "destinations").filter((item) =>
    isUserSpan(userInput, item),
  );
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
  const parsedDate = dateCandidate
    ? parseRelativeDate(`${dateCandidate.text} ${userInput}`, context)
    : null;
  const dateRange = parsedDate
    ? {
        ...parsedDate,
        text: dateCandidate?.text ?? null,
        confidence: confidence(dateCandidate?.confidence ?? 0),
      }
    : null;
  return { origin, destinations, dateRange };
}

export async function extractCoreEntities(
  userInput: string,
  ctx: NluContext,
): Promise<CoreEntities> {
  const result = await guardedJsonChat(
    {
      promptKey: "nlu.extract",
      variables: {
        userText: userInput,
        locale: ctx.locale,
        serverDate: ctx.serverDate,
        timezone: ctx.timezone,
        stage: "CORE",
      },
      userMessage: userInput,
      context: ctx,
    },
    { db },
  );
  if (!result.ok) throw new Error(result.errorCode);
  return mapCoreCandidates(userInput, result.output as NluExtractOutput, ctx);
}
