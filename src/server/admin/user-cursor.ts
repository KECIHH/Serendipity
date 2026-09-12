import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AdminUserInputError, parseAdminUserId, type AdminUserQuery } from "@/lib/admin-users";
import { stableStringify } from "@/lib/json";

const ORDER = "createdAt:desc,id:desc";
const DOMAIN = "serendipity:admin-user-cursor:v1\0";

export interface AdminUserCursor {
  id: string;
  createdAt: Date;
  watermark: Date;
}

function filterHash(query: Pick<AdminUserQuery, "role" | "status">): string {
  return createHash("sha256")
    .update(stableStringify({ role: query.role ?? null, status: query.status ?? null }))
    .digest("hex");
}

function cursorKey(secret: string): Buffer {
  if (typeof secret !== "string" || secret.length < 32) throw new AdminUserInputError();
  return createHmac("sha256", secret).update(DOMAIN).digest();
}

function instant(value: unknown): Date {
  if (typeof value !== "string" || value.length !== 24) throw new AdminUserInputError();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
    throw new AdminUserInputError();
  return date;
}

/** Signed, domain-bound keyset state. A filter or account change requires a new first page. */
export function encodeAdminUserCursor(
  state: AdminUserCursor,
  ownerUserId: string,
  query: Pick<AdminUserQuery, "role" | "status">,
  secret: string,
): string {
  const payload = stableStringify({
    v: 1,
    owner: parseAdminUserId(ownerUserId),
    filter: filterHash(query),
    order: ORDER,
    id: parseAdminUserId(state.id),
    createdAt: state.createdAt.toISOString(),
    watermark: state.watermark.toISOString(),
  });
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  const signature = createHmac("sha256", cursorKey(secret)).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function decodeAdminUserCursor(
  value: string,
  ownerUserId: string,
  query: Pick<AdminUserQuery, "role" | "status">,
  secret: string,
): AdminUserCursor {
  try {
    if (value.length > 2_048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) {
      throw new AdminUserInputError();
    }
    const [encoded, signature] = value.split(".");
    const bytes = Buffer.from(encoded, "base64url");
    const actual = Buffer.from(signature, "base64url");
    const expected = createHmac("sha256", cursorKey(secret)).update(encoded).digest();
    if (
      bytes.toString("base64url") !== encoded ||
      actual.toString("base64url") !== signature ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new AdminUserInputError();
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new AdminUserInputError();
    const fields = payload as Record<string, unknown>;
    if (
      Object.keys(fields).length !== 7 ||
      fields.v !== 1 ||
      fields.owner !== ownerUserId ||
      fields.filter !== filterHash(query) ||
      fields.order !== ORDER
    )
      throw new AdminUserInputError();
    const createdAt = instant(fields.createdAt),
      watermark = instant(fields.watermark);
    if (createdAt > watermark) throw new AdminUserInputError();
    return { id: parseAdminUserId(fields.id), createdAt, watermark };
  } catch {
    throw new AdminUserInputError();
  }
}
