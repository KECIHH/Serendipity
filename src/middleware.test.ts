// @vitest-environment node
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config, isAdminPath, middleware } from "./middleware";

afterEach(() => vi.unstubAllEnvs());

describe("temporary /admin deny-all gate", () => {
  it("matches /admin and its descendants without matching /adminx", () => {
    for (const pathname of ["/admin", "/admin/", "/admin/settings", "/admin/login"])
      expect(isAdminPath(pathname)).toBe(true);
    for (const pathname of ["/", "/adminx", "/admins", "/x/admin", "/ADMIN"])
      expect(isAdminPath(pathname)).toBe(false);
  });

  it.each(["/admin", "/admin/settings", "/admin/login"])("returns 404 for %s", (pathname) => {
    const response = middleware(new NextRequest(`http://localhost${pathname}`));
    expect(response.status).toBe(404);
  });

  it("returns a null body and no identifying or redirect headers for /admin", async () => {
    const response = middleware(new NextRequest("http://localhost/admin"));
    expect(response.body).toBeNull();
    expect(await response.text()).toBe("");
    expect(response.headers.has("location")).toBe(false);
    expect([...response.headers.keys()].filter((name) => name.startsWith("x-"))).toEqual([]);
  });

  it.each(["development", "test", "production"] as const)(
    "denies /admin in the %s environment, including common bypass flags",
    (mode) => {
      vi.stubEnv("NODE_ENV", mode);
      for (const key of ["ADMIN_PREVIEW", "ALLOW_ADMIN", "ENABLE_ADMIN", "ADMIN_ENABLED"])
        vi.stubEnv(key, "true");
      expect(middleware(new NextRequest("http://localhost/admin")).status).toBe(404);
    },
  );

  it("ignores query parameters and cookies on /admin", () => {
    const response = middleware(
      new NextRequest("http://localhost/admin?preview=true&bypass=1&admin=true", {
        headers: { cookie: "admin=true; preview=true; bypass=1" },
      }),
    );
    expect(response.status).toBe(404);
    expect(response.body).toBeNull();
  });

  it("keeps both the exact /admin matcher and the /admin descendant matcher", () => {
    expect(config.matcher).toEqual(["/admin", "/admin/:path*"]);
  });

  it("has one unconditional empty 404 return with no environment, query or cookie bypass", () => {
    const source = readFileSync(new URL("./middleware.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/process\s*(?:\.|\[)|import\.meta|@\/lib\/env|node:|prisma/i);
    expect(source).not.toMatch(/searchParams|cookies|NextResponse\s*\.\s*next/);
    const ast = ts.createSourceFile("middleware.ts", source, ts.ScriptTarget.Latest, true);
    const imports = ast.statements.filter(ts.isImportDeclaration);
    expect(imports.map((node) => (node.moduleSpecifier as ts.StringLiteral).text)).toEqual([
      "next/server",
    ]);
    const handler = ast.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === "middleware",
    );
    expect(handler?.body?.statements).toHaveLength(1);
    const statement = handler!.body!.statements[0];
    expect(ts.isReturnStatement(statement)).toBe(true);
    const expression = (statement as ts.ReturnStatement).expression!;
    expect(ts.isNewExpression(expression)).toBe(true);
    const response = expression as ts.NewExpression;
    expect(response.expression.getText(ast)).toBe("NextResponse");
    expect(response.arguments).toHaveLength(2);
    expect(response.arguments![0].kind).toBe(ts.SyntaxKind.NullKeyword);
    const options = response.arguments![1] as ts.ObjectLiteralExpression;
    expect(ts.isObjectLiteralExpression(options)).toBe(true);
    expect(options.properties).toHaveLength(1);
    const status = options.properties[0] as ts.PropertyAssignment;
    expect(status.name.getText(ast)).toBe("status");
    expect(status.initializer.getText(ast)).toBe("404");
  });
});
