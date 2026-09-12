import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ApiKeyInputError, parseApiKeyId, type ApiKeyQuery } from "@/lib/admin-api-keys";
import { stableStringify } from "@/lib/json";

interface KeyCursor {
  id: string;
  createdAt: Date;
  watermark: Date;
}
const domain = "serendipity:api-key-cursor:v1\0";
function filter(query: ApiKeyQuery) {
  return createHash("sha256")
    .update(
      stableStringify({
        provider: query.provider ?? null,
        status: query.status ?? null,
        limit: query.limit,
      }),
    )
    .digest("hex");
}
function cursorKey(secret: string) {
  if (secret.length < 32) throw new ApiKeyInputError();
  return createHmac("sha256", secret).update(domain).digest();
}
export function encodeApiKeyCursor(
  state: KeyCursor,
  owner: string,
  query: ApiKeyQuery,
  secret: string,
): string {
  const encoded = Buffer.from(
    stableStringify({
      v: 1,
      owner,
      filter: filter(query),
      order: "createdAt:desc,id:desc",
      id: state.id,
      createdAt: state.createdAt.toISOString(),
      watermark: state.watermark.toISOString(),
    }),
  ).toString("base64url");
  return `${encoded}.${createHmac("sha256", cursorKey(secret)).update(encoded).digest("base64url")}`;
}
export function decodeApiKeyCursor(
  value: string,
  owner: string,
  query: ApiKeyQuery,
  secret: string,
): KeyCursor {
  try {
    if (value.length > 2_048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value))
      throw new ApiKeyInputError();
    const [encoded, signature] = value.split(".");
    const bytes = Buffer.from(encoded, "base64url"),
      actual = Buffer.from(signature, "base64url");
    const expected = createHmac("sha256", cursorKey(secret)).update(encoded).digest();
    if (
      bytes.toString("base64url") !== encoded ||
      actual.toString("base64url") !== signature ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new ApiKeyInputError();
    const row = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) as Record<
      string,
      unknown
    >;
    if (
      !row ||
      Object.keys(row).length !== 7 ||
      row.v !== 1 ||
      row.owner !== owner ||
      row.filter !== filter(query) ||
      row.order !== "createdAt:desc,id:desc"
    )
      throw new ApiKeyInputError();
    const instant = (input: unknown) => {
      if (typeof input !== "string" || input.length !== 24) throw new ApiKeyInputError();
      const result = new Date(input);
      if (!Number.isFinite(result.getTime()) || result.toISOString() !== input)
        throw new ApiKeyInputError();
      return result;
    };
    const createdAt = instant(row.createdAt),
      watermark = instant(row.watermark);
    if (createdAt > watermark) throw new ApiKeyInputError();
    return { id: parseApiKeyId(row.id), createdAt, watermark };
  } catch {
    throw new ApiKeyInputError();
  }
}
