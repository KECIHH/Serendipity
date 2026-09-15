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

export interface MockProviderOptions {
  readonly events?: readonly MockProviderEvent[];
  readonly clock?: () => number;
  readonly output?: string;
  readonly usage?: { inputTokens: number; outputTokens: number };
  readonly chunkCount?: number;
  readonly delayMs?: number;
}

export class MockAiProvider implements ProviderAdapter {
  readonly id = "mock";
  readonly calls: ProviderRequest[] = [];
  private nextEvent = 0;

  constructor(private readonly options: MockProviderOptions = {}) {}

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
    if (context.signal.aborted || event === "cancel") {
      return {
        ok: false,
        errorCode: "CANCELLED",
        retryable: false,
        receivedByte: false,
        durationMs,
      };
    }
    if (event === "timeout")
      return {
        ok: false,
        errorCode: "PROVIDER_TIMEOUT",
        retryable: true,
        receivedByte: false,
        durationMs,
      };
    if (event === "rate_limit")
      return {
        ok: false,
        errorCode: "RATE_LIMITED",
        retryable: true,
        receivedByte: false,
        durationMs,
        retryAfterMs: 25,
      };
    if (event === "server_error")
      return {
        ok: false,
        errorCode: "PROVIDER_UNAVAILABLE",
        retryable: true,
        receivedByte: false,
        durationMs,
      };
    if (event === "network_error")
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
    const output =
      this.options.output ??
      `{"ok":true,"chunks":${this.options.chunkCount ?? 1},"prompt":"${request.system.length}"}${" ".repeat(0)}`;
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
      usage: this.options.usage ?? { inputTokens: 12, outputTokens: 24 },
      durationMs,
      receivedByte: true,
      providerRequestId: `mock-${this.calls.length}`,
    };
  }
}
