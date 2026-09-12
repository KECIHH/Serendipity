// @vitest-environment node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(entryPath) : entry.isFile() ? [entryPath] : [];
  });
}

function readTsx(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function toasterMountCount(node: ts.Node, sourceFile: ts.SourceFile): number {
  let count = 0;
  function visit(child: ts.Node): void {
    if (
      (ts.isJsxSelfClosingElement(child) || ts.isJsxOpeningElement(child)) &&
      child.tagName.getText(sourceFile).split(".").at(-1) === "Toaster"
    ) {
      count += 1;
    }
    ts.forEachChild(child, visit);
  }
  visit(node);
  return count;
}

describe("application layout boundaries", () => {
  it("mounts a single Toaster inside the root layout body", () => {
    const layoutPaths = [
      "src/app/layout.tsx",
      "src/app/(site)/layout.tsx",
      "src/app/admin/layout.tsx",
    ];
    const layouts = layoutPaths.map((filePath) => readTsx(resolve(repositoryRoot, filePath)));
    const mounts = sourceFiles(resolve(repositoryRoot, "src"))
      .filter((filePath) => filePath.endsWith(".tsx") && !/\.(test|spec)\.tsx$/.test(filePath))
      .sort()
      .flatMap((filePath) => {
        const sourceFile = readTsx(filePath);
        const count = toasterMountCount(sourceFile, sourceFile);
        return count > 0
          ? [{ file: relative(repositoryRoot, filePath).replaceAll("\\", "/"), count }]
          : [];
      });

    expect(mounts).toEqual([{ file: "src/app/layout.tsx", count: 1 }]);
    expect(layouts.map((layout) => toasterMountCount(layout, layout))).toEqual([1, 0, 0]);

    const rootLayout = layouts[0];
    const bodyCounts: number[] = [];
    function visit(node: ts.Node): void {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(rootLayout) === "body") {
        bodyCounts.push(toasterMountCount(node, rootLayout));
      }
      ts.forEachChild(node, visit);
    }
    visit(rootLayout);
    expect(bodyCounts).toEqual([1]);
  });

  it("keeps only the route-group homepage after migration", () => {
    expect(existsSync(resolve(repositoryRoot, "src/app/page.tsx"))).toBe(false);
    expect(existsSync(resolve(repositoryRoot, "src/app/(site)/page.tsx"))).toBe(true);
  });

  it("keeps public login separate from all five protected administration pages", () => {
    const adminPages = sourceFiles(resolve(repositoryRoot, "src/app/admin")).filter((filePath) =>
      /[/\\]page\.[jt]sx?$/.test(filePath),
    );

    expect(
      adminPages.map((filePath) => relative(repositoryRoot, filePath).replaceAll("\\", "/")).sort(),
    ).toEqual([
      "src/app/admin/(protected)/api-keys/page.tsx",
      "src/app/admin/(protected)/logs/page.tsx",
      "src/app/admin/(protected)/page.tsx",
      "src/app/admin/(protected)/settings/page.tsx",
      "src/app/admin/(protected)/users/page.tsx",
      "src/app/admin/(public)/login/page.tsx",
    ]);
    const adminLayout = readFileSync(resolve(repositoryRoot, "src/app/admin/layout.tsx"), "utf8");
    expect(adminLayout).not.toMatch(/AdminShell|AdminSidebar|SiteHeader/);
  });
});
