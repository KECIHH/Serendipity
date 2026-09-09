import { parseEnv, type EnvParserContext, type EnvSource } from "./env-schema";

/** CLI consumers explicitly select their registered scope without importing Next.js. */
export function readCliEnv(source: EnvSource = process.env, context: EnvParserContext = {}) {
  return parseEnv(source, "cli", context);
}
