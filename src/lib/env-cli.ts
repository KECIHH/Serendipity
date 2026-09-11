import { envRegistry, parseEnv, type EnvParserContext, type EnvSource } from "./env-schema";

/** CLI consumers explicitly select their registered scope without importing Next.js. */
export function readCliEnv(source: EnvSource = process.env, context: EnvParserContext = {}) {
  return parseEnv(source, "cli", context);
}

/** A seed command has no dependency on Web authentication or Provider credentials. */
export function readSeedEnv(source: EnvSource = process.env) {
  return Object.freeze({
    ...parseEnv(source, "server", {
      currentPhase: 10,
      registry: envRegistry.filter((entry) => ["NODE_ENV", "DATABASE_URL"].includes(entry.key)),
    }),
    ...readCliEnv(source, { currentPhase: 10, command: "seed" }),
  });
}

/** Node ingress reads only its registered server inputs after Next loads local env files. */
export function readAuthServerEnv(source: EnvSource = process.env) {
  return parseEnv(source, "server", {
    currentPhase: 11,
    registry: envRegistry.filter((entry) =>
      ["NODE_ENV", "PORT", "AUTH_SECRET", "AUTH_URL", "AUTH_TRUSTED_PROXY_CIDRS"].includes(
        entry.key,
      ),
    ),
  });
}
