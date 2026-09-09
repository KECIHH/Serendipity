import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(fs.readFileSync(path.join(root, "docs/env-registry.json"), "utf8"));
const entrypoints = new Set(["src/lib/env.ts", "src/lib/env-cli.ts", "vitest.setup.ts"]);

function relativeFile(filename) {
  return path.relative(root, filename).replaceAll(path.sep, "/");
}

function isProcessEnv(node) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object?.type === "Identifier" &&
    node.object.name === "process" &&
    node.property?.type === "Identifier" &&
    node.property.name === "env"
  );
}

function isImportMetaEnv(node) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object?.type === "MetaProperty" &&
    node.object.meta.name === "import" &&
    node.object.property.name === "meta" &&
    node.property?.type === "Identifier" &&
    node.property.name === "env"
  );
}

const plugin = {
  rules: {
    "no-unregistered-env": {
      meta: {
        type: "problem",
        docs: {
          description: "Require process.env reads to use the registered environment schema.",
        },
        schema: [],
      },
      create(context) {
        const file = relativeFile(context.getPhysicalFilename());
        const isEntrypoint = entrypoints.has(file);
        const isTestFile = file.includes(".test.");
        const allowed = new Map(
          registry.map((entry) => [entry.key, new Set(entry.readerPaths ?? [])]),
        );
        return {
          MemberExpression(node) {
            if (isImportMetaEnv(node)) {
              context.report({
                node,
                message: "Use the registered environment parser instead of import.meta.env.",
              });
              return;
            }
            if (!isProcessEnv(node)) return;
            if (isEntrypoint || isTestFile) return;
            const parent = node.parent;
            if (
              parent?.type === "MemberExpression" &&
              parent.object === node &&
              !parent.computed &&
              parent.property?.type === "Identifier"
            ) {
              const key = parent.property.name;
              if (!allowed.has(key) || !allowed.get(key).has(file)) {
                context.report({ node: parent, message: `Unregistered environment read: ${key}` });
              }
              return;
            }
            context.report({
              node,
              message: "Read environment values through a registered parser entrypoint.",
            });
          },
        };
      },
    },
  },
};

export default plugin;
