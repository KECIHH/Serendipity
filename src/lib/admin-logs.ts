export interface AuditQuery {
  cursor?: string;
  limit: number;
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
}

/** Only this projection crosses the audit HTTP boundary. */
export interface AuditSummary {
  id: string;
  actorType: "USER" | "ADMIN" | "SYSTEM";
  actorId: string | null;
  targetType: string;
  targetId: string | null;
  action: string;
  requestId: string | null;
  traceId: string | null;
  createdAt: string;
  safeSummary: string;
}

export interface AuditLogPage {
  items: AuditSummary[];
  nextCursor: string | null;
}

export class AdminLogInputError extends Error {
  constructor() {
    super("审计查询条件无效");
    this.name = "AdminLogInputError";
  }
}

export function auditIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new AdminLogInputError();
  }
  return value;
}

/** Validate the calendar before Date parsing, which otherwise normalizes invalid dates. */
export function auditInstant(value: unknown): string {
  if (typeof value !== "string" || value.length > 35) throw new AdminLogInputError();
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) throw new AdminLogInputError();
  const [, y, m, d, h, minute, second, , offset] = match;
  const year = Number(y),
    month = Number(m),
    day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    Number(h) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59))
  )
    throw new AdminLogInputError();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new AdminLogInputError();
  return date.toISOString();
}

export function parseAuditQuery(parameters: URLSearchParams): AuditQuery {
  if (parameters.toString().length > 4_096) throw new AdminLogInputError();
  const allowed = new Set([
    "cursor",
    "limit",
    "actorId",
    "action",
    "targetType",
    "targetId",
    "from",
    "to",
  ]);
  for (const key of parameters.keys()) {
    if (!allowed.has(key) || parameters.getAll(key).length !== 1) throw new AdminLogInputError();
  }
  const result: AuditQuery = { limit: 20 };
  const limit = parameters.get("limit"),
    cursor = parameters.get("cursor");
  if (limit !== null) {
    if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100) throw new AdminLogInputError();
    result.limit = Number(limit);
  }
  if (cursor !== null) {
    if (cursor.length < 1 || cursor.length > 2_048 || /[\r\n\0]/.test(cursor))
      throw new AdminLogInputError();
    result.cursor = cursor;
  }
  for (const field of ["actorId", "targetId"] as const) {
    const value = parameters.get(field);
    if (value !== null) result[field] = auditIdentifier(value);
  }
  for (const field of ["action", "targetType"] as const) {
    const value = parameters.get(field);
    if (value !== null) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)) throw new AdminLogInputError();
      result[field] = value;
    }
  }
  for (const field of ["from", "to"] as const) {
    const value = parameters.get(field);
    if (value !== null) result[field] = auditInstant(value);
  }
  if (result.from && result.to && result.from > result.to) throw new AdminLogInputError();
  return result;
}

const fields = [
  "id",
  "actorType",
  "actorId",
  "targetType",
  "targetId",
  "action",
  "requestId",
  "traceId",
  "createdAt",
  "safeSummary",
];
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isAuditLogPage(value: unknown): value is AuditLogPage {
  if (
    !record(value) ||
    Object.keys(value).length !== 2 ||
    !Array.isArray(value.items) ||
    value.items.length > 100 ||
    !(
      value.nextCursor === null ||
      (typeof value.nextCursor === "string" && value.nextCursor.length <= 2_048)
    )
  )
    return false;
  return value.items.every((item: unknown) => {
    if (
      !record(item) ||
      Object.keys(item).length !== fields.length ||
      Object.keys(item).some((key) => !fields.includes(key))
    )
      return false;
    if (
      typeof item.actorType !== "string" ||
      !["USER", "ADMIN", "SYSTEM"].includes(item.actorType) ||
      typeof item.safeSummary !== "string" ||
      item.safeSummary.length < 1 ||
      item.safeSummary.length > 4_000
    )
      return false;
    try {
      auditIdentifier(item.id);
      for (const field of ["actorId", "targetId", "requestId", "traceId"])
        if (item[field] !== null) auditIdentifier(item[field]);
      if (
        typeof item.action !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(item.action) ||
        typeof item.targetType !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(item.targetType)
      )
        return false;
      auditInstant(item.createdAt);
      return true;
    } catch {
      return false;
    }
  });
}
