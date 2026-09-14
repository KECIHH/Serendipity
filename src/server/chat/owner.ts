import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "@/lib/env";
import { parseEnv, envRegistry } from "@/lib/env-schema";
import { hashAnonymousToken, type AnonTokenHash } from "@/server/anonymous-owner";
import { ChatCommandError } from "@/server/chat/error-codes";

export const ANONYMOUS_COOKIE_NAME = "anon_token";
export const ANONYMOUS_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // fixed 30 days
const TOKEN_BYTES = 32;
const ANON_ENVELOPE_VERSION = 1;

interface AnonCookieClaims {
  opaqueToken: string;
  issuedAt: number;
  absoluteExpiresAt: number;
}

function masterKey(): Buffer {
  const parsed = parseEnv({ ENCRYPTION_KEY: env.ENCRYPTION_KEY }, "server", {
    registry: envRegistry.filter((entry) => entry.key === "ENCRYPTION_KEY"),
  });
  const master = Buffer.from(String(parsed.ENCRYPTION_KEY), "base64");
  if (master.length !== 32) throw new ChatCommandError("CONFIG_ERROR", 500);
  return master;
}

function envelopeAad(version: number, keyId: string, issuedAt: number, expiresAt: number): Buffer {
  return Buffer.from(`serendipity.anon.${version}.${keyId}.${issuedAt}.${expiresAt}`);
}

function encodeEnvelope(claims: AnonCookieClaims, key: Buffer): string {
  const iv = randomBytes(12);
  const keyId = createHash("sha256").update(key).digest("hex");
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(envelopeAad(ANON_ENVELOPE_VERSION, keyId, claims.issuedAt, claims.absoluteExpiresAt));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(claims.opaqueToken, "utf8")),
    cipher.final(),
  ]);
  return Buffer.from(
    JSON.stringify({
      v: ANON_ENVELOPE_VERSION,
      c: ciphertext.toString("base64"),
      i: iv.toString("base64"),
      k: keyId,
      t: cipher.getAuthTag().toString("base64"),
      ia: claims.issuedAt,
      ea: claims.absoluteExpiresAt,
    }),
  ).toString("base64url");
}

function decodeEnvelope(value: string, key: Buffer, now: number): AnonCookieClaims | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    envelope.v !== ANON_ENVELOPE_VERSION ||
    typeof envelope.c !== "string" ||
    typeof envelope.i !== "string" ||
    typeof envelope.k !== "string" ||
    typeof envelope.t !== "string" ||
    typeof envelope.ia !== "number" ||
    typeof envelope.ea !== "number" ||
    !Number.isSafeInteger(envelope.ia) ||
    !Number.isSafeInteger(envelope.ea)
  ) {
    return null;
  }
  const keyId = createHash("sha256").update(key).digest("hex");
  if (envelope.k !== keyId) return null;
  const issuedAt = envelope.ia;
  const absoluteExpiresAt = envelope.ea;
  if (absoluteExpiresAt <= now || issuedAt > now) return null;
  let token: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.i, "base64"), {
      authTagLength: 16,
    });
    decipher.setAAD(envelopeAad(ANON_ENVELOPE_VERSION, keyId, issuedAt, absoluteExpiresAt));
    decipher.setAuthTag(Buffer.from(envelope.t, "base64"));
    const bytes = Buffer.concat([
      decipher.update(Buffer.from(envelope.c, "base64")),
      decipher.final(),
    ]);
    token = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  if (
    typeof token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    Buffer.from(token, "base64url").length !== TOKEN_BYTES ||
    Buffer.from(token, "base64url").toString("base64url") !== token
  ) {
    return null;
  }
  return { opaqueToken: token, issuedAt, absoluteExpiresAt };
}

function requestCookies(request: Request): Map<string, string> | null {
  const header = request.headers.get("cookie") ?? "";
  if (Buffer.byteLength(header, "utf8") > 16_384) return null;
  const values = new Map<string, string>();
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    if (values.has(name)) return null;
    try {
      values.set(name, decodeURIComponent(item.slice(separator + 1).trim()));
    } catch {
      return null;
    }
  }
  return values;
}

function secureFlag(): boolean {
  const url = new URL(env.AUTH_URL);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return url.protocol === "https:" || !loopback;
}

/**
 * Issue or reuse an anonymous session. This helper has no business side effects and is
 * intended for the Phase023 bootstrap endpoint. Returns the Set-Cookie header and the
 * opaque token (used only at the cookie boundary).
 */
export function issueOrReuseAnonymousSession(now = Date.now()): {
  cookieHeader: string;
  token: string;
} {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const issuedAt = now;
  const absoluteExpiresAt = now + ANONYMOUS_COOKIE_MAX_AGE_SECONDS * 1000;
  const claims: AnonCookieClaims = { opaqueToken: token, issuedAt, absoluteExpiresAt };
  const value = encodeEnvelope(claims, masterKey());
  const secure = secureFlag();
  const cookie = `${ANONYMOUS_COOKIE_NAME}=${value}; Path=/; Max-Age=${ANONYMOUS_COOKIE_MAX_AGE_SECONDS}; Expires=${new Date(absoluteExpiresAt).toUTCString()}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  return { cookieHeader: cookie, token };
}

/**
 * Read and verify an existing anonymous Cookie. Never issues a new identity in a business
 * write path. Returns the opaque token on success or null when absent/invalid/expired.
 */
export function readAnonymousCookie(request: Request, now = Date.now()): string | null {
  const cookies = requestCookies(request);
  if (!cookies) return null;
  const value = cookies.get(ANONYMOUS_COOKIE_NAME);
  if (!value) return null;
  const claims = decodeEnvelope(value, masterKey(), now);
  return claims?.opaqueToken ?? null;
}

/**
 * Resolve an existing owner. A valid signed-in user wins; otherwise only an existing
 * verified anonymous Cookie is accepted happily. Never generates a Cookie here.
 */
export function resolveExistingOwner(
  request: Request,
  options: { userId?: string | null } = {},
  now = Date.now(),
): { userId: string; anonTokenHash?: never } | { anonTokenHash: AnonTokenHash; userId?: never } | null {
  if (options.userId) return { userId: options.userId };
  const token = readAnonymousCookie(request, now);
  if (!token) return null;
  return { anonTokenHash: hashAnonymousToken(token) };
}

export function hashAnonToken(raw: string): AnonTokenHash {
  return hashAnonymousToken(raw);
}