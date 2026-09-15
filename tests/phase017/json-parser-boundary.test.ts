// @vitest-environment node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("client import boundary", () => {
  it("parse: browser bundle imports and executes the pure parser with its typed schemas", async () => {
    const result = await build({
      stdin: {
        contents:
          'import { safeParseAiJson } from "./src/lib/ai/json-parser"; import { NluExtractOutputSchema } from "./src/lib/ai/schemas"; globalThis.parsed = safeParseAiJson(\'{"schemaVersion":1,"candidates":[]}\', NluExtractOutputSchema);',
        resolveDir: process.cwd(),
        loader: "ts",
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    expect(
      Object.keys(result.metafile!.inputs).some((file) =>
        /src\/server\/|src\/lib\/env|node:|server-only/.test(file.replaceAll("\\", "/")),
      ),
    ).toBe(false);
    const sandbox: Record<string, unknown> = { structuredClone, TextEncoder };
    runInNewContext(result.outputFiles[0].text, sandbox);
    expect(sandbox.parsed).toEqual({ ok: true, data: { schemaVersion: 1, candidates: [] } });
  });
  it.each(["src/server/ai/json-repair.ts", "src/lib/env.ts"])(
    "parse: client runtime rejects the real server-only import %s",
    (file) => {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `await import(${JSON.stringify(pathToFileURL(path.resolve(file)).href)});`,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, NODE_OPTIONS: "" },
          encoding: "utf8",
          windowsHide: true,
          timeout: 15000,
        },
      );
      expect(result.status).toBe(1);
      expect(
        result.stderr.includes("This module cannot be imported from a Client Component module"),
      ).toBe(true);
    },
  );
});
