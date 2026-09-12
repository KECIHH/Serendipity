export type ApiKeyStatus = "ACTIVE" | "DISABLED" | "REVOKED";
export type KeyRotationStage = "PREPARING" | "TESTING" | "READY" | "ACTIVATED" | "ABORTED";

export interface ApiKeyDto {
  id: string;
  name: string;
  provider: string;
  keyFingerprintDisplay: string;
  status: ApiKeyStatus;
  revision: number;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyPage {
  items: ApiKeyDto[];
  nextCursor: string | null;
}

export interface ApiKeyCreate {
  name: string;
  provider: string;
  plainKey: string;
}

export interface ApiKeyPatch {
  name?: string;
  status?: ApiKeyStatus;
  expectedVersion: number;
}

export interface ApiKeyRotateRequest extends ApiKeyCreate {
  expectedVersion: number;
}

export interface KeyRotationReceipt {
  key: ApiKeyDto;
  stage: KeyRotationStage;
  affectedConfigCount: number;
  errorCode: string | null;
  replayed: boolean;
}

export interface ApiKeyQuery {
  provider?: string;
  status?: ApiKeyStatus;
  cursor?: string;
  limit: number;
}

export class ApiKeyInputError extends Error {
  constructor() {
    super("密钥管理请求无效");
    this.name = "ApiKeyInputError";
  }
}

function invalid(): never {
  throw new ApiKeyInputError();
}

export function parseApiKeyId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) invalid();
  return value;
}

function object(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || ![...required, ...optional].includes(key)))
    invalid();
  if (required.some((key) => !Object.hasOwn(value, key))) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
    result[key as string] = descriptor.value as unknown;
  }
  return result;
}

function name(value: unknown): string {
  if (typeof value !== "string" || value.length > 512 || !value.isWellFormed()) invalid();
  const result = value.trim();
  if (result.length < 1 || [...result].length > 200 || /[\u0000-\u001f\u007f]/u.test(result))
    invalid();
  return result;
}

function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 2_147_483_647)
    invalid();
  return value;
}

function status(value: unknown): ApiKeyStatus {
  if (value !== "ACTIVE" && value !== "DISABLED" && value !== "REVOKED") invalid();
  return value;
}

/** Boundary trimming is the only normalization of a secret. Never use this value in React state. */
function secret(value: unknown): string {
  if (typeof value !== "string" || value.length > 32_768 || !value.isWellFormed()) invalid();
  const result = value.trim();
  const length = new TextEncoder().encode(result).byteLength;
  if (length < 1 || length > 16_384) invalid();
  return result;
}

export function parseApiKeyCreate(value: unknown): ApiKeyCreate {
  const row = object(value, ["name", "provider", "plainKey"]);
  return {
    name: name(row.name),
    provider: parseApiKeyId(row.provider),
    plainKey: secret(row.plainKey),
  };
}

export function parseApiKeyPatch(value: unknown): ApiKeyPatch {
  const row = object(value, ["expectedVersion"], ["name", "status"]);
  if (!Object.hasOwn(row, "name") && !Object.hasOwn(row, "status")) invalid();
  return {
    expectedVersion: revision(row.expectedVersion),
    ...(Object.hasOwn(row, "name") ? { name: name(row.name) } : {}),
    ...(Object.hasOwn(row, "status") ? { status: status(row.status) } : {}),
  };
}

export function parseApiKeyRotateRequest(value: unknown): ApiKeyRotateRequest {
  const row = object(value, ["name", "provider", "plainKey", "expectedVersion"]);
  return {
    name: name(row.name),
    provider: parseApiKeyId(row.provider),
    plainKey: secret(row.plainKey),
    expectedVersion: revision(row.expectedVersion),
  };
}

export function assertApiKeyTransition(current: ApiKeyStatus, next: ApiKeyStatus): void {
  status(current);
  status(next);
  // API_KEY_REVOKED_TERMINAL
  if (current === "REVOKED" && next !== "REVOKED") throw new ApiKeyInputError();
}

export function parseApiKeyQuery(parameters: URLSearchParams): ApiKeyQuery {
  const allowed = ["provider", "status", "cursor", "limit"];
  for (const key of parameters.keys())
    if (!allowed.includes(key) || parameters.getAll(key).length !== 1) invalid();
  const provider = parameters.get("provider"),
    state = parameters.get("status");
  const cursor = parameters.get("cursor"),
    limit = parameters.get("limit");
  if (cursor !== null && (cursor.length < 1 || cursor.length > 2_048)) invalid();
  if (limit !== null && (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100)) invalid();
  return {
    ...(provider === null ? {} : { provider: parseApiKeyId(provider) }),
    ...(state === null ? {} : { status: status(state) }),
    ...(cursor === null ? {} : { cursor }),
    limit: limit === null ? 20 : Number(limit),
  };
}

function instant(value: unknown): string {
  if (typeof value !== "string" || value.length !== 24) invalid();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) invalid();
  return value;
}

export const API_KEY_DTO_FIELDS = [
  "id",
  "name",
  "provider",
  "keyFingerprintDisplay",
  "status",
  "revision",
  "lastUsedAt",
  "revokedAt",
  "createdAt",
  "updatedAt",
] as const;

/** Every retained result must cross this exact whitelist again before replay. */
export function parseApiKeyDto(value: unknown): ApiKeyDto {
  const row = object(value, API_KEY_DTO_FIELDS);
  if (
    typeof row.keyFingerprintDisplay !== "string" ||
    !/^[a-f0-9]{12}…$/.test(row.keyFingerprintDisplay)
  )
    invalid();
  const state = status(row.status);
  const revokedAt = row.revokedAt === null ? null : instant(row.revokedAt);
  if ((state === "REVOKED") !== (revokedAt !== null)) invalid();
  return {
    id: parseApiKeyId(row.id),
    name: name(row.name),
    provider: parseApiKeyId(row.provider),
    keyFingerprintDisplay: row.keyFingerprintDisplay,
    status: state,
    revision: revision(row.revision),
    lastUsedAt: row.lastUsedAt === null ? null : instant(row.lastUsedAt),
    revokedAt,
    createdAt: instant(row.createdAt),
    updatedAt: instant(row.updatedAt),
  };
}

export function parseKeyRotationReceipt(value: unknown): KeyRotationReceipt {
  const row = object(value, ["key", "stage", "affectedConfigCount", "errorCode", "replayed"]);
  if (
    typeof row.stage !== "string" ||
    !["PREPARING", "TESTING", "READY", "ACTIVATED", "ABORTED"].includes(row.stage) ||
    (row.errorCode !== null &&
      (typeof row.errorCode !== "string" ||
        ![
          "CONFIG_ERROR",
          "PROVIDER_UNAVAILABLE",
          "PROVIDER_TIMEOUT",
          "VERSION_CONFLICT",
          "INTERNAL_ERROR",
        ].includes(row.errorCode))) ||
    typeof row.replayed !== "boolean"
  )
    invalid();
  return {
    key: parseApiKeyDto(row.key),
    stage: row.stage as KeyRotationStage,
    affectedConfigCount: revision(row.affectedConfigCount),
    errorCode: row.errorCode as string | null,
    replayed: row.replayed,
  };
}
