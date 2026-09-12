export type AdminUserRole = "USER" | "ADMIN";
export type AdminUserStatus = "ACTIVE" | "DISABLED";

/** The only management user DTO. Dates cross the HTTP boundary as ISO strings. */
export interface AdminUserDto {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: AdminUserRole;
  status: AdminUserStatus;
  lastLoginAt: string | null;
  createdAt: string;
  revision: number;
}

export interface AdminUserPage {
  items: AdminUserDto[];
  nextCursor: string | null;
}

export interface AdminUserPatch {
  role: AdminUserRole;
  status: AdminUserStatus;
  expectedVersion: number;
  reason: string;
}

export interface AdminUserQuery {
  role?: AdminUserRole;
  status?: AdminUserStatus;
  cursor?: string;
  limit: number;
}

export class AdminUserInputError extends Error {
  constructor() {
    super("用户管理请求无效");
    this.name = "AdminUserInputError";
  }
}

export function parseAdminUserId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new AdminUserInputError();
  }
  return value;
}

/** Exact keys and data descriptors prevent extra identity fields and executable objects. */
export function parseAdminUserPatch(value: unknown): AdminUserPatch {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AdminUserInputError();
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new AdminUserInputError();
  const required = ["role", "status", "expectedVersion", "reason"] as const;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== required.length ||
    keys.some((key) => !required.some((name) => name === key))
  ) {
    throw new AdminUserInputError();
  }
  const fields: Record<string, unknown> = Object.create(null);
  for (const key of required) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new AdminUserInputError();
    fields[key] = descriptor.value as unknown;
  }
  if (
    (fields.role !== "ADMIN" && fields.role !== "USER") ||
    (fields.status !== "ACTIVE" && fields.status !== "DISABLED") ||
    typeof fields.expectedVersion !== "number" ||
    !Number.isInteger(fields.expectedVersion) ||
    fields.expectedVersion < 0 ||
    fields.expectedVersion > 2_147_483_647 ||
    typeof fields.reason !== "string" ||
    fields.reason.length > 2_000 ||
    !fields.reason.isWellFormed()
  ) {
    throw new AdminUserInputError();
  }
  const reason = fields.reason.trim();
  if (reason.length < 1 || reason.length > 500 || /[\u0000-\u001f\u007f]/u.test(reason)) {
    throw new AdminUserInputError();
  }
  return {
    role: fields.role,
    status: fields.status,
    expectedVersion: fields.expectedVersion,
    reason,
  };
}

export function parseAdminUserQuery(parameters: URLSearchParams): AdminUserQuery {
  const allowed = new Set(["role", "status", "cursor", "limit"]);
  for (const key of parameters.keys()) {
    if (!allowed.has(key) || parameters.getAll(key).length !== 1) throw new AdminUserInputError();
  }
  const role = parameters.get("role"),
    status = parameters.get("status");
  const cursor = parameters.get("cursor"),
    limit = parameters.get("limit");
  if (
    (role !== null && role !== "ADMIN" && role !== "USER") ||
    (status !== null && status !== "ACTIVE" && status !== "DISABLED") ||
    (cursor !== null && (cursor.length < 1 || cursor.length > 2_048)) ||
    (limit !== null && (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100))
  ) {
    throw new AdminUserInputError();
  }
  return {
    ...(role === null ? {} : { role }),
    ...(status === null ? {} : { status }),
    ...(cursor === null ? {} : { cursor }),
    limit: limit === null ? 20 : Number(limit),
  };
}
