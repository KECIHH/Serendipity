import "server-only";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import type {
  ProviderAdapter,
  ProviderCallContext,
  ProviderRequest,
  ProviderResult,
  ProviderFailure,
} from "@/lib/ai/provider";
import {
  decryptSecret,
  generateFingerprint,
  type KeyResolver,
} from "@/server/security/secret-envelope";
import {
  resolveProviderEndpoint,
  type ResolvedEndpoint,
  type UrlGuardOptions,
} from "@/server/ai/url-guard";

const MAX_RESPONSE_BYTES = 262144;
export type HttpTransport = (
  url: string,
  init: RequestInit,
  endpoint: ResolvedEndpoint,
) => Promise<{ status: number; headers: Headers; body: ReadableStream<Uint8Array> | null }>;
const isolatedTransports = new WeakSet<HttpTransport>();

const pinnedTransport: HttpTransport = (url, init, endpoint) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(
      target,
      {
        method: init.method,
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        agent: false,
        family: endpoint.family,
        signal: init.signal ?? undefined,
        lookup: (_host, _options, callback) => callback(null, endpoint.address, endpoint.family),
      },
      (response) => {
        const remote = response.socket.remoteAddress?.replace(/^::ffff:/, "");
        if (remote !== endpoint.address) {
          response.destroy();
          reject(new Error("CONFIG_ERROR"));
          return;
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers))
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        resolve({
          status: response.statusCode ?? 0,
          headers,
          body: Readable.toWeb(response) as ReadableStream<Uint8Array>,
        });
      },
    );
    request.on("error", reject);
    request.end(typeof init.body === "string" ? init.body : undefined);
  });
export const defaultHttpTransport = pinnedTransport;

/** Only a real loopback HTTP endpoint in a test process may replace pinned public HTTPS. */
export function createIsolatedHttpTransport(origin: string): HttpTransport {
  const target = new URL(origin);
  if (
    process.env.NODE_ENV !== "test" ||
    target.protocol !== "http:" ||
    target.hostname !== "127.0.0.1" ||
    !target.port ||
    target.origin !== origin
  )
    throw new Error("CONFIG_ERROR");
  const transport: HttpTransport = async (url, init) => {
    if (process.env.NODE_ENV !== "test") throw new Error("CONFIG_ERROR");
    const source = new URL(url);
    const local = new URL(source.pathname, target);
    return pinnedTransport(local.href, init, { url: local, address: "127.0.0.1", family: 4 });
  };
  isolatedTransports.add(transport);
  return transport;
}
export function isIsolatedHttpTransport(transport: HttpTransport | undefined): boolean {
  return !!transport && process.env.NODE_ENV === "test" && isolatedTransports.has(transport);
}
export interface SecretRecord {
  id: string;
  provider: string;
  encryptedKey: string;
  encryptionKeyId: string;
  envelopeVersion: number;
  keyFingerprint: string;
}
export function resolveDeepSeekSecret(record: SecretRecord, resolver?: KeyResolver): string {
  const secret = decryptSecret(record, resolver);
  if (generateFingerprint(secret) !== record.keyFingerprint) throw new Error("CONFIG_ERROR");
  return secret;
}
export interface DeepSeekProviderOptions extends UrlGuardOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly secretRecord?: SecretRecord;
  readonly keyResolver?: KeyResolver;
  readonly resolveSecret?: (record: SecretRecord) => string;
  readonly transport?: HttpTransport;
  readonly maxResponseBytes?: number;
}
async function readBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal,
  onBytes: () => void,
  onText?: (text: string) => Promise<void>,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new Error("CANCELLED");
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error("CANCELLED");
      if (done) break;
      if (value.byteLength) onBytes();
      total += value.byteLength;
      if (total > limit) throw new Error("RESPONSE_SIZE");
      chunks.push(value);
      if (onText) await onText(decoder.decode(value, { stream: true }));
    }
    if (onText) await onText(decoder.decode());
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const milliseconds = /^\d+(?:\.\d+)?$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}
function parseCompletion(body: string, streaming: boolean) {
  let output = "",
    usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
    id: string | undefined;
  if (streaming) {
    let done = false;
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      if (data === "[DONE]") {
        done = true;
        continue;
      }
      if (done) throw new Error("INVALID_JSON");
      const frame = JSON.parse(data);
      if (frame.error) throw new Error("PROVIDER_RESPONSE");
      if (frame.id !== undefined) {
        if (id !== undefined && id !== frame.id) throw new Error("PROVIDER_RESPONSE");
        id = frame.id;
      }
      if (frame.usage) usage = frame.usage;
      const content = frame.choices?.[0]?.delta?.content;
      if (content !== undefined && content !== null) {
        if (typeof content !== "string") throw new Error("INVALID_JSON");
        output += content;
      }
    }
    if (!done) throw new Error("INCOMPLETE_STREAM");
  } else {
    const parsed = JSON.parse(body);
    output = parsed.choices?.[0]?.message?.content;
    usage = parsed.usage;
    id = parsed.id;
  }
  if (
    typeof output !== "string" ||
    !output ||
    !usage ||
    !Number.isSafeInteger(usage.prompt_tokens) ||
    !Number.isSafeInteger(usage.completion_tokens) ||
    usage.prompt_tokens! < 0 ||
    usage.completion_tokens! < 0 ||
    (id !== undefined && (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)))
  )
    throw new Error("PROVIDER_RESPONSE");
  return {
    output,
    usage: { inputTokens: usage.prompt_tokens!, outputTokens: usage.completion_tokens! },
    id,
  };
}
export class DeepSeekProvider implements ProviderAdapter {
  readonly id = "deepseek";
  private prepared?: {
    endpoint: ResolvedEndpoint;
    signal: AbortSignal;
    deadlineAt: number;
    key?: string;
  };
  constructor(private readonly options: DeepSeekProviderOptions) {
    if (
      (options.transport && !isIsolatedHttpTransport(options.transport)) ||
      (options.resolveSecret && process.env.NODE_ENV !== "test") ||
      (options.apiKey && process.env.NODE_ENV !== "test")
    )
      throw new Error("CONFIG_ERROR");
  }
  async prepare(context: ProviderCallContext): Promise<void> {
    const endpoint = await resolveProviderEndpoint(
      this.options.baseUrl,
      this.options,
      context.signal,
    );
    this.prepared = {
      endpoint,
      signal: context.signal,
      deadlineAt: context.deadlineAt,
      key: this.readSecret(),
    };
  }
  private readSecret(): string | undefined {
    return this.options.secretRecord
      ? this.options.resolveSecret
        ? this.options.resolveSecret(this.options.secretRecord)
        : resolveDeepSeekSecret(this.options.secretRecord, this.options.keyResolver)
      : this.options.apiKey;
  }
  async complete(request: ProviderRequest, context: ProviderCallContext): Promise<ProviderResult> {
    const startedAt = Date.now();
    let receivedByte = false,
      submitted = false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) controller.abort();
    const timer = setTimeout(abort, Math.max(0, context.deadlineAt - Date.now()));
    const failure = (
      errorCode: ProviderFailure["errorCode"],
      retryable = false,
      extra: Partial<ProviderFailure> = {},
    ): ProviderFailure => ({
      ok: false,
      errorCode,
      retryable: retryable && !receivedByte,
      receivedByte,
      durationMs: Date.now() - startedAt,
      definitelyNotSent: !submitted,
      ...extra,
    });
    try {
      if (controller.signal.aborted || Date.now() >= context.deadlineAt)
        return failure(context.signal.aborted ? "CANCELLED" : "PROVIDER_TIMEOUT");
      const prepared = this.prepared;
      this.prepared = undefined;
      const preparedForCall =
        prepared?.signal === context.signal && prepared.deadlineAt === context.deadlineAt;
      let endpoint = preparedForCall
        ? prepared.endpoint
        : await resolveProviderEndpoint(this.options.baseUrl, this.options, controller.signal);
      endpoint = {
        ...endpoint,
        url: new URL(
          `${endpoint.url.pathname.replace(/\/$/, "")}/chat/completions`,
          endpoint.url.origin,
        ),
      };
      const key = preparedForCall ? prepared.key : this.readSecret();
      for (let hop = 0; hop <= 2; hop++) {
        if (controller.signal.aborted) throw new Error("CANCELLED");
        const headers = new Headers({
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "accept-encoding": "identity",
        });
        if (key) headers.set("authorization", `Bearer ${key}`);
        submitted = true;
        const response = await (this.options.transport ?? defaultHttpTransport)(
          endpoint.url.href,
          {
            method: "POST",
            headers,
            redirect: "manual",
            signal: controller.signal,
            body: JSON.stringify({
              model: this.options.model,
              messages: [
                { role: "system", content: request.system },
                { role: "user", content: request.userMessage },
                ...(request.userData ? [{ role: "user", content: request.userData }] : []),
              ],
              max_tokens: request.maxOutputTokens,
              temperature: request.temperature,
              response_format: { type: "json_object" },
              stream: true,
              stream_options: { include_usage: true },
            }),
          },
          endpoint,
        );
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          const location = response.headers.get("location");
          if (!location || hop === 2) return failure("PROVIDER_UNAVAILABLE");
          const next = await resolveProviderEndpoint(
            new URL(location, endpoint.url).href,
            this.options,
            controller.signal,
          );
          if (next.url.origin !== endpoint.url.origin) return failure("CONFIG_ERROR");
          endpoint = next;
          continue;
        }
        const streaming =
          response.headers.get("content-type")?.includes("text/event-stream") ?? false;
        let pendingFrame = "",
          streamDone = false;
        const body = await readBody(
          response.body,
          Math.min(this.options.maxResponseBytes ?? MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES),
          controller.signal,
          () => {
            receivedByte = true;
          },
          streaming && response.status >= 200 && response.status < 300 && context.onDelta
            ? async (chunk) => {
                pendingFrame += chunk;
                for (;;) {
                  const match = /\r?\n\r?\n/.exec(pendingFrame);
                  if (!match) break;
                  const frame = pendingFrame.slice(0, match.index);
                  pendingFrame = pendingFrame.slice(match.index + match[0].length);
                  const data = frame
                    .split(/\r?\n/)
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trimStart())
                    .join("\n");
                  if (!data) continue;
                  if (data === "[DONE]") {
                    streamDone = true;
                    continue;
                  }
                  if (streamDone) throw new Error("INVALID_JSON");
                  const decoded = JSON.parse(data);
                  if (decoded.error) throw new Error("PROVIDER_RESPONSE");
                  const text = decoded.choices?.[0]?.delta?.content;
                  if (text !== undefined && text !== null) {
                    if (typeof text !== "string") throw new Error("INVALID_JSON");
                    await context.onDelta!(text);
                  }
                }
              }
            : undefined,
        );
        if (response.status < 200 || response.status >= 300)
          return failure(
            response.status === 429 ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE",
            response.status === 429 || response.status >= 500,
            { retryAfterMs: retryAfter(response.headers.get("retry-after")) },
          );
        let parsed;
        try {
          parsed = parseCompletion(body, streaming);
        } catch {
          return failure("PROVIDER_UNAVAILABLE", false, { internalCode: "INVALID_JSON" });
        }
        if (parsed.usage.outputTokens > request.maxOutputTokens)
          return failure("PROVIDER_UNAVAILABLE");
        if (!streaming) await context.onDelta?.(parsed.output);
        return {
          ok: true,
          output: parsed.output,
          usage: parsed.usage,
          providerRequestId: parsed.id,
          receivedByte: true,
          durationMs: Date.now() - startedAt,
        };
      }
      return failure("PROVIDER_UNAVAILABLE");
    } catch (error) {
      if (controller.signal.aborted)
        return failure(context.signal.aborted ? "CANCELLED" : "PROVIDER_TIMEOUT");
      if (error instanceof Error && error.message === "CONFIG_ERROR")
        return failure("CONFIG_ERROR");
      const code = (error as { code?: string })?.code;
      return failure(
        "PROVIDER_UNAVAILABLE",
        !!code && ["ECONNREFUSED", "ECONNRESET", "EAI_AGAIN", "ETIMEDOUT"].includes(code),
      );
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", abort);
    }
  }
}
