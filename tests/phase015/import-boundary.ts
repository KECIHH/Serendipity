import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export function scanAiBoundary(root = process.cwd()): string[] {
  const violations: string[] = [];
  const adapters = new Set([
    "src/server/ai/deepseek-provider.ts",
    "src/server/admin/key-candidate-client.ts",
  ]);
  const providerConsumers = new Set(["src/server/ai/provider-registry.ts"]);
  const files = fs.readdirSync(path.join(root, "src"), { recursive: true }) as string[];
  for (const relative of files.filter(
    (file) => /\.(ts|tsx)$/.test(file) && !/\.test\./.test(file),
  )) {
    const file = `src/${relative.replaceAll("\\", "/")}`;
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const report = (reason: string) => violations.push(`${file}:${reason}`);
    function inspect(node: ts.Node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const name = node.moduleSpecifier.text;
        const typeOnly =
          node.importClause?.isTypeOnly ||
          (node.importClause?.namedBindings &&
            ts.isNamedImports(node.importClause.namedBindings) &&
            node.importClause.namedBindings.elements.every((e) => e.isTypeOnly));
        if (!typeOnly) {
          if (
            /^(?:openai|@deepseek|@anthropic-ai|undici|axios)(?:\/|$)/.test(name) &&
            !adapters.has(file)
          )
            report("sdk-import");
          if (/^(?:node:)?https?$/.test(name) && !adapters.has(file)) report("network-import");
          if (/deepseek-provider$/.test(name) && !providerConsumers.has(file))
            report("direct-adapter-import");
          if (/provider-registry$/.test(name) && file !== "src/server/ai/guarded-client.ts")
            report("direct-registry-import");
          if (
            /secret-envelope$/.test(name) &&
            file.startsWith("src/server/ai/") &&
            !adapters.has(file)
          ) {
            const bindings = node.importClause?.namedBindings;
            if (
              bindings &&
              ts.isNamedImports(bindings) &&
              bindings.elements.some(
                (e) => !e.isTypeOnly && (e.propertyName?.text ?? e.name.text) === "decryptSecret",
              )
            )
              report("secret-resolution-outside-adapter");
          }
        }
      }
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(ast);
        if (
          /^(?:fetch|globalThis\.fetch|window\.fetch)$/.test(name) &&
          !adapters.has(file) &&
          (file.startsWith("src/server/") ||
            file.startsWith("src/lib/") ||
            file.startsWith("src/app/") ||
            /https?:|deepseek|openai/i.test(node.arguments[0]?.getText(ast) ?? ""))
        )
          report("direct-fetch");
        if (
          (name === "require" || node.expression.kind === ts.SyntaxKind.ImportKeyword) &&
          /openai|deepseek-provider|provider-registry|node:https?/.test(
            node.arguments[0]?.getText(ast) ?? "",
          )
        )
          report("dynamic-egress-import");
      }
      ts.forEachChild(node, inspect);
    }
    inspect(ast);
    if (
      file.startsWith("src/server/ai/") &&
      !source.trimStart().startsWith('import "server-only";')
    )
      report("missing-server-only");
  }
  return violations;
}
