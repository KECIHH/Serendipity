// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import { RequestCookies, ResponseCookies } from "next/dist/server/web/spec-extension/cookies";
import { isValidElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  env: {
    AUTH_URL: "http://localhost:3000",
    AUTH_SECRET: "unit-guard-secret-that-has-more-than-thirty-two-characters",
  },
  validateSession: vi.fn(),
  cookies: vi.fn(),
  headers: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: boundary.env }));
vi.mock("@/server/auth/session-service", () => ({ validateSession: boundary.validateSession }));
vi.mock("next/headers", () => ({ cookies: boundary.cookies, headers: boundary.headers }));
vi.mock("next/navigation", () => ({ redirect: boundary.redirect }));
vi.mock("@/components/auth/logout-button", () => ({ LogoutButton: () => null }));

import AdminPage from "@/app/admin/page";
import { encodeAuthCookie } from "@/server/auth/cookie";
import { AuthAuthorizationError, AuthUnavailableError } from "@/server/auth/errors";
import { withAdminAction, withAdminRoute } from "@/server/auth/guards";
import { requireAdmin } from "@/server/auth/require-admin";

let opaqueToken: string;
let cookie: string;
let csrfToken: string;
let principal: {
  id: string;
  email: string;
  role: "ADMIN";
  audience: "ADMIN";
  expiresAt: Date;
};

beforeEach(async () => {
  vi.clearAllMocks();
  opaqueToken = randomBytes(32).toString("base64url");
  csrfToken = randomBytes(32).toString("hex");
  principal = {
    id: "trusted_admin",
    email: "guard@example.invalid",
    role: "ADMIN",
    audience: "ADMIN",
    expiresAt: new Date(Date.now() + 43_200_000),
  };
  const jwt = await encodeAuthCookie({
    token: { opaqueToken, absoluteExpiresAt: principal.expiresAt.getTime() },
    secret: boundary.env.AUTH_SECRET,
    salt: "authjs.session-token",
  });
  const csrfHash = createHash("sha256")
    .update(`${csrfToken}${boundary.env.AUTH_SECRET}`)
    .digest("hex");
  cookie = `authjs.session-token=${jwt}; authjs.csrf-token=${csrfToken}%7C${csrfHash}`;
  boundary.validateSession.mockResolvedValue(principal);
  boundary.cookies.mockResolvedValue({ toString: () => cookie });
  boundary.headers.mockResolvedValue(
    new Headers({ cookie, origin: boundary.env.AUTH_URL, "sec-fetch-site": "same-origin" }),
  );
  boundary.redirect.mockImplementation((pathname: string) => {
    throw new Error(`redirect:${pathname}`);
  });
});

afterEach(() => vi.clearAllMocks());

describe("requireAdmin server authorization", () => {
  it("queries the database on every invocation, with only the cookie token and ADMIN audience", async () => {
    const request = new Request(`${boundary.env.AUTH_URL}/admin`, { headers: { cookie } });
    expect(await requireAdmin(request)).toEqual(principal);
    expect(await requireAdmin(request)).toEqual(principal);
    expect(boundary.validateSession).toHaveBeenCalledTimes(2);
    expect(boundary.validateSession).toHaveBeenNthCalledWith(1, opaqueToken, "ADMIN");
    expect(boundary.validateSession).toHaveBeenNthCalledWith(2, opaqueToken, "ADMIN");
  });

  it("rejects missing, fabricated and preview cookies before any database or resource query", async () => {
    for (const value of [
      "",
      "authjs.session-token=role.ADMIN",
      "admin=true; preview=true; sessionVersion=1",
    ]) {
      await expect(
        requireAdmin(
          new Request(`${boundary.env.AUTH_URL}/admin?preview=true`, {
            headers: { cookie: value },
          }),
        ),
      ).rejects.toMatchObject({ status: 401, code: "AUTH_REQUIRED" });
    }
    expect(boundary.validateSession).not.toHaveBeenCalled();
  });

  it("propagates typed revocation, role and database failures instead of trusting an old JWE", async () => {
    const request = new Request(`${boundary.env.AUTH_URL}/admin`, { headers: { cookie } });
    for (const error of [
      new AuthAuthorizationError(),
      new AuthAuthorizationError(403, "FORBIDDEN"),
      new AuthUnavailableError(),
    ]) {
      boundary.validateSession.mockRejectedValueOnce(error);
      await expect(requireAdmin(request)).rejects.toBe(error);
    }
  });
});

describe("management page, Route Handler and Server Action guard ordering", () => {
  it("runs the real protected page guard and redirects unauthenticated requests to public login", async () => {
    boundary.headers.mockResolvedValueOnce(new Headers());
    await expect(AdminPage()).rejects.toThrow("redirect:/admin/login");
    expect(boundary.redirect).toHaveBeenCalledExactlyOnceWith("/admin/login");
    expect(boundary.validateSession).not.toHaveBeenCalled();
    const page = await AdminPage();
    expect(isValidElement(page)).toBe(true);
    expect(boundary.validateSession).toHaveBeenCalledExactlyOnceWith(opaqueToken, "ADMIN");
  });

  it("executes zero API resource queries or writes for missing and USER principals", async () => {
    const resource = vi.fn(async () => Response.json({ reached: true }));
    const route = withAdminRoute(resource);
    const missing = await route(
      new Request(`${boundary.env.AUTH_URL}/api/admin/fixture`),
      undefined,
    );
    expect(missing.status).toBe(401);
    boundary.validateSession.mockRejectedValueOnce(new AuthAuthorizationError(403, "FORBIDDEN"));
    const user = await route(
      new Request(`${boundary.env.AUTH_URL}/api/admin/fixture`, { headers: { cookie } }),
      undefined,
    );
    expect(user.status).toBe(403);
    expect(resource).not.toHaveBeenCalled();
  });

  it("runs API resource work only after authentication and CSRF/Origin validation", async () => {
    const order: string[] = [];
    boundary.validateSession.mockImplementation(async () => {
      order.push("guard");
      return principal;
    });
    const resource = vi.fn(
      async (_request: Request, _context: unknown, actor: typeof principal) => {
        order.push("resource");
        return Response.json({ actorId: actor.id });
      },
    );
    const route = withAdminRoute(resource);
    const response = await route(
      new Request(`${boundary.env.AUTH_URL}/api/admin/fixture`, {
        method: "POST",
        headers: { cookie, origin: boundary.env.AUTH_URL, "x-csrf-token": csrfToken },
      }),
      undefined,
    );
    expect(response.status).toBe(200);
    expect(order).toEqual(["guard", "resource"]);
    expect(await response.json()).toEqual({ actorId: "trusted_admin" });
    resource.mockClear();
    const rejected = await route(
      new Request(`${boundary.env.AUTH_URL}/api/admin/fixture`, {
        method: "POST",
        headers: { cookie, origin: "https://foreign.invalid", "x-csrf-token": csrfToken },
      }),
      undefined,
    );
    expect(rejected.status).toBe(403);
    expect(resource).not.toHaveBeenCalled();
  });

  it("fails closed with a safe API error when the database is unavailable", async () => {
    const resource = vi.fn(async () => Response.json({ reached: true }));
    boundary.validateSession.mockRejectedValueOnce(new AuthUnavailableError());
    const response = await withAdminRoute(resource)(
      new Request(`${boundary.env.AUTH_URL}/api/admin/fixture`, { headers: { cookie } }),
      undefined,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(opaqueToken);
    expect(resource).not.toHaveBeenCalled();
  });

  it("executes zero Server Action work for unauthenticated or unauthorized requests", async () => {
    const resource = vi.fn(async () => ({ changed: true }));
    const action = withAdminAction(resource);
    boundary.headers.mockResolvedValueOnce(new Headers());
    await expect(action({ role: "ADMIN" }, csrfToken)).rejects.toMatchObject({ status: 401 });
    boundary.validateSession.mockRejectedValueOnce(new AuthAuthorizationError(403, "FORBIDDEN"));
    await expect(action({ userId: "forged_admin" }, csrfToken)).rejects.toMatchObject({
      status: 403,
    });
    expect(resource).not.toHaveBeenCalled();
    expect(boundary.headers).toHaveBeenCalledTimes(2);
    expect(boundary.cookies).not.toHaveBeenCalled();
  });

  it("authorizes a Server Action from the original Cookie header despite mutable cookie serialization", async () => {
    const mutable = new ResponseCookies(new Headers());
    for (const item of new RequestCookies(new Headers({ cookie })).getAll()) mutable.set(item);
    expect(mutable.toString().match(/Path=\//g)).toHaveLength(2);
    boundary.cookies.mockResolvedValue(mutable);
    const resource = vi.fn(async (_input: unknown, actor: typeof principal) => actor.id);
    expect(await withAdminAction(resource)({}, csrfToken)).toBe("trusted_admin");
    expect(boundary.validateSession).toHaveBeenCalledExactlyOnceWith(opaqueToken, "ADMIN");
    expect(resource).toHaveBeenCalledExactlyOnceWith({}, principal);
  });

  it("rejects duplicate incoming Cookie names before Server Action database or resource work", async () => {
    const duplicateCookie = `${cookie}; ${cookie.split(";", 1)[0]}`;
    boundary.headers.mockResolvedValue(
      new Headers({
        cookie: duplicateCookie,
        origin: boundary.env.AUTH_URL,
        "sec-fetch-site": "same-origin",
      }),
    );
    // A framework cookie map collapses duplicate names; authorization must retain the raw input.
    boundary.cookies.mockResolvedValue(
      new RequestCookies(new Headers({ cookie: duplicateCookie })),
    );
    const resource = vi.fn(async () => ({ changed: true }));
    await expect(withAdminAction(resource)({}, csrfToken)).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    });
    expect(boundary.validateSession).not.toHaveBeenCalled();
    expect(resource).not.toHaveBeenCalled();
  });

  it("ignores client identity claims and verifies CSRF before invoking Server Action work", async () => {
    const resource = vi.fn(async (_input: { userId: string }, actor: typeof principal) => actor.id);
    const action = withAdminAction(resource);
    expect(await action({ userId: "forged_admin" }, csrfToken)).toBe("trusted_admin");
    expect(resource).toHaveBeenCalledExactlyOnceWith({ userId: "forged_admin" }, principal);
    resource.mockClear();
    await expect(action({ userId: "forged_admin" }, "0".repeat(64))).rejects.toMatchObject({
      status: 403,
    });
    expect(resource).not.toHaveBeenCalled();
  });
});
