/** Pure environment registry and parser shared by the Web and CLI entry points. */
export type EnvScope = "server" | "client" | "cli" | "test";
export type EnvValue = string | number | boolean;
export type EnvSource = Readonly<Record<string, string | undefined>>;
export type EnvSchema =
  | "postgresql-url"
  | "secret-min-length:32"
  | "base64-bytes:32"
  | "string"
  | "https-url"
  | "auth-origin"
  | "non-empty"
  | "boolean-literal"
  | "integer-min:1000"
  | "finite-positive-number";

export type EnvRegistryEntry = Readonly<{
  key: string;
  scope: EnvScope;
  producerPhase: number;
  requiredWhen: "always" | "platform-provided" | "AI_MOCK=false" | "seed";
  secret: boolean;
  schema: EnvSchema;
  defaultValue?: string;
  documentInExample: boolean;
  readerPaths: readonly string[];
}>;

export const ENV_SCHEMA_PHASE = 11;

export const envRegistry = [
  {
    key: "DATABASE_URL",
    scope: "server",
    producerPhase: 4,
    requiredWhen: "always",
    secret: true,
    schema: "postgresql-url",
    documentInExample: true,
    readerPaths: ["src/lib/env.ts", "vitest.setup.ts"],
  },
  {
    key: "AUTH_SECRET",
    scope: "server",
    producerPhase: 4,
    requiredWhen: "always",
    secret: true,
    schema: "secret-min-length:32",
    documentInExample: true,
    readerPaths: ["src/lib/env.ts", "vitest.setup.ts"],
  },
  {
    key: "AUTH_URL",
    scope: "server",
    producerPhase: 11,
    requiredWhen: "always",
    secret: false,
    schema: "auth-origin",
    defaultValue: "http://localhost:3000",
    documentInExample: true,
    readerPaths: ["src/lib/env.ts", "src/lib/env-cli.ts", "src/middleware.ts", "vitest.setup.ts"],
  },
  {
    key: "AUTH_TRUSTED_PROXY_CIDRS",
    scope: "server",
    producerPhase: 11,
    requiredWhen: "always",
    secret: false,
    schema: "string",
    defaultValue: "",
    documentInExample: true,
    readerPaths: ["src/lib/env.ts", "src/lib/env-cli.ts", "vitest.setup.ts"],
  },
  {
    key: "ENCRYPTION_KEY",
    scope: "server",
    producerPhase: 4,
    requiredWhen: "always",
    secret: true,
    schema: "base64-bytes:32",
    documentInExample: true,
    readerPaths: ["src/lib/env.ts", "vitest.setup.ts"],
  },
  {
    key: "AI_API_KEY",
    scope: "server",
    producerPhase: 4,
    requiredWhen: "AI_MOCK=false",
    secret: true,
    schema: "string",
    documentInExample: true,
    readerPaths: ["src/lib/env.ts", "vitest.setup.ts"],
  },
  {
    key: "AI_BASE_URL",
    scope: "server",
    producerPhase: 4,
    requiredWhen: "always",
    secret: false,
    schema: "https-url",
    defaultValue: "https://api.deepseek.com",
    documentInExample: true,
    readerPaths: ["src/lib/env.ts", "vitest.setup.ts"],
  },
  {
    key: "AI_MODEL",
    scope: "server",
    producerPhase: 4,
    requiredWhen: "always",
    secret: false,
    schema: "non-empty",
    defaultValue: "deepseek-chat",
    documentInExample: true,
    readerPaths: ["src/lib/env.ts", "vitest.setup.ts"],
  },
  {
    key: "AI_MOCK",
    scope: "server",
    producerPhase: 4,
    requiredWhen: "always",
    secret: false,
    schema: "boolean-literal",
    defaultValue: "true",
    documentInExample: true,
    readerPaths: ["src/lib/env.ts", "vitest.setup.ts"],
  },
  {
    key: "AI_TIMEOUT_MS",
    scope: "server",
    producerPhase: 4,
    requiredWhen: "always",
    secret: false,
    schema: "integer-min:1000",
    defaultValue: "60000",
    documentInExample: true,
    readerPaths: ["src/lib/env.ts", "vitest.setup.ts"],
  },
  {
    key: "AI_DAILY_COST_LIMIT",
    scope: "server",
    producerPhase: 4,
    requiredWhen: "always",
    secret: false,
    schema: "finite-positive-number",
    defaultValue: "5",
    documentInExample: true,
    readerPaths: ["src/lib/env.ts", "vitest.setup.ts"],
  },
  {
    key: "NODE_ENV",
    scope: "server",
    producerPhase: 4,
    requiredWhen: "platform-provided",
    secret: false,
    schema: "string",
    documentInExample: false,
    readerPaths: ["next.config.ts", "vitest.config.ts"],
  },
  {
    key: "PORT",
    scope: "server",
    producerPhase: 4,
    requiredWhen: "platform-provided",
    secret: false,
    schema: "string",
    documentInExample: false,
    readerPaths: ["next.config.ts"],
  },
  {
    key: "ADMIN_EMAIL",
    scope: "cli",
    producerPhase: 10,
    requiredWhen: "seed",
    secret: false,
    schema: "non-empty",
    documentInExample: false,
    readerPaths: ["src/lib/env-cli.ts"],
  },
  {
    key: "ADMIN_INITIAL_PASSWORD",
    scope: "cli",
    producerPhase: 10,
    requiredWhen: "seed",
    secret: true,
    schema: "string",
    documentInExample: false,
    readerPaths: ["src/lib/env-cli.ts"],
  },
] as const satisfies readonly EnvRegistryEntry[];

export type EnvParserContext = Readonly<{
  registry?: readonly EnvRegistryEntry[];
  currentPhase?: number;
  command?: "seed";
}>;

type ValueForSchema<T extends EnvSchema> = T extends "boolean-literal"
  ? boolean
  : T extends "integer-min:1000" | "finite-positive-number"
    ? number
    : string;
type ScopedEntry<S extends EnvScope> = Extract<(typeof envRegistry)[number], { scope: S }>;
type EnvConfig<S extends EnvScope> = {
  readonly [Entry in ScopedEntry<S> as Entry["requiredWhen"] extends "platform-provided"
    ? never
    : Entry["key"]]: ValueForSchema<Entry["schema"]>;
} & {
  readonly [Entry in ScopedEntry<S> as Entry["requiredWhen"] extends "platform-provided"
    ? Entry["key"]
    : never]?: ValueForSchema<Entry["schema"]>;
};

export class EnvConfigError extends Error {
  readonly missing: readonly string[];
  readonly invalid: readonly string[];

  constructor(missing: readonly string[], invalid: readonly string[], issues: readonly string[]) {
    super(
      `Environment configuration is invalid:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
    );
    this.name = "EnvConfigError";
    this.missing = Object.freeze([...missing]);
    this.invalid = Object.freeze([...invalid]);
  }
}

/** Validate registration before either parsing values or projecting documentation. */
export function validateEnvRegistry(entries: readonly EnvRegistryEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(entry.key)) {
      throw new Error("Invalid environment registry key");
    }
    if (seen.has(entry.key)) {
      throw new Error(`Duplicate environment registry key: ${entry.key}`);
    }
    seen.add(entry.key);
    if (!Number.isInteger(entry.producerPhase) || entry.producerPhase < 0) {
      throw new Error(`Invalid producerPhase: ${entry.key}`);
    }
    if (entry.scope === "client" && entry.secret) {
      throw new Error(`Secret environment key cannot use client scope: ${entry.key}`);
    }
    if (entry.secret && entry.key.startsWith("NEXT_PUBLIC_")) {
      throw new Error(`Secret environment key cannot be public: ${entry.key}`);
    }
  }
}

export function requiredEnvKeys(
  scope: EnvScope,
  context: EnvParserContext = {},
): readonly string[] {
  const entries = context.registry ?? envRegistry;
  validateEnvRegistry(entries);
  return Object.freeze(
    entries
      .filter(
        (entry) =>
          entry.scope === scope &&
          entry.producerPhase <= (context.currentPhase ?? ENV_SCHEMA_PHASE) &&
          (entry.requiredWhen !== "seed" || context.command === "seed") &&
          entry.requiredWhen !== "platform-provided",
      )
      .map((entry) => entry.key),
  );
}

function isBase64(value: string, expectedBytes: number): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  try {
    const decoded = atob(value);
    return decoded.length === expectedBytes && btoa(decoded) === value;
  } catch {
    return false;
  }
}

function parseValue(value: string, schema: EnvSchema): EnvValue | null {
  switch (schema) {
    case "postgresql-url":
      return value.length > 0 && value.startsWith("postgresql://") ? value : null;
    case "secret-min-length:32":
      return value.length >= 32 ? value : null;
    case "base64-bytes:32":
      return isBase64(value, 32) ? value : null;
    case "https-url": {
      try {
        return new URL(value).protocol === "https:" ? value : null;
      } catch {
        return null;
      }
    }
    case "auth-origin": {
      try {
        const url = new URL(value);
        const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        if (
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== "/" ||
          (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
          (value !== url.origin && value !== `${url.origin}/`)
        )
          return null;
        return url.origin;
      } catch {
        return null;
      }
    }
    case "non-empty":
      return value.trim().length > 0 ? value : null;
    case "boolean-literal":
      return value === "true" ? true : value === "false" ? false : null;
    case "integer-min:1000": {
      const parsed = Number(value);
      return /^\d+$/.test(value) && Number.isSafeInteger(parsed) && parsed >= 1000 ? parsed : null;
    }
    case "finite-positive-number": {
      const parsed = Number(value);
      return value.trim().length > 0 && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    case "string":
      return value;
  }
}

export function parseEnv<S extends EnvScope>(source: EnvSource, scope: S): EnvConfig<S>;
export function parseEnv(
  source: EnvSource,
  scope: EnvScope,
  context: EnvParserContext,
): Readonly<Record<string, EnvValue>>;
/** Only registered, active inputs for the requested scope are read. Defaults are documentation only. */
export function parseEnv(
  source: EnvSource,
  scope: EnvScope,
  context: EnvParserContext = {},
): Readonly<Record<string, EnvValue>> {
  const registry = context.registry ?? envRegistry;
  validateEnvRegistry(registry);
  const entries = registry.filter(
    (entry) =>
      entry.scope === scope &&
      entry.producerPhase <= (context.currentPhase ?? ENV_SCHEMA_PHASE) &&
      (entry.requiredWhen !== "seed" || context.command === "seed"),
  );
  const missing: string[] = [];
  const invalid: string[] = [];
  const issues: string[] = [];
  const parsed: Record<string, EnvValue> = {};

  for (const entry of entries) {
    const value = source[entry.key];
    if (value === undefined) {
      if (entry.requiredWhen !== "platform-provided") {
        missing.push(entry.key);
        issues.push(`${entry.key}: value is required`);
      }
      continue;
    }
    if (
      entry.requiredWhen === "AI_MOCK=false" &&
      source.AI_MOCK === "false" &&
      value.trim().length === 0
    ) {
      invalid.push(entry.key);
      issues.push(`${entry.key}: must be non-empty when AI_MOCK=false`);
      continue;
    }
    const result = parseValue(value, entry.schema);
    if (result === null) {
      invalid.push(entry.key);
      issues.push(`${entry.key}: does not match ${entry.schema}`);
      continue;
    }
    parsed[entry.key] = result;
  }
  if (missing.length > 0 || invalid.length > 0) {
    throw new EnvConfigError(missing, invalid, issues);
  }
  return Object.freeze(parsed);
}

export function exampleEnvKeys(context: EnvParserContext = {}): readonly string[] {
  const entries = context.registry ?? envRegistry;
  validateEnvRegistry(entries);
  return Object.freeze(
    entries
      .filter(
        (entry) =>
          entry.documentInExample &&
          entry.producerPhase <= (context.currentPhase ?? ENV_SCHEMA_PHASE) &&
          (entry.scope === "server" || entry.scope === "client"),
      )
      .map((entry) => entry.key),
  );
}

/** Check the example key set without reading or disclosing any configuration values. */
export function validateEnvExample(example: string, context: EnvParserContext = {}): void {
  const expected = new Set(exampleEnvKeys(context));
  const seen = new Set<string>();
  for (const line of example.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (!match) throw new Error("Invalid environment example entry");
    const key = match[1];
    if (!expected.has(key)) throw new Error(`Undocumented or unregistered environment key: ${key}`);
    if (seen.has(key)) throw new Error(`Duplicate environment example key: ${key}`);
    seen.add(key);
  }
  const missing = [...expected].filter((key) => !seen.has(key));
  if (missing.length > 0)
    throw new Error(`Missing environment example keys: ${missing.join(", ")}`);
}

/** Edge routing consumes only the registered public origin, never the full server environment. */
export function readAuthOrigin(source: EnvSource): string {
  const parsed = parseEnv(source, "server", {
    currentPhase: 11,
    registry: envRegistry.filter((entry) => entry.key === "AUTH_URL"),
  });
  return String(parsed.AUTH_URL);
}
