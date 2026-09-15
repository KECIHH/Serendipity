import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { format } from "prettier";

function block(file, name) {
  const text = fs.readFileSync(file, "utf8");
  const marker = `<!-- contract:${name} -->`;
  assert.equal(text.split(marker).length, 2, `CONTRACT_BLOCK:${name}`);
  const match = text
    .slice(text.indexOf(marker) + marker.length)
    .match(/^\s*```json\s*([\s\S]*?)```/);
  assert(match, `CONTRACT_BLOCK:${name}`);
  return JSON.parse(match[1]);
}
const travelFile = "docs/travel-plan-schema.md";
const requirement = block(travelFile, "travel-requirement-v1");
const summary = block(travelFile, "travel-summary-v1");
const scalars = block(travelFile, "requirement-scalar-policy-v1");
const prompts = block("docs/prompt-design.md", "prompt-keys");
const registry = JSON.parse(fs.readFileSync("src/lib/ai/prompt-contract.json", "utf8"));
assert.deepEqual(registry.travelDefinitions, requirement.$defs, "TRAVEL_DEFINITION_DRIFT");
assert.deepEqual(registry.definitions, prompts.$defs, "PROMPT_DEFINITION_DRIFT");
assert.deepEqual(registry.keys, prompts.keys, "PROMPT_REGISTRY_DRIFT");

const names = {
  "nlu.extract": "NluExtractOutput",
  "nlu.ask_missing": "NluAskMissingOutput",
  "planner.generate": "PlannerGenerateOutput",
  "planner.repair_json": "PlannerRepairJsonOutput",
  "conversation.modify": "ConversationModifyOutput",
  "planner.score": "PlannerScoreOutput",
  "planner.final_summary": "PlannerFinalSummaryOutput",
  "export.markdown": "ExportMarkdownOutput",
};
function typeOf(schema, document = "travel") {
  if (schema.$ref) {
    const [ref, name] = schema.$ref.split("#/$defs/");
    assert(name && ["", "travel-requirement-v1"].includes(ref), "UNSUPPORTED_REF");
    return `${ref === "travel-requirement-v1" || document === "travel" ? "" : "Prompt"}${name}`;
  }
  if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((x) => JSON.stringify(x)).join(" | ");
  if (schema.anyOf || schema.oneOf)
    return (schema.anyOf ?? schema.oneOf).map((x) => typeOf(x, document)).join(" | ");
  if (Array.isArray(schema.type))
    return schema.type.map((type) => typeOf({ ...schema, type }, document)).join(" | ");
  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false, "OPEN_OBJECT");
    return `{ ${Object.entries(schema.properties)
      .map(
        ([key, child]) =>
          `readonly ${JSON.stringify(key)}${schema.required.includes(key) ? "" : "?"}: ${typeOf(child, document)};`,
      )
      .join("\n")} }`;
  }
  if (schema.type === "array") return `ReadonlyArray<${typeOf(schema.items, document)}>`;
  assert(
    ["integer", "number", "string", "boolean", "null"].includes(schema.type),
    "UNSUPPORTED_TYPE",
  );
  return schema.type === "integer" ? "number" : schema.type;
}
const declarations = [
  "// Generated from the named contracts in docs/travel-plan-schema.md and docs/prompt-design.md.",
  "// Run node scripts/generate-ai-schemas.mjs; do not maintain a second field definition.",
  ...Object.entries(requirement.$defs).map(
    ([name, schema]) => `export type ${name} = ${typeOf(schema)};`,
  ),
  ...Object.entries(prompts.$defs).map(
    ([name, schema]) => `export type Prompt${name} = ${typeOf(schema, "prompt")};`,
  ),
  `export type TravelPlanSummaryDraft = ${typeOf(summary)};`,
  ...registry.keys.map(
    (key) => `export type ${names[key.key]} = ${typeOf(key.responseSchema, "prompt")};`,
  ),
  ...registry.keys.map(
    (key) =>
      `export type ${names[key.key].replace("Output", "Input")} = ${typeOf(key.inputSchema, "prompt")};`,
  ),
  `export interface PromptOutputMap { ${Object.entries(names)
    .map(([key, name]) => `readonly ${JSON.stringify(key)}: ${name};`)
    .join("\n")} }`,
  `export interface PromptInputMap { ${Object.entries(names)
    .map(([key, name]) => `readonly ${JSON.stringify(key)}: ${name.replace("Output", "Input")};`)
    .join("\n")} }`,
];
const outputs = {
  "src/lib/ai/schema-types.ts": await format(declarations.join("\n\n"), {
    parser: "typescript",
    printWidth: 100,
  }),
  "src/lib/ai/travel-contract.json": `${JSON.stringify({ requirement, summary, scalars }, null, 2)}\n`,
};
for (const [file, content] of Object.entries(outputs)) {
  if (process.argv.includes("--check"))
    assert.equal(fs.readFileSync(file, "utf8"), content, `GENERATED_SCHEMA_DRIFT:${file}`);
  else fs.writeFileSync(file, content);
}
console.log(
  JSON.stringify({
    status: "PASS",
    mode: process.argv.includes("--check") ? "check" : "generate",
    files: Object.entries(outputs).map(([path, content]) => ({
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
    })),
  }),
);
