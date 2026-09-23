import type { NluExtractOutput } from "@/lib/ai/schema-types";
import { mapTravelParameters } from "@/server/services/nlu/extract-parameters";
import { output } from "./fixtures";

export function parameters(text: string, candidates: NluExtractOutput["candidates"]) {
  return mapTravelParameters(text, output(candidates));
}
