import "server-only";

import type {
  ProviderAdapter,
  ProviderCallContext,
  ProviderRequest,
  ProviderResult,
} from "@/lib/ai/provider";

export type MockProviderEvent =
  | "success"
  | "timeout"
  | "rate_limit"
  | "server_error"
  | "network_error"
  | "invalid_json"
  | "cancel";

/**
 * Phase018 fixed failure profiles for the single Mock provider. Every profile is a pure
 * function of its inputs: no random delay, no random content and no network egress.
 */
export const MOCK_FAILURE_MODES = [
  "success",
  "timeout",
  "rate_limit",
  "server_error",
  "invalid_json",
  "schema_mismatch",
  "network_error",
  "cancel",
] as const;
export type MockFailureMode = (typeof MOCK_FAILURE_MODES)[number];

/** Truncated JSON: the parser classifies INVALID_JSON without inventing any field. */
export const MOCK_INVALID_JSON_OUTPUT = '{"summary":"synthetic","status":';
/** Well-formed JSON that cannot satisfy any registered prompt schema. */
export const MOCK_SCHEMA_MISMATCH_OUTPUT = '{"unexpected":true}';

export interface MockProviderOptions {
  readonly events?: readonly MockProviderEvent[];
  readonly failureMode?: MockFailureMode;
  readonly clock?: () => number;
  readonly output?: string;
  readonly usage?: { inputTokens: number; outputTokens: number } | null;
  readonly chunkCount?: number;
  readonly delayMs?: number;
  readonly requestId?: string;
}

export class MockAiProvider implements ProviderAdapter {
  readonly id = "mock";
  readonly calls: ProviderRequest[] = [];
  private nextEvent = 0;

  constructor(private readonly options: MockProviderOptions = {}) {}

  private async emit(output: string, context: ProviderCallContext) {
    const characters = Array.from(output);
    const chunkSize = Math.max(1, Math.ceil(characters.length / (this.options.chunkCount ?? 3)));
    for (let at = 0; at < characters.length; at += chunkSize) {
      if (context.signal.aborted) return false;
      await context.onDelta?.(characters.slice(at, at + chunkSize).join(""));
    }
    return true;
  }

  private fixtureOutput(request: ProviderRequest): string {
    return (
      this.options.output ??
      `{"ok":true,"chunks":${this.options.chunkCount ?? 1},"prompt":"${request.system.length}"}${" ".repeat(0)}`
    );
  }

  async complete(request: ProviderRequest, context: ProviderCallContext): Promise<ProviderResult> {
    this.calls.push(request);
    const event = this.options.events?.[this.nextEvent] ?? "success";
    this.nextEvent += 1;
    const started = this.options.clock?.() ?? 0;
    if (this.options.delayMs && !context.signal.aborted)
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          context.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, this.options.delayMs);
        context.signal.addEventListener("abort", finish, { once: true });
      });
    const durationMs = Math.max(0, (this.options.clock?.() ?? started) - started);
    const requestId = this.options.requestId ?? `mock-${this.calls.length}`;
    if (context.signal.aborted || event === "cancel" || this.options.failureMode === "cancel") {
      return {
        ok: false,
        errorCode: "CANCELLED",
        retryable: false,
        receivedByte: false,
        durationMs,
      };
    }
    // A malformed but "returned" body keeps the parser boundary under test: the provider
    // itself succeeds, and only the deterministic classifier may reject the payload.
    const failureMode = this.options.failureMode;
    if (failureMode === "invalid_json" || failureMode === "schema_mismatch") {
      const output =
        failureMode === "invalid_json" ? MOCK_INVALID_JSON_OUTPUT : MOCK_SCHEMA_MISMATCH_OUTPUT;
      if (!(await this.emit(output, context)))
        return {
          ok: false,
          errorCode: "CANCELLED",
          retryable: false,
          receivedByte: true,
          durationMs,
        };
      return {
        ok: true,
        output,
        usage:
          this.options.usage === undefined
            ? { inputTokens: 12, outputTokens: 24 }
            : this.options.usage,
        durationMs,
        receivedByte: true,
        providerRequestId: requestId,
      };
    }
    if (failureMode === "timeout" || event === "timeout")
      return {
        ok: false,
        errorCode: "PROVIDER_TIMEOUT",
        retryable: true,
        receivedByte: false,
        durationMs,
      };
    if (failureMode === "rate_limit" || event === "rate_limit")
      return {
        ok: false,
        errorCode: "RATE_LIMITED",
        retryable: true,
        receivedByte: false,
        durationMs,
        retryAfterMs: 25,
      };
    if (failureMode === "server_error" || event === "server_error")
      return {
        ok: false,
        errorCode: "PROVIDER_UNAVAILABLE",
        retryable: true,
        receivedByte: false,
        durationMs,
      };
    if (failureMode === "network_error" || event === "network_error")
      return {
        ok: false,
        errorCode: "PROVIDER_UNAVAILABLE",
        retryable: true,
        receivedByte: false,
        durationMs,
      };
    if (event === "invalid_json")
      return {
        ok: false,
        errorCode: "PROVIDER_UNAVAILABLE",
        retryable: false,
        receivedByte: true,
        durationMs,
      };
    const output = this.fixtureOutput(request);
    const characters = Array.from(output);
    const chunkSize = Math.max(1, Math.ceil(characters.length / (this.options.chunkCount ?? 3)));
    for (let at = 0; at < characters.length; at += chunkSize) {
      if (context.signal.aborted)
        return {
          ok: false,
          errorCode: "CANCELLED",
          retryable: false,
          receivedByte: at > 0,
          durationMs,
        };
      await context.onDelta?.(characters.slice(at, at + chunkSize).join(""));
    }
    return {
      ok: true,
      output,
      usage:
        this.options.usage === undefined
          ? { inputTokens: 12, outputTokens: 24 }
          : this.options.usage,
      durationMs,
      receivedByte: true,
      providerRequestId: requestId,
    };
  }
}
