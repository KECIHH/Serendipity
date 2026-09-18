// @vitest-environment node
import "../phase018/env";
import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  MOCK_FAILURE_MODES,
  MOCK_INVALID_JSON_OUTPUT,
  MOCK_SCHEMA_MISMATCH_OUTPUT,
  MockAiProvider,
  type MockFailureMode,
} from "@/server/ai/mock-provider";
import type { ProviderResult } from "@/lib/ai/provider";
import { canonicalJson, PromptOutputSchemas, promptKeyContract } from "@/lib/ai/schemas";
import { safeParseAiJson } from "@/lib/ai/json-parser";

const request = {
  system: "synthetic system",
  userMessage: "synthetic message",
  maxOutputTokens: 2048,
  responseFormat: "json" as const,
};
function call(mode: MockFailureMode | undefined, extra: Record<string, unknown> = {}) {
  const provider = new MockAiProvider({ failureMode: mode, ...extra });
  return provider.complete(request, {
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 1000,
  });
}
function expectFailure(result: ProviderResult) {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  return result;
}

describe("single Mock provider failure fixtures", () => {
  it("mock-provider: every documented failure profile is fixed and deterministic", async () => {
    assert.deepEqual([...MOCK_FAILURE_MODES], [
      "success",
      "timeout",
      "rate_limit",
      "server_error",
      "invalid_json",
      "schema_mismatch",
      "network_error",
      "cancel",
    ]);
    const timeout = expectFailure(await call("timeout"));
    expect(timeout.errorCode).toBe("PROVIDER_TIMEOUT");
    expect(timeout.retryable).toBe(true);
    expect(timeout.receivedByte).toBe(false);
    const rate = expectFailure(await call("rate_limit"));
    expect(rate.errorCode).toBe("RATE_LIMITED");
    expect(rate.retryAfterMs).toBe(25);
    const server = expectFailure(await call("server_error"));
    expect(server.errorCode).toBe("PROVIDER_UNAVAILABLE");
    const network = expectFailure(await call("network_error"));
    expect(network.errorCode).toBe("PROVIDER_UNAVAILABLE");
    const cancelled = expectFailure(await call("cancel"));
    expect(cancelled.errorCode).toBe("CANCELLED");
    expect(cancelled.retryable).toBe(false);
  });

  it("mock-provider: malformed bodies stay provider successes and are classified by the parser", async () => {
    const invalid = await call("invalid_json");
    assert.equal(invalid.ok, true);
    if (!invalid.ok) throw new Error("unreachable");
    expect(invalid.output).toBe(MOCK_INVALID_JSON_OUTPUT);
    const schema = await call("schema_mismatch");
    assert.equal(schema.ok, true);
    if (!schema.ok) throw new Error("unreachable");
    expect(schema.output).toBe(MOCK_SCHEMA_MISMATCH_OUTPUT);
    const target = PromptOutputSchemas["nlu.extract"];
    expect(safeParseAiJson(MOCK_INVALID_JSON_OUTPUT, target)).toMatchObject({
      ok: false,
      errorCode: "INVALID_JSON",
    });
    expect(safeParseAiJson(MOCK_SCHEMA_MISMATCH_OUTPUT, target)).toMatchObject({
      ok: false,
      errorCode: "SCHEMA_MISMATCH",
    });
  });

  it("mock-provider: success, clock, usage, chunk boundaries and trace are caller supplied", async () => {
    const ticks = [1000, 1042];
    let index = 0;
    const output = JSON.stringify(promptKeyContract("nlu.extract").fixtureOutput);
    const provider = new MockAiProvider({
      failureMode: "success",
      output,
      clock: () => ticks[Math.min(index++, ticks.length - 1)]!,
      usage: { inputTokens: 3, outputTokens: 4 },
      chunkCount: 5,
      requestId: "mock-trace-fixed",
    });
    const deltas: string[] = [];
    const result = await provider.complete(request, {
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1000,
      onDelta: async (text) => {
        deltas.push(text);
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.output, "MOCK_DETERMINISM_REQUIRED").toBe(output);
    expect(result.durationMs).toBe(42);
    expect(result.providerRequestId).toBe("mock-trace-fixed");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(deltas.join("")).toBe(output);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.length).toBeLessThanOrEqual(5);
    expect(deltas.length).toBeLessThanOrEqual(Array.from(output).length);
    // Repeated identical calls cannot drift: same bytes, same hash, no randomness.
    const repeat = await call("success", { output, requestId: "mock-trace-fixed" });
    assert.equal(repeat.ok, true);
    if (!repeat.ok) throw new Error("unreachable");
    expect(repeat.output).toBe(output);
    expect(canonicalJson(repeat.output)).toBe(canonicalJson(output));
    expect(provider.calls).toHaveLength(1);
  });

  it("mock-provider: an aborted signal cancels before any chunk is produced", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await new MockAiProvider({ failureMode: "success" }).complete(request, {
      signal: controller.signal,
      deadlineAt: Date.now() + 1000,
    });
    const failure = expectFailure(result);
    expect(failure.errorCode).toBe("CANCELLED");
    expect(failure.receivedByte).toBe(false);
  });
});
