import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { decode, encode, type JWTEncodeParams } from "next-auth/jwt";

import { env } from "@/lib/env";

export const AUTH_SESSION_MAX_AGE = 12 * 60 * 60;
const MAX_COOKIE_HEADER_BYTES = 16_384;

export interface AuthCookieClaims {
  opaqueToken: string;
  absoluteExpiresAt: number;
}

/** Cookie policy is derived from the configured origin, never a request Host header. */
export function authCookieSettings(origin: string = env.AUTH_URL) {
  const url = new URL(origin);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Authentication origin is invalid.");
  }
  const secure = url.protocol === "https:";
  const prefix = secure ? "__Secure-" : "";
  const options = { httpOnly: true, sameSite: "lax" as const, path: "/", secure };
  return {
    sessionToken: { name: `${prefix}authjs.session-token`, options },
    csrfToken: { name: `${secure ? "__Host-" : ""}authjs.csrf-token`, options },
    callbackUrl: { name: `${prefix}authjs.callback-url`, options },
  };
}

export function readSessionClaims(value: unknown, now = Date.now()): AuthCookieClaims | null {
  if (value === null || typeof value !== "object") return null;
  const fields = value as Record<string, unknown>;
  if (
    typeof fields.opaqueToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(fields.opaqueToken) ||
    Buffer.from(fields.opaqueToken, "base64url").toString("base64url") !== fields.opaqueToken ||
    typeof fields.absoluteExpiresAt !== "number" ||
    !Number.isSafeInteger(fields.absoluteExpiresAt) ||
    fields.absoluteExpiresAt <= now
  ) {
    return null;
  }
  return { opaqueToken: fields.opaqueToken, absoluteExpiresAt: fields.absoluteExpiresAt };
}

/** Auth.js encrypts only these claims; refreshing a JWE cannot extend its absolute expiry. */
export async function encodeAuthCookie(parameters: JWTEncodeParams): Promise<string> {
  const claims = readSessionClaims(parameters.token);
  if (!claims) throw new Error("Authentication session is invalid.");
  const maxAge = Math.min(
    AUTH_SESSION_MAX_AGE,
    Math.floor(claims.absoluteExpiresAt / 1_000) - Math.floor(Date.now() / 1_000),
  );
  if (maxAge <= 0) throw new Error("Authentication session is invalid.");
  return encode({ ...parameters, token: { ...claims }, maxAge });
}

function requestCookies(request: Request): Map<string, string> | null {
  const header = request.headers.get("cookie") ?? "";
  if (Buffer.byteLength(header, "utf8") > MAX_COOKIE_HEADER_BYTES) return null;
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

function isSessionCookie(name: string, baseName: string): boolean {
  return (
    name === baseName || new RegExp(`^${baseName.replaceAll(".", "\\.")}\\.[0-9]+$`).test(name)
  );
}

/** Auth.js uses prefix matching internally; only exact registered names reach its parser. */
export function authFrameworkCookieHeader(request: Request): string {
  const values = requestCookies(request);
  if (!values) return "";
  const settings = authCookieSettings();
  return [...values.entries()]
    .filter(
      ([name]) =>
        isSessionCookie(name, settings.sessionToken.name) ||
        name === settings.csrfToken.name ||
        name === settings.callbackUrl.name,
    )
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
}

export function hasAuthCookieInput(request: Request): boolean {
  const baseName = authCookieSettings().sessionToken.name;
  return (request.headers.get("cookie") ?? "")
    .split(";")
    .some(
      (item) => item.trim().startsWith(`${baseName}=`) || item.trim().startsWith(`${baseName}.`),
    );
}

/** Cookie-only decoding deliberately does not accept an Authorization bearer token. */
export async function readAuthCookie(request: Request): Promise<AuthCookieClaims | null> {
  const cookies = requestCookies(request);
  if (!cookies) return null;
  const { name } = authCookieSettings().sessionToken;
  const chunks = [...cookies.entries()].filter(([key]) => isSessionCookie(key, name));
  if (!chunks.length) return null;
  let encrypted: string;
  if (cookies.has(name)) {
    if (chunks.length !== 1) return null;
    encrypted = cookies.get(name)!;
  } else {
    chunks.sort(
      ([left], [right]) =>
        Number(left.slice(name.length + 1)) - Number(right.slice(name.length + 1)),
    );
    if (chunks.some(([key], index) => key !== `${name}.${index}`)) return null;
    encrypted = chunks.map(([, value]) => value).join("");
  }
  try {
    return readSessionClaims(
      await decode({ token: encrypted, secret: env.AUTH_SECRET, salt: name }),
    );
  } catch {
    return null;
  }
}

export class CookieRequestError extends Error {
  readonly status = 403;
  readonly code = "FORBIDDEN";

  constructor() {
    super("请求验证失败");
    this.name = "CookieRequestError";
  }
}

export function assertSameOrigin(request: Request): void {
  if (
    request.headers.get("origin") !== new URL(env.AUTH_URL).origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    throw new CookieRequestError();
  }
}

/** Use the Auth.js double-submit token for every Cookie-authorized mutation. */
export function assertCookieMutation(request: Request, token: unknown): void {
  assertSameOrigin(request);
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw new CookieRequestError();
  const cookie = requestCookies(request)?.get(authCookieSettings().csrfToken.name);
  if (!cookie || !/^[a-f0-9]{64}\|[a-f0-9]{64}$/.test(cookie)) throw new CookieRequestError();
  const [cookieToken, cookieHash] = cookie.split("|");
  const expectedHash = createHash("sha256").update(`${cookieToken}${env.AUTH_SECRET}`).digest();
  if (
    !timingSafeEqual(Buffer.from(cookieHash, "hex"), expectedHash) ||
    !timingSafeEqual(Buffer.from(cookieToken, "hex"), Buffer.from(token, "hex"))
  ) {
    throw new CookieRequestError();
  }
}

function clearedCookie(name: string): string {
  const secure = authCookieSettings().sessionToken.options.secure;
  return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function copyResponse(response: Response, cookies: readonly string[]): Response {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Auth.js also refreshes Cookie expires; clamp it to the same immutable database deadline. */
export function clampSessionCookies(response: Response, expiresAt?: Date): Response {
  const { name: baseName, options } = authCookieSettings().sessionToken;
  const now = Date.now();
  const cookies = response.headers.getSetCookie().map((cookie) => {
    const [pair, ...attributes] = cookie.split(";").map((part) => part.trim());
    const name = pair.slice(0, pair.indexOf("="));
    if (!isSessionCookie(name, baseName)) return cookie;
    if (
      !pair.slice(pair.indexOf("=") + 1) ||
      attributes.some((item) => /^max-age=0$/i.test(item))
    ) {
      return clearedCookie(name);
    }
    if (!expiresAt || expiresAt.getTime() <= now) return clearedCookie(name);
    const maxAge = Math.min(AUTH_SESSION_MAX_AGE, Math.floor((expiresAt.getTime() - now) / 1_000));
    if (maxAge <= 0) return clearedCookie(name);
    return `${pair}; Path=/; Max-Age=${maxAge}; Expires=${expiresAt.toUTCString()}; HttpOnly; SameSite=Lax${options.secure ? "; Secure" : ""}`;
  });
  return copyResponse(response, cookies);
}

export function clearSessionCookies(response: Response, request: Request): Response {
  const baseName = authCookieSettings().sessionToken.name;
  const names = new Set([baseName]);
  for (const name of requestCookies(request)?.keys() ?? []) {
    if (isSessionCookie(name, baseName)) names.add(name);
  }
  const remaining = response.headers.getSetCookie().filter((cookie) => {
    const name = cookie.slice(0, cookie.indexOf("="));
    if (!isSessionCookie(name, baseName)) return true;
    names.add(name);
    return false;
  });
  const cleared = copyResponse(response, [...remaining, ...[...names].map(clearedCookie)]);
  cleared.headers.set("x-auth-session-cleared", "1");
  return cleared;
}
