// @vitest-environment node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, isAdminPath, middleware } from "./middleware";

beforeEach(() => vi.stubEnv("AUTH_URL", "http://localhost:3000"));
afterEach(() => vi.unstubAllEnvs());

describe("administrator routing prefilter", () => {
  it("matches /admin and descendants without matching /adminx", () => {
    for (const pathname of ["/admin", "/admin/", "/admin/settings", "/admin/login"])
      expect(isAdminPath(pathname)).toBe(true);
    for (const pathname of ["/", "/adminx", "/admins", "/x/admin", "/ADMIN"])
      expect(isAdminPath(pathname)).toBe(false);
  });

  it.each(["/admin/login", "/admin/login/", "/api/auth/callback/credentials", "/login"])(
    "keeps the public login/framework route %s reachable",
    (pathname) => {
      const response = middleware(new NextRequest(`http://localhost${pathname}`));
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(response.headers.has("location")).toBe(false);
    },
  );

  it.each(["/admin", "/admin/settings"])("redirects an unauthenticated %s to login", (pathname) => {
    const response = middleware(new NextRequest(`http://localhost${pathname}`));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/admin/login");
    expect(response.body).toBeNull();
  });

  it("does not derive an external redirect from a supplied host", () => {
    const response = middleware(
      new NextRequest("https://untrusted.invalid/admin", {
        headers: { "x-forwarded-host": "other.invalid" },
      }),
    );
    expect(response.headers.get("location")).toBe("http://localhost:3000/admin/login");
  });

  it("preserves the configured origin through the real Next middleware adapter", () => {
    const source = `
      import assert from 'node:assert/strict';
      import { AsyncLocalStorage } from 'node:async_hooks';
      import { createRequire } from 'node:module';
      globalThis.AsyncLocalStorage = AsyncLocalStorage;
      const load = createRequire(import.meta.url);
      const { default: nextConfig } = load('./next.config.ts');
      const { middleware } = load('./src/middleware.ts');
      const { adapter } = load('next/dist/server/web/adapter.js');
      // Next's DefinePlugin maps this standard config flag into its adapter bundle.
      process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE = nextConfig.skipMiddlewareUrlNormalize ? '1' : '';
      for (const origin of ['http://127.0.0.1:3000', 'http://[::1]:3000', 'https://admin.example.invalid']) {
        process.env.AUTH_URL = origin;
        const { response, waitUntil } = await adapter({
          page: '/middleware',
          handler: async request => middleware(request),
          request: {
            url: origin + '/admin',
            method: 'GET',
            headers: { host: new URL(origin).host, 'x-forwarded-host': 'foreign.invalid' },
            signal: new AbortController().signal,
            nextConfig: {},
          },
        });
        await waitUntil;
        assert.equal(response.status, 307);
        assert.equal(response.headers.get('location'), origin + '/admin/login');
      }
      console.log('PASS:3');
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module"], {
      input: source,
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, NODE_ENV: "test", NEXT_PRIVATE_TEST_PROXY: "false" },
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("PASS:3");
  }, 20_000);

  it.each(["development", "test", "production"] as const)(
    "has no preview environment, query or cookie bypass in %s",
    (mode) => {
      vi.stubEnv("NODE_ENV", mode);
      for (const key of ["ADMIN_PREVIEW", "ALLOW_ADMIN", "ENABLE_ADMIN", "ADMIN_ENABLED"])
        vi.stubEnv(key, "true");
      const response = middleware(
        new NextRequest("http://localhost/admin?preview=true&bypass=1&admin=true", {
          headers: { cookie: "admin=true; preview=true; bypass=1; role=ADMIN" },
        }),
      );
      expect(response.status).toBe(307);
    },
  );

  it("only prefilters cookie presence and leaves database authorization to the server guard", () => {
    for (const name of [
      "authjs.session-token",
      "__Secure-authjs.session-token",
      "authjs.session-token.0",
    ]) {
      const response = middleware(
        new NextRequest("http://localhost/admin", {
          headers: { cookie: `${name}=untrusted-cookie` },
        }),
      );
      expect(response.headers.get("x-middleware-next")).toBe("1");
    }
    expect(
      middleware(
        new NextRequest("http://localhost/admin", {
          headers: { cookie: "authjs.session-token=" },
        }),
      ).status,
    ).toBe(307);
  });

  it("keeps the exact route matcher and excludes database or server auth code from Edge", () => {
    expect(config.matcher).toEqual(["/admin", "/admin/:path*"]);
    const source = readFileSync(new URL("./middleware.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/import\.meta|node:|prisma|searchParams/i);
    const ast = ts.createSourceFile("middleware.ts", source, ts.ScriptTarget.Latest, true);
    const imports = ast.statements.filter(ts.isImportDeclaration);
    expect(imports.map((node) => (node.moduleSpecifier as ts.StringLiteral).text)).toEqual([
      "next/server",
      "@/lib/env-schema",
    ]);
    const environmentReads: string[] = [];
    function inspect(node: ts.Node) {
      if (ts.isIdentifier(node) && node.text === "process") {
        const envAccess = node.parent;
        expect(ts.isPropertyAccessExpression(envAccess)).toBe(true);
        expect(envAccess.getText(ast)).toBe("process.env");
        const keyAccess = envAccess.parent;
        expect(ts.isPropertyAccessExpression(keyAccess)).toBe(true);
        environmentReads.push(keyAccess.getText(ast));
      }
      ts.forEachChild(node, inspect);
    }
    inspect(ast);
    expect(environmentReads).toEqual(["process.env.AUTH_URL"]);
  });
});
