import { stableStringify } from "@/lib/json";
import { parseSystemConfigGroup, type SystemConfigGroup } from "@/lib/schemas/system-config";

export type ConfigValue =
  | null
  | boolean
  | number
  | string
  | ConfigValue[]
  | { [key: string]: ConfigValue };
export interface SettingPatch {
  valueJson: ConfigValue;
  expectedVersion: number;
}
export interface AdminSetting {
  key: string;
  valueJson: ConfigValue;
  description: string;
  group: SystemConfigGroup;
  isPublic: boolean;
  revision: number;
  updatedAt: string;
}
export interface AdminSettings {
  items: AdminSetting[];
}
export interface PublicConfig {
  items: Array<{ key: string; value: ConfigValue }>;
}

export class SettingInputError extends Error {
  constructor() {
    super("配置值不符合要求");
    this.name = "SettingInputError";
  }
}
export function exactObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(value, key))
  )
    throw new SettingInputError();
  const result: Record<string, unknown> = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new SettingInputError();
    result[key] = descriptor.value;
  }
  return result;
}
/** Bound before traversing/serializing, including fields which a projection later removes. */
export function configValue(value: unknown): ConfigValue {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): ConfigValue => {
    if (++nodes > 256 || depth > 6) throw new SettingInputError();
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new SettingInputError();
      return Object.is(item, -0) ? 0 : item;
    }
    if (typeof item === "string") {
      if (
        !item.isWellFormed() ||
        item.length > 2_048 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(item)
      )
        throw new SettingInputError();
      return item;
    }
    if (!item || typeof item !== "object" || ancestors.has(item)) throw new SettingInputError();
    ancestors.add(item);
    let result: ConfigValue;
    if (Array.isArray(item)) {
      if (item.length > 32 || Reflect.ownKeys(item).length !== item.length + 1)
        throw new SettingInputError();
      result = Array.from({ length: item.length }, (_, i) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor?.enumerable || !("value" in descriptor)) throw new SettingInputError();
        return visit(descriptor.value, depth + 1);
      });
    } else {
      const keys = Reflect.ownKeys(item);
      if (
        keys.length > 32 ||
        keys.some(
          (key) =>
            typeof key !== "string" ||
            key.length > 100 ||
            ["__proto__", "constructor", "prototype"].includes(key),
        )
      )
        throw new SettingInputError();
      const row = exactObject(item, keys as string[]);
      result = Object.fromEntries(
        Object.entries(row).map(([key, child]) => [key, visit(child, depth + 1)]),
      );
    }
    ancestors.delete(item);
    return result;
  };
  const parsed = visit(value, 0);
  if (new TextEncoder().encode(stableStringify(parsed)).byteLength > 8_192)
    throw new SettingInputError();
  return parsed;
}
export function parseSettingKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*){1,5}$/.test(value) ||
    value.length > 100
  )
    throw new SettingInputError();
  return value;
}
export function parseSettingPatch(value: unknown): SettingPatch {
  const row = exactObject(value, ["valueJson", "expectedVersion"]);
  if (
    typeof row.expectedVersion !== "number" ||
    !Number.isInteger(row.expectedVersion) ||
    row.expectedVersion < 0 ||
    row.expectedVersion > 2_147_483_646
  )
    throw new SettingInputError();
  return { valueJson: configValue(row.valueJson), expectedVersion: row.expectedVersion };
}
export function parseAdminSetting(value: unknown): AdminSetting {
  const row = exactObject(value, [
    "key",
    "valueJson",
    "description",
    "group",
    "isPublic",
    "revision",
    "updatedAt",
  ]);
  if (
    typeof row.description !== "string" ||
    row.description.length > 500 ||
    typeof row.isPublic !== "boolean" ||
    typeof row.revision !== "number" ||
    !Number.isInteger(row.revision) ||
    row.revision < 0 ||
    row.revision > 2_147_483_647 ||
    typeof row.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(row.updatedAt)) ||
    new Date(row.updatedAt).toISOString() !== row.updatedAt
  )
    throw new SettingInputError();
  return {
    key: parseSettingKey(row.key),
    valueJson: configValue(row.valueJson),
    description: row.description,
    group: parseSystemConfigGroup(row.group),
    isPublic: row.isPublic,
    revision: row.revision,
    updatedAt: row.updatedAt,
  };
}
export function parseAdminSettings(value: unknown): AdminSettings {
  const row = exactObject(value, ["items"]);
  if (!Array.isArray(row.items) || row.items.length > 100) throw new SettingInputError();
  const items = row.items.map(parseAdminSetting);
  if (new Set(items.map((item) => item.key)).size !== items.length) throw new SettingInputError();
  return { items };
}
