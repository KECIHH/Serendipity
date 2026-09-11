import "server-only";

import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { types } from "node:util";
import type { Prisma } from "@prisma/client";

export const AUDIT_LOG_ACTIONS = Object.freeze({
  CONFIG_UPDATE: "CONFIG_UPDATE",
  USER_DISABLE: "USER_DISABLE",
  API_KEY_ROTATE: "API_KEY_ROTATE",
  SEED_ADMIN_CREATE: "SEED_ADMIN_CREATE",
  SEED_CONFIG_CREATE: "SEED_CONFIG_CREATE",
  LOGIN_SUCCESS: "LOGIN_SUCCESS",
  LOGIN_FAILURE: "LOGIN_FAILURE",
  LOGIN_THROTTLED: "LOGIN_THROTTLED",
  SESSION_LOGOUT: "SESSION_LOGOUT",
} as const);

export type AuditLogAction = keyof typeof AUDIT_LOG_ACTIONS;

export const AUDIT_ACTION_TARGETS = Object.freeze({
  CONFIG_UPDATE: "SystemConfig",
  USER_DISABLE: "User",
  API_KEY_ROTATE: "ApiKeyConfig",
  SEED_ADMIN_CREATE: "User",
  SEED_CONFIG_CREATE: "SystemConfig",
  LOGIN_SUCCESS: "User",
  LOGIN_FAILURE: "User",
  LOGIN_THROTTLED: "User",
  SESSION_LOGOUT: "AuthSession",
} as const);

export type AuditTargetType = (typeof AUDIT_ACTION_TARGETS)[AuditLogAction];

export const AUDIT_SYSTEM_ACTORS = Object.freeze([
  "MIGRATION",
  "SCHEDULER",
  "MAINTENANCE",
] as const);
export type AuditSystemActor = (typeof AUDIT_SYSTEM_ACTORS)[number];

export const AUDIT_LIMITS = Object.freeze({
  action: 64,
  targetType: 64,
  identifier: 128,
  actorEmail: 254,
  correlationId: 36,
  detailDepth: 8,
  detailBytes: 16_384,
  detailNodes: 1_024,
  detailKey: 128,
  userAgent: 256,
  userAgentInput: 4_096,
});

export class AuditLogError extends Error {
  constructor(readonly code: "VALIDATION_ERROR" | "INTERNAL_ERROR") {
    super(code === "VALIDATION_ERROR" ? "Audit input is invalid." : "Audit write failed.");
    this.name = "AuditLogError";
  }
}

function invalid(): never {
  throw new AuditLogError("VALIDATION_ERROR");
}

export function readAuditObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value))
    invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length > AUDIT_LIMITS.detailNodes) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))
      invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
    result[key] = descriptor.value as unknown;
  }
  return result;
}

export function readAuditIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > AUDIT_LIMITS.identifier ||
    /[^A-Za-z0-9_-]/.test(value)
  )
    invalid();
  return value;
}

const sensitiveKeys = new Set([
  "password",
  "passwordhash",
  "secret",
  "clientsecret",
  "authsecret",
  "secretkey",
  "apikey",
  "encryptedkey",
  "encryptionkey",
  "authorization",
  "cookie",
  "setcookie",
  "token",
  "tokenhash",
  "anontoken",
  "anontokenhash",
  "sharetoken",
  "sessiontoken",
  "accesstoken",
  "refreshtoken",
  "confirmationtoken",
  "xsharetoken",
  "prompt",
  "promptcontent",
  "systemprompt",
  "databaseurl",
  "ciphertext",
  "envelope",
  "receipt",
  "receipthash",
  "feedbackreceipt",
  "datarequestreceipt",
  "xfeedbackreceipt",
  "xdatarequestreceipt",
  "rawoutput",
  "rawresponse",
  "query",
  "description",
  "email",
  "phone",
  "coordinate",
  "coordinates",
  "address",
  "chat",
  "messages",
  "privatetext",
  "sourcelocator",
  "endpoint",
  "connectionstring",
]);

function isSensitiveKey(key: string): boolean {
  const normalized = key.normalize("NFKC");
  // Only case and known separators may vary; dynamic suffixes must not carry private text.
  if (/[^A-Za-z0-9_. -]/.test(normalized)) return false;
  return sensitiveKeys.has(normalized.replace(/[_. -]/g, "").toLowerCase());
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Budget {
  bytes: number;
  nodes: number;
}

function account(budget: Budget, bytes: number): void {
  budget.bytes += bytes;
  if (budget.bytes > AUDIT_LIMITS.detailBytes) invalid();
}

function cloneJson(value: unknown, depth: number, ancestors: Set<object>, budget: Budget): Json {
  if (depth > AUDIT_LIMITS.detailDepth || ++budget.nodes > AUDIT_LIMITS.detailNodes) invalid();
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) invalid();
    if (
      typeof value === "string" &&
      (value.length > AUDIT_LIMITS.detailBytes || value.includes("\0") || !value.isWellFormed())
    )
      invalid();
    account(budget, Buffer.byteLength(JSON.stringify(value), "utf8"));
    return value;
  }
  if (typeof value !== "object" || types.isProxy(value) || ancestors.has(value)) invalid();
  ancestors.add(value);
  account(budget, 2);
  let result: Json;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > AUDIT_LIMITS.detailNodes)
      invalid();
    if (Reflect.ownKeys(value).length !== value.length + 1) invalid();
    const items: Json[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
      if (index > 0) account(budget, 1);
      items.push(cloneJson(descriptor.value as unknown, depth + 1, ancestors, budget));
    }
    result = items;
  } else {
    const entries = Object.entries(readAuditObject(value));
    const object: { [key: string]: Json } = Object.create(null);
    for (const [index, [key, item]] of entries.entries()) {
      if (key.length > AUDIT_LIMITS.detailKey || key.includes("\0") || !key.isWellFormed())
        invalid();
      account(budget, Buffer.byteLength(JSON.stringify(key), "utf8") + 1 + (index > 0 ? 1 : 0));
      object[key] = cloneJson(item, depth + 1, ancestors, budget);
    }
    result = object;
  }
  ancestors.delete(value);
  return result;
}

function redactJson(value: Json): Json {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveKey(key) ? "***" : redactJson(item),
    ]),
  );
}

const containers = new Set(["before", "after", "changes", "metadata", "items"]);
const counters = new Set([
  "revision",
  "previousRevision",
  "nextRevision",
  "version",
  "previousVersion",
  "newVersion",
  "count",
]);
const changedFields = new Set([
  "valueJson",
  "description",
  "group",
  "isPublic",
  "revision",
  "status",
  "role",
  "sessionVersion",
  "encryptedKey",
  "keyFingerprint",
]);
const summaryEnums: Readonly<Record<string, readonly string[]>> = Object.freeze({
  result: ["SUCCESS", "FAILURE", "DENIED"],
  reasonCode: [
    "CONFIG_CHANGED",
    "USER_DISABLED",
    "KEY_ROTATED",
    "SCHEDULED",
    "MAINTENANCE",
    "LOGIN_ACCEPTED",
    "UNKNOWN_ACCOUNT",
    "PASSWORD_MISMATCH",
    "ROLE_NOT_ALLOWED",
    "ACCOUNT_DISABLED",
    "STATE_CHANGED",
    "RATE_LIMITED",
    "SESSION_REVOKED",
  ],
  status: ["ACTIVE", "DISABLED", "REVOKED"],
  group: ["AI", "UI", "EXPORT", "SECURITY", "GENERAL"],
  role: ["USER", "ADMIN"],
  audience: ["USER", "ADMIN"],
  scope: ["LOGIN", "REGISTER"],
  systemActor: AUDIT_SYSTEM_ACTORS,
});

function validateSummary(value: Json): void {
  if (Array.isArray(value)) {
    for (const item of value) validateSummary(item);
    return;
  }
  if (value === null || typeof value !== "object") invalid();
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      if (item !== "***") invalid();
    } else if (containers.has(key)) validateSummary(item);
    else if (counters.has(key)) {
      if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) invalid();
    } else if (key === "isPublic" || key === "enabled") {
      if (typeof item !== "boolean") invalid();
    } else if (key === "sourceMarker") {
      if (item !== "PHASE010_BASE_SEED_V1") invalid();
    } else if (key === "seedRunId") {
      if (typeof item !== "string" || !/^(phase[0-9]{3}|serendipity)_[a-f0-9]{12}$/.test(item))
        invalid();
    } else if (["seedFingerprint", "ipHash", "accountHash"].includes(key)) {
      if (typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item)) invalid();
    } else if (key === "changedFields") {
      if (
        !Array.isArray(item) ||
        item.some((field) => typeof field !== "string" || !changedFields.has(field))
      )
        invalid();
    } else if (Object.hasOwn(summaryEnums, key)) {
      if (typeof item !== "string" || !summaryEnums[key].includes(item)) invalid();
    } else invalid();
  }
}

/** Bounds apply to the full input, including values that will be redacted. */
export function sanitizeAuditDetail(input: unknown): Prisma.InputJsonObject | null {
  if (input === undefined || input === null) return null;
  const copy = cloneJson(input, 0, new Set(), { bytes: 0, nodes: 0 });
  if (copy === null || typeof copy !== "object" || Array.isArray(copy)) invalid();
  const result = redactJson(copy);
  validateSummary(result);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > AUDIT_LIMITS.detailBytes) invalid();
  if (result === null || typeof result !== "object" || Array.isArray(result)) invalid();
  return result;
}

/** A separate domain binds the address digest to this audit purpose. */
export function hashAuditIp(address: string, hmacKey: Uint8Array): string {
  if (
    typeof address !== "string" ||
    address.includes("%") ||
    !isIP(address) ||
    !(hmacKey instanceof Uint8Array) ||
    hmacKey.byteLength !== 32
  )
    invalid();
  const canonical =
    isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname.slice(1, -1) : address;
  return createHmac("sha256", hmacKey)
    .update("serendipity:audit:ip:v1\0")
    .update(canonical)
    .digest("hex");
}

export function normalizeAuditUserAgent(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > AUDIT_LIMITS.userAgentInput ||
    !value.isWellFormed()
  )
    invalid();
  // PostgreSQL varchar counts Unicode code points, not UTF-16 code units.
  return [...value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "")]
    .slice(0, AUDIT_LIMITS.userAgent)
    .join("");
}

const contextBrand: unique symbol = Symbol("AuditRequestContext");
const contexts = new WeakSet<object>();
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface AuditRequestContext {
  readonly [contextBrand]: true;
  readonly requestId: string;
  readonly traceId: string | null;
  readonly ipHash: string | null;
  readonly userAgentSummary: string | null;
}

export interface AuditContextOptions {
  trace?: boolean;
  ipAddress?: string;
  hmacKey?: Uint8Array;
  userAgent?: string;
}

/** Create once at a trusted server boundary, and reuse across that request's writes. */
export function createAuditContext(options: AuditContextOptions = {}): AuditRequestContext {
  const fields = readAuditObject(options);
  if (
    Object.keys(fields).some((key) => !["trace", "ipAddress", "hmacKey", "userAgent"].includes(key))
  )
    invalid();
  if (fields.trace !== undefined && typeof fields.trace !== "boolean") invalid();
  if ((fields.ipAddress === undefined) !== (fields.hmacKey === undefined)) invalid();
  let ipHash: string | null = null;
  if (fields.ipAddress !== undefined) {
    if (typeof fields.ipAddress !== "string" || !(fields.hmacKey instanceof Uint8Array)) invalid();
    ipHash = hashAuditIp(fields.ipAddress, fields.hmacKey);
  }
  if (fields.userAgent !== undefined && typeof fields.userAgent !== "string") invalid();
  const context: AuditRequestContext = Object.freeze({
    [contextBrand]: true as const,
    requestId: randomUUID(),
    traceId: fields.trace === true ? randomUUID() : null,
    ipHash,
    userAgentSummary:
      fields.userAgent === undefined ? null : normalizeAuditUserAgent(fields.userAgent),
  });
  contexts.add(context);
  return context;
}

export interface AuditStoredContext {
  requestId: string | null;
  traceId: string | null;
  ipHash: string | null;
  userAgentSummary: string | null;
}

export function readAuditContext(value: unknown): AuditStoredContext {
  if (value === undefined || value === null)
    return { requestId: null, traceId: null, ipHash: null, userAgentSummary: null };
  if (typeof value !== "object" || !contexts.has(value)) invalid();
  const context = value as AuditRequestContext;
  if (
    !uuidV4.test(context.requestId) ||
    (context.traceId !== null && !uuidV4.test(context.traceId))
  )
    invalid();
  if (context.ipHash !== null && !/^[0-9a-f]{64}$/.test(context.ipHash)) invalid();
  if (
    context.userAgentSummary !== null &&
    normalizeAuditUserAgent(context.userAgentSummary) !== context.userAgentSummary
  )
    invalid();
  return context;
}
