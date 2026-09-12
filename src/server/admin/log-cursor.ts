import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  AdminLogInputError,
  auditIdentifier,
  auditInstant,
  type AuditQuery,
} from "@/lib/admin-logs";
import { stableStringify } from "@/lib/json";

const DOMAIN = "serendipity:admin-audit-cursor:v1\0";
const ORDER = "createdAt:desc,id:desc";
export interface AuditCursor {
  id: string;
  createdAt: Date;
  watermark: Date;
}

function filterHash(query: AuditQuery): string {
  return createHash("sha256")
    .update(
      stableStringify({
        action: query.action ?? null,
        actorId: query.actorId ?? null,
        targetType: query.targetType ?? null,
        targetId: query.targetId ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
        limit: query.limit,
      }),
    )
    .digest("hex");
}
function key(secret: string): Buffer {
  if (typeof secret !== "string" || secret.length < 32) throw new AdminLogInputError();
  return createHmac("sha256", secret).update(DOMAIN).digest();
}
export function encodeAuditCursor(
  state: AuditCursor,
  owner: string,
  query: AuditQuery,
  secret: string,
): string {
  const payload = stableStringify({
    v: 1,
    owner: auditIdentifier(owner),
    filter: filterHash(query),
    order: ORDER,
    id: auditIdentifier(state.id),
    createdAt: state.createdAt.toISOString(),
    watermark: state.watermark.toISOString(),
  });
  const encoded = Buffer.from(payload).toString("base64url");
  return `${encoded}.${createHmac("sha256", key(secret)).update(encoded).digest("base64url")}`;
}
export function decodeAuditCursor(
  value: string,
  owner: string,
  query: AuditQuery,
  secret: string,
): AuditCursor {
  try {
    if (value.length > 2_048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value))
      throw new AdminLogInputError();
    const [encoded, signature] = value.split(".");
    const bytes = Buffer.from(encoded, "base64url"),
      actual = Buffer.from(signature, "base64url");
    const expected = createHmac("sha256", key(secret)).update(encoded).digest();
    if (
      bytes.toString("base64url") !== encoded ||
      actual.toString("base64url") !== signature ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new AdminLogInputError();
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new AdminLogInputError();
    const payload = parsed as Record<string, unknown>;
    if (
      Object.keys(payload).length !== 7 ||
      payload.v !== 1 ||
      payload.owner !== owner ||
      payload.order !== ORDER ||
      payload.filter !== filterHash(query)
    )
      throw new AdminLogInputError();
    const createdAt = new Date(auditInstant(payload.createdAt)),
      watermark = new Date(auditInstant(payload.watermark));
    if (createdAt > watermark) throw new AdminLogInputError();
    return { id: auditIdentifier(payload.id), createdAt, watermark };
  } catch {
    throw new AdminLogInputError();
  }
}
