export const SYSTEM_CONFIG_GROUPS = ["AI", "UI", "EXPORT", "SECURITY", "GENERAL"] as const;

export type SystemConfigGroup = (typeof SYSTEM_CONFIG_GROUPS)[number];

export function parseSystemConfigGroup(value: unknown): SystemConfigGroup {
  const group = SYSTEM_CONFIG_GROUPS.find((candidate) => candidate === value);
  if (group === undefined) {
    throw new TypeError("System configuration group is invalid");
  }
  return group;
}
