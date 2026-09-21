import type { NluExtractOutput } from "@/lib/ai/schema-types";
import type { NluContext } from "@/server/ai/nlu-context";
import { mapCoreCandidates } from "@/server/services/nlu/extract-core-entities";

export function context(
  serverDate = "2026-09-03",
): Pick<NluContext, "serverDate" | "timezone" | "locale"> {
  return { serverDate, timezone: "Asia/Shanghai", locale: "zh-CN" };
}
export function output(candidates: NluExtractOutput["candidates"]): NluExtractOutput {
  return { schemaVersion: 1, candidates };
}
export function entities(
  text: string,
  candidates: NluExtractOutput["candidates"],
  serverDate = "2026-09-03",
) {
  return mapCoreCandidates(text, output(candidates), context(serverDate));
}
