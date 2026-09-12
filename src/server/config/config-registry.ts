import "server-only";

import {
  configValue,
  exactObject,
  parseSettingKey,
  SettingInputError,
  type ConfigValue,
} from "@/lib/admin-settings";
import { stableStringify } from "@/lib/json";
import type { SystemConfigGroup } from "@/lib/schemas/system-config";

export interface DeploymentCaps {
  aiTimeoutMs: number;
}
interface ConfigEntry {
  readonly key: string;
  readonly group: SystemConfigGroup;
  readonly schema: {
    readonly parse: (value: ConfigValue) => ConfigValue;
    readonly description: string;
  };
  readonly defaultVisibility: "PRIVATE" | "PUBLIC";
  readonly public: boolean;
  readonly publicProjection: (value: ConfigValue) => ConfigValue | null;
  readonly deploymentCap?: (value: ConfigValue, caps: DeploymentCaps) => boolean;
}
const integer = (min: number, max: number) => (value: ConfigValue) => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new SettingInputError();
  return value;
};
const privateEntry = (
  key: string,
  group: SystemConfigGroup,
  description: string,
  parse: (value: ConfigValue) => ConfigValue,
): ConfigEntry =>
  Object.freeze({
    key,
    group,
    schema: Object.freeze({ parse, description }),
    defaultVisibility: "PRIVATE",
    public: false,
    publicProjection: () => null,
  });
function notice(value: ConfigValue): ConfigValue {
  const row = exactObject(value, ["enabled", "message", "internalNote"]);
  if (
    typeof row.enabled !== "boolean" ||
    typeof row.message !== "string" ||
    row.message.trim().length > 500 ||
    (row.enabled && row.message.trim().length === 0) ||
    (row.internalNote !== null &&
      (typeof row.internalNote !== "string" || row.internalNote.trim().length > 200))
  )
    throw new SettingInputError();
  return {
    enabled: row.enabled,
    message: row.message.trim(),
    internalNote: row.internalNote === null ? null : (row.internalNote as string).trim(),
  };
}
/** Only non-secret values. Registering a key does not create a future feature or a DB row. */
export const CONFIG_REGISTRY: readonly ConfigEntry[] = Object.freeze([
  privateEntry("planner.quick.defaultDurationDays", "GENERAL", "整数 1–30", integer(1, 30)),
  privateEntry("planner.quick.defaultTravelerCount", "GENERAL", "整数 1–20", integer(1, 20)),
  privateEntry("planner.quick.defaultPace", "GENERAL", "slow | moderate | fast", (value) => {
    if (value !== "slow" && value !== "moderate" && value !== "fast") throw new SettingInputError();
    return value;
  }),
  Object.freeze({
    ...privateEntry(
      "ai.timeoutMs",
      "AI",
      "整数 1000–120000，且不超过部署 AI_TIMEOUT_MS",
      integer(1_000, 120_000),
    ),
    deploymentCap: (value: ConfigValue, caps: DeploymentCaps) =>
      typeof value === "number" &&
      Number.isSafeInteger(caps.aiTimeoutMs) &&
      caps.aiTimeoutMs >= 1_000 &&
      value <= caps.aiTimeoutMs,
  }),
  privateEntry("export.maxDurationDays", "EXPORT", "整数 1–30；部署硬上限 30", integer(1, 30)),
  privateEntry("security.adminPageSize", "SECURITY", "整数 1–100；部署硬上限 100", integer(1, 100)),
  Object.freeze({
    key: "ui.notice",
    group: "UI",
    schema: Object.freeze({
      parse: notice,
      description: "{ enabled: boolean, message: string≤500, internalNote: string≤200 | null }",
    }),
    defaultVisibility: "PUBLIC",
    public: true,
    publicProjection: (value: ConfigValue) => {
      const row = exactObject(notice(value), ["enabled", "message", "internalNote"]);
      return { enabled: row.enabled as boolean, message: row.message as string };
    },
  }),
]);
export function configDefinition(key: string): ConfigEntry {
  parseSettingKey(key);
  const entry = CONFIG_REGISTRY.find((item) => item.key === key);
  if (!entry) throw new SettingInputError();
  return entry;
}
export function parseConfig(key: string, value: unknown, caps: DeploymentCaps): ConfigValue {
  const entry = configDefinition(key);
  const normalized = entry.schema.parse(configValue(value));
  if (entry.deploymentCap && !entry.deploymentCap(normalized, caps)) throw new SettingInputError();
  // A deterministic, detached copy; no implicit coercion or toJSON hooks.
  return JSON.parse(stableStringify(normalized)) as ConfigValue;
}
export const PUBLIC_CONFIG_KEYS = Object.freeze(
  CONFIG_REGISTRY.filter((entry) => entry.public).map((entry) => entry.key),
);
