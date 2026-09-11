// @vitest-environment node
import { randomBytes } from "node:crypto";
import { decode } from "next-auth/jwt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  env: {
    AUTH_URL: "http://localhost:3000",
    AUTH_SECRET: "unit-auth-secret-that-has-more-than-thirty-two-characters",
  },
  authenticate: vi.fn(),
  validateSession: vi.fn(),
  revokeSession: vi.fn(),
  clientAddress: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: boundary.env }));
vi.mock("@/server/auth/credentials-service", () => ({
  authenticateCredentials: boundary.authenticate,
}));
vi.mock("@/server/auth/session-service", () => ({
  validateSession: boundary.validateSession,
  revokeSession: boundary.revokeSession,
}));
vi.mock("@/server/auth/trusted-client", () => ({ trustedClientAddress: boundary.clientAddress }));

import { handleAuthRequest } from "@/server/auth/auth-handler";
import { AuthAuthorizationError, AuthUnavailableError } from "@/server/auth/errors";
import { authCookieSettings, readAuthCookie } from "@/server/auth/cookie";

let opaqueToken: string;
let expiresAt: Date;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-11T12:00:00.000Z"));
  boundary.env.AUTH_URL = "http://localhost:3000";
  vi.stubEnv("AUTH_URL", boundary.env.AUTH_URL);
  opaqueToken = randomBytes(32).toString("base64url");
  expiresAt = new Date(Date.now() + 43_200_000);
  boundary.authenticate.mockResolvedValue({ kind: "INVALID_CREDENTIALS" });
  boundary.validateSession.mockResolvedValue({
    id: "auth_fixture_admin",
    email: "auth-fixture@example.invalid",
    role: "ADMIN",
    audience: "ADMIN",
    expiresAt,
  });
  boundary.revokeSession.mockResolvedValue(undefined);
  boundary.clientAddress.mockReturnValue("127.0.0.1");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

function mergeCookies(...headers: string[]): string {
  const values = new Map<string, string>();
  for (const header of headers) {
    for (const pair of header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)) {
      values.set(pair.slice(0, pair.indexOf("=")), pair);
    }
  }
  return [...values.values()].join("; ");
}

async function csrf() {
  const response = await handleAuthRequest(new Request(`${boundary.env.AUTH_URL}/api/auth/csrf`));
  expect(response.status).toBe(200);
  const data = (await response.json()) as { csrfToken: string };
  expect(data.csrfToken).toMatch(/^[a-f0-9]{64}$/);
  return { csrfToken: data.csrfToken, cookie: cookieHeader(response) };
}

function post(
  pathname: string,
  cookie: string,
  values: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return new Request(`${boundary.env.AUTH_URL}${pathname}`, {
    method: "POST",
    headers: {
      origin: boundary.env.AUTH_URL,
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
      "X-Auth-Return-Redirect": "1",
      cookie,
      ...headers,
    },
    body: new URLSearchParams(values),
  });
}

async function login(audience: "ADMIN" | "USER" = "ADMIN") {
  const proof = await csrf();
  boundary.authenticate.mockResolvedValue({
    kind: "SUCCESS",
    session: { opaqueToken, userId: "auth_fixture_admin", audience, expiresAt },
  });
  const response = await handleAuthRequest(
    post("/api/auth/callback/credentials", proof.cookie, {
      csrfToken: proof.csrfToken,
      email: "auth-fixture@example.invalid",
      password: randomBytes(24).toString("base64url"),
      audience,
    }),
  );
  expect(response.status).toBe(200);
  return { response, proof, cookie: mergeCookies(proof.cookie, cookieHeader(response)) };
}

describe("Auth.js HTTP authentication boundary", () => {
  it("keeps the real CSRF and single Credentials provider handlers available", async () => {
    await csrf();
    const response = await handleAuthRequest(
      new Request(`${boundary.env.AUTH_URL}/api/auth/providers`),
    );
    expect(response.status).toBe(200);
    expect(Object.keys(await response.json())).toEqual(["credentials"]);
    expect(boundary.authenticate).not.toHaveBeenCalled();
  });

  it("gives all four credential failure categories byte-identical status, body and headers", async () => {
    const proof = await csrf();
    const observed: unknown[] = [];
    for (const category of ["unknown", "wrong", "user", "disabled"]) {
      const response = await handleAuthRequest(
        post("/api/auth/callback/credentials", proof.cookie, {
          csrfToken: proof.csrfToken,
          email: `${category}@example.invalid`,
          password: randomBytes(24).toString("base64url"),
          audience: "ADMIN",
          role: "ADMIN",
          userId: "client_supplied_id",
          sessionVersion: "999",
        }),
      );
      observed.push({
        status: response.status,
        body: await response.text(),
        headers: [...response.headers.entries()],
      });
    }
    expect(observed).toHaveLength(4);
    for (const result of observed) expect(result).toEqual(observed[0]);
    expect(observed[0]).toMatchObject({
      status: 401,
      body: JSON.stringify({ error: { code: "AUTH_REQUIRED", message: "邮箱或密码错误" } }),
    });
    expect(boundary.authenticate).toHaveBeenCalledTimes(4);
    for (const [input] of boundary.authenticate.mock.calls) {
      expect(Object.keys(input).sort()).toEqual(["audience", "clientAddress", "email", "password"]);
      expect(input.clientAddress).toBe("127.0.0.1");
    }
  });

  it("returns real 429 and safe Retry-After instead of Auth.js's error redirect", async () => {
    const proof = await csrf();
    boundary.authenticate.mockResolvedValue({ kind: "RATE_LIMITED", retryAfter: 601 });
    const response = await handleAuthRequest(
      post("/api/auth/callback/credentials", proof.cookie, {
        csrfToken: proof.csrfToken,
        email: "rate@example.invalid",
        password: randomBytes(16).toString("base64url"),
        audience: "ADMIN",
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("601");
    expect(response.headers.has("location")).toBe(false);
    expect(await response.json()).toEqual({
      error: { code: "RATE_LIMITED", message: "登录尝试过于频繁，请稍后重试" },
    });
  });

  it("blocks missing/invalid CSRF, cross-site metadata and a foreign Origin before credentials", async () => {
    const proof = await csrf();
    const values = {
      csrfToken: proof.csrfToken,
      email: "csrf@example.invalid",
      password: "x".repeat(12),
      audience: "ADMIN",
    };
    for (const request of [
      post("/api/auth/callback/credentials", proof.cookie, {
        ...values,
        csrfToken: "0".repeat(64),
      }),
      post("/api/auth/callback/credentials", "", values),
      post("/api/auth/callback/credentials", proof.cookie, values, {
        origin: "https://foreign.invalid",
      }),
      post("/api/auth/callback/credentials", proof.cookie, values, {
        "sec-fetch-site": "cross-site",
      }),
    ]) {
      const response = await handleAuthRequest(request);
      expect(response.status).toBe(403);
    }
    expect(boundary.authenticate).not.toHaveBeenCalled();
  });

  it("bounds raw bodies and rejects an invalid audience without creating a login attempt", async () => {
    const proof = await csrf();
    for (const values of [
      {
        csrfToken: proof.csrfToken,
        audience: "ROOT",
        email: "input@example.invalid",
        password: "x".repeat(12),
      },
      {
        csrfToken: proof.csrfToken,
        audience: "ADMIN",
        email: "x".repeat(9_000),
        password: "x".repeat(12),
      },
    ]) {
      expect(
        (await handleAuthRequest(post("/api/auth/callback/credentials", proof.cookie, values)))
          .status,
      ).toBe(400);
    }
    expect(boundary.authenticate).not.toHaveBeenCalled();
  });

  it("fails closed when the request has no trusted client-address attestation", async () => {
    const proof = await csrf();
    boundary.clientAddress.mockImplementation(() => {
      throw new Error("Untrusted request.");
    });
    const response = await handleAuthRequest(
      post(
        "/api/auth/callback/credentials",
        proof.cookie,
        {
          csrfToken: proof.csrfToken,
          audience: "ADMIN",
          email: "input@example.invalid",
          password: "x".repeat(12),
        },
        { "x-forwarded-for": "198.51.100.90" },
      ),
    );
    expect(response.status).toBe(503);
    expect(boundary.authenticate).not.toHaveBeenCalled();
  });

  it("delivers only an encrypted opaque token with a fixed 12-hour Cookie", async () => {
    const { response } = await login();
    expect(await response.json()).toEqual({ url: `${boundary.env.AUTH_URL}/admin` });
    const settings = authCookieSettings();
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${settings.sessionToken.name}=`));
    expect(cookie).toBeDefined();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=43200");
    expect(cookie).not.toContain(opaqueToken);
    const value = cookie!.split(";", 1)[0].slice(settings.sessionToken.name.length + 1);
    const payload = await decode({
      token: value,
      secret: boundary.env.AUTH_SECRET,
      salt: settings.sessionToken.name,
    });
    expect(Object.keys(payload!).sort()).toEqual([
      "absoluteExpiresAt",
      "exp",
      "iat",
      "jti",
      "opaqueToken",
    ]);
    expect(payload!.opaqueToken).toBe(opaqueToken);
    expect(payload!.absoluteExpiresAt).toBe(expiresAt.getTime());
    expect(boundary.validateSession).toHaveBeenCalledWith(opaqueToken, "USER");
  });

  it("does not slide the JWT, public session expiry or Cookie expiry on refresh", async () => {
    const { cookie } = await login();
    vi.setSystemTime(new Date(Date.now() + 7 * 3_600_000));
    const response = await handleAuthRequest(
      new Request(`${boundary.env.AUTH_URL}/api/auth/session`, { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: { email: "auth-fixture@example.invalid" },
      expires: expiresAt.toISOString(),
    });
    const refreshed = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("authjs.session-token="))!;
    expect(refreshed).toContain("Max-Age=18000");
    expect(refreshed).toContain(`Expires=${expiresAt.toUTCString()}`);
    const claims = await readAuthCookie(
      new Request(boundary.env.AUTH_URL, { headers: { cookie: cookieHeader(response) } }),
    );
    expect(claims).toEqual({ opaqueToken, absoluteExpiresAt: expiresAt.getTime() });
    expect(boundary.validateSession).toHaveBeenCalledTimes(2);
  });

  it("returns 503 and clears the local cookie when session validation is unavailable", async () => {
    const { cookie } = await login();
    boundary.validateSession.mockRejectedValue(new AuthUnavailableError());
    const response = await handleAuthRequest(
      new Request(`${boundary.env.AUTH_URL}/api/auth/session`, { headers: { cookie } }),
    );
    expect(response.status).toBe(503);
    expect(
      response.headers
        .getSetCookie()
        .some((value) => value.startsWith("authjs.session-token=;") && value.includes("Max-Age=0")),
    ).toBe(true);
    expect(await response.text()).not.toContain(opaqueToken);
  });

  it("does not claim logout succeeded when database revocation fails", async () => {
    const { cookie, proof } = await login();
    boundary.revokeSession.mockRejectedValue(new AuthUnavailableError());
    const response = await handleAuthRequest(
      post("/api/auth/signout", cookie, {
        csrfToken: proof.csrfToken,
        callbackUrl: "/admin/login",
      }),
    );
    expect(boundary.revokeSession).toHaveBeenCalledExactlyOnceWith(opaqueToken);
    expect(response.status).toBe(503);
    expect(response.headers.get("x-auth-session-cleared")).toBe("1");
    expect(response.headers.getSetCookie()).toContainEqual(
      expect.stringContaining("authjs.session-token=; Path=/; Max-Age=0"),
    );
    expect(response.headers.has("location")).toBe(false);
  });

  it.each(["", "; authjs.session-token-foreign=untrusted-suffix"])(
    "revokes the database session and rejects its old cookie despite unrelated prefix cookies %s",
    async (suffix) => {
      const { cookie, proof } = await login();
      const response = await handleAuthRequest(
        post("/api/auth/signout", cookie + suffix, { csrfToken: proof.csrfToken }),
      );
      expect(boundary.revokeSession).toHaveBeenCalledExactlyOnceWith(opaqueToken);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-auth-session-cleared")).toBe("1");
      expect(await response.json()).toEqual({ url: `${boundary.env.AUTH_URL}/admin/login` });
      expect(response.headers.getSetCookie()).toContainEqual(expect.stringContaining("Max-Age=0"));

      boundary.validateSession.mockRejectedValue(new AuthAuthorizationError());
      const replay = await handleAuthRequest(
        new Request(`${boundary.env.AUTH_URL}/api/auth/session`, { headers: { cookie } }),
      );
      expect(boundary.validateSession).toHaveBeenLastCalledWith(opaqueToken, "USER");
      expect(replay.status).toBe(200);
      expect(await replay.json()).toBeNull();
      expect(replay.headers.getSetCookie()).toContainEqual(expect.stringContaining("Max-Age=0"));
    },
  );

  it("does not report successful server logout for an ambiguous base and chunk cookie", async () => {
    const { cookie, proof } = await login();
    const response = await handleAuthRequest(
      post("/api/auth/signout", `${cookie}; authjs.session-token.0=untrusted-chunk`, {
        csrfToken: proof.csrfToken,
      }),
    );
    expect(response.status).toBe(401);
    expect(boundary.revokeSession).not.toHaveBeenCalled();
    expect(response.headers.get("x-auth-session-cleared")).toBe("1");
    expect(response.headers.getSetCookie()).toContainEqual(
      expect.stringContaining("authjs.session-token.0=; Path=/; Max-Age=0"),
    );
    expect(response.headers.getSetCookie()).toContainEqual(
      expect.stringContaining("authjs.session-token=; Path=/; Max-Age=0"),
    );
  });

  it("rejects cross-site logout before revocation or clearing the local session", async () => {
    const { cookie, proof } = await login();
    const response = await handleAuthRequest(
      post(
        "/api/auth/signout",
        cookie,
        { csrfToken: proof.csrfToken },
        { origin: "https://foreign.invalid" },
      ),
    );
    expect(response.status).toBe(403);
    expect(boundary.revokeSession).not.toHaveBeenCalled();
    expect(response.headers.get("x-auth-session-cleared")).toBeNull();
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  it("shares the provider with the USER audience and never follows client redirect destinations", async () => {
    const { response } = await login("USER");
    expect(await response.json()).toEqual({ url: `${boundary.env.AUTH_URL}/` });
    expect(boundary.authenticate.mock.calls[0][0].audience).toBe("USER");
    expect(authCookieSettings("https://app.example.invalid").sessionToken).toMatchObject({
      name: "__Secure-authjs.session-token",
      options: { secure: true, httpOnly: true, sameSite: "lax", path: "/" },
    });
    expect(authCookieSettings("https://app.example.invalid").csrfToken.name).toBe(
      "__Host-authjs.csrf-token",
    );
    expect(() => authCookieSettings("http://app.example.invalid")).toThrow();
  });

  it("accepts neither a fabricated cookie, a bearer token nor an expired opaque envelope", async () => {
    expect(
      await readAuthCookie(
        new Request(boundary.env.AUTH_URL, {
          headers: { cookie: "authjs.session-token=role.ADMIN" },
        }),
      ),
    ).toBeNull();
    const { cookie } = await login();
    const encrypted = cookie.split("authjs.session-token=")[1].split(";", 1)[0];
    expect(
      await readAuthCookie(
        new Request(boundary.env.AUTH_URL, { headers: { authorization: `Bearer ${encrypted}` } }),
      ),
    ).toBeNull();
    vi.setSystemTime(expiresAt);
    expect(
      await readAuthCookie(new Request(boundary.env.AUTH_URL, { headers: { cookie } })),
    ).toBeNull();
  });
});
