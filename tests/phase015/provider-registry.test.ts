// @vitest-environment node
import { lookup } from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeepSeekProvider,
  createIsolatedHttpTransport,
  type HttpTransport,
} from "@/server/ai/deepseek-provider";
import { validateProviderUrl } from "@/server/ai/url-guard";
import { scanAiBoundary } from "./import-boundary";
import { startHttpFixture, publicDns, sendCompletion } from "./http-fixture";

vi.mock("node:dns/promises", async (original) => ({
  ...(await original<typeof import("node:dns/promises")>()),
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));
const dns = (records: Array<{ address: string; family: number }>) =>
  (async () => records) as unknown as typeof lookup;
const request = {
  system: "synthetic system",
  userMessage: "synthetic user",
  userData: '{"bounded":"data"}',
  maxOutputTokens: 32,
  temperature: 0.25,
  responseFormat: "json",
} as const;
const context = (milliseconds = 2000) => ({
  signal: new AbortController().signal,
  deadlineAt: Date.now() + milliseconds,
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("Phase015 real provider isolation", () => {
  it("[isolation] default DNS lookup is used and only allowlisted HTTPS URLs pass", async () => {
    await expect(validateProviderUrl("https://api.deepseek.com/v1")).resolves.toBeInstanceOf(URL);
    expect(lookup).toHaveBeenCalledWith("api.deepseek.com", { all: true, verbatim: true });
    for (const url of [
      "http://api.deepseek.com",
      "https://evil.example.com",
      "https://api.deepseek.com:8443",
      "https://user@api.deepseek.com",
      "https://api.deepseek.com/?x=1",
      "https://api.deepseek.com/#x",
    ]) {
      await expect(validateProviderUrl(url)).rejects.toThrow("CONFIG_ERROR");
    }
  });
  it("[isolation] rejects private, reserved, mapped IPv6 and mixed DNS rebinding addresses", async () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "198.18.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:7f00:1",
      "::ffff:127.0.0.1",
      "2002:7f00:1::",
      "2001:db8::1",
      "0.0.0.0",
    ]) {
      await expect(
        validateProviderUrl("https://api.deepseek.com", {
          dnsLookup: dns([{ address, family: address.includes(":") ? 6 : 4 }]),
        }),
      ).rejects.toThrow("CONFIG_ERROR");
    }
    await expect(
      validateProviderUrl("https://api.deepseek.com", {
        dnsLookup: dns([
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ]),
      }),
    ).rejects.toThrow("CONFIG_ERROR");
  });
  it("[isolation] transport overrides are test-only and fixed to numeric loopback", async () => {
    const arbitrary = (async () => {
      throw new Error("must never execute");
    }) as HttpTransport;
    expect(
      () =>
        new DeepSeekProvider({
          baseUrl: "https://api.deepseek.com",
          model: "synthetic",
          transport: arbitrary,
        }),
    ).toThrow("CONFIG_ERROR");
    for (const origin of [
      "http://localhost:1234",
      "https://127.0.0.1:1234",
      "http://127.0.0.1:1234/path",
      "http://127.0.0.2:1234",
    ])
      expect(() => createIsolatedHttpTransport(origin)).toThrow("CONFIG_ERROR");
    const transport = createIsolatedHttpTransport("http://127.0.0.1:1234");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => createIsolatedHttpTransport("http://127.0.0.1:1234")).toThrow("CONFIG_ERROR");
    expect(
      () =>
        new DeepSeekProvider({
          baseUrl: "https://api.deepseek.com",
          model: "synthetic",
          transport,
        }),
    ).toThrow("CONFIG_ERROR");
    await expect(
      validateProviderUrl("https://api.deepseek.com", { dnsLookup: publicDns }),
    ).rejects.toThrow("CONFIG_ERROR");
  });
  it("[isolation] serializes the actual request and pins the prepared endpoint once", async () => {
    const fixture = await startHttpFixture((_request, response) =>
      sendCompletion(response, { ok: true }),
    );
    try {
      let dnsCalls = 0;
      const lookup = (async () => {
        dnsCalls++;
        return dnsCalls === 1
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "127.0.0.1", family: 4 }];
      }) as unknown as typeof publicDns;
      const provider = new DeepSeekProvider({
        baseUrl: "https://api.deepseek.com/v1",
        model: "synthetic-model",
        transport: fixture.transport,
        dnsLookup: lookup,
      });
      const ctx = context();
      await provider.prepare(ctx);
      await expect(provider.complete(request, ctx)).resolves.toMatchObject({
        ok: true,
        usage: { inputTokens: 10, outputTokens: 10 },
        providerRequestId: "synthetic_request",
      });
      expect(dnsCalls).toBe(1);
      expect(fixture.requests).toHaveLength(1);
      const sent = fixture.requests[0];
      expect(sent.path).toBe("/v1/chat/completions");
      expect(sent.method).toBe("POST");
      expect(sent.headers.authorization === undefined).toBe(true);
      expect(JSON.parse(sent.body)).toMatchObject({
        model: "synthetic-model",
        max_tokens: 32,
        temperature: 0.25,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.userMessage },
          { role: "user", content: request.userData },
        ],
      });
    } finally {
      await fixture.close();
    }
  });
  it("[isolation] validates every redirect, rejects private targets and stops at two hops", async () => {
    let mode = "same",
      count = 0;
    const fixture = await startHttpFixture((row, response) => {
      count++;
      if (mode === "same" && row.path === "/v2") return sendCompletion(response, { ok: true });
      response.writeHead(307, { location: mode === "private" ? "https://127.0.0.1/v2" : "/v2" });
      response.end();
    });
    try {
      let dnsCalls = 0;
      const checkedDns = (async () => {
        dnsCalls++;
        return [{ address: "93.184.216.34", family: 4 }];
      }) as unknown as typeof publicDns;
      const provider = () =>
        new DeepSeekProvider({
          baseUrl: "https://api.deepseek.com",
          model: "synthetic",
          transport: fixture.transport,
          dnsLookup: checkedDns,
        });
      expect((await provider().complete(request, context())).ok).toBe(true);
      expect(dnsCalls).toBe(2);
      expect(count).toBe(2);
      mode = "private";
      count = 0;
      expect(await provider().complete(request, context())).toMatchObject({
        ok: false,
        errorCode: "CONFIG_ERROR",
        retryable: false,
      });
      expect(count).toBe(1);
      mode = "loop";
      count = 0;
      expect(await provider().complete(request, context())).toMatchObject({
        ok: false,
        retryable: false,
      });
      expect(count).toBe(3);
    } finally {
      await fixture.close();
    }
  });
  it("[isolation] redirect DNS changes cannot reach a private address", async () => {
    const fixture = await startHttpFixture((_row, response) => {
      response.writeHead(307, { location: "/next" });
      response.end();
    });
    let calls = 0;
    try {
      const provider = new DeepSeekProvider({
        baseUrl: "https://api.deepseek.com",
        model: "synthetic",
        transport: fixture.transport,
        dnsLookup: (async () => [
          { address: ++calls === 1 ? "93.184.216.34" : "10.0.0.2", family: 4 },
        ]) as unknown as typeof publicDns,
      });
      expect(await provider.complete(request, context())).toMatchObject({
        ok: false,
        errorCode: "CONFIG_ERROR",
      });
      expect(fixture.requests).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });
  it("[timeout-cancel-retry] parses split SSE frames, usage and DONE without exposing raw data", async () => {
    const fixture = await startHttpFixture(async (_row, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of [
        'data: {"id":"stream_1","choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"true}"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
        "data: [DONE]\n\n",
      ]) {
        response.write(chunk.slice(0, 8));
        await new Promise((resolve) => setTimeout(resolve, 2));
        response.write(chunk.slice(8));
      }
      response.end();
    });
    try {
      expect(
        await new DeepSeekProvider({
          baseUrl: "https://api.deepseek.com",
          model: "synthetic",
          ...fixture,
        }).complete(request, context()),
      ).toMatchObject({
        ok: true,
        output: '{"ok":true}',
        usage: { inputTokens: 7, outputTokens: 3 },
        receivedByte: true,
      });
    } finally {
      await fixture.close();
    }
  });
  it("[timeout-cancel-retry] HTTP errors retry only before body bytes and retain Retry-After", async () => {
    let status = 429,
      body = "";
    const fixture = await startHttpFixture((_row, response) => {
      response.writeHead(status, { "retry-after": "0.05" });
      response.end(body);
    });
    try {
      const provider = () =>
        new DeepSeekProvider({
          baseUrl: "https://api.deepseek.com",
          model: "synthetic",
          ...fixture,
        });
      for (status of [429, 500, 503])
        expect(await provider().complete(request, context())).toMatchObject({
          ok: false,
          retryable: true,
          receivedByte: false,
          retryAfterMs: 50,
        });
      body = "rejected";
      expect(await provider().complete(request, context())).toMatchObject({
        ok: false,
        retryable: false,
        receivedByte: true,
      });
      status = 400;
      body = "";
      expect(await provider().complete(request, context())).toMatchObject({
        ok: false,
        retryable: false,
      });
    } finally {
      await fixture.close();
    }
  });
  it("[isolation] malformed JSON, incomplete streams, partial socket loss and oversized bodies never retry", async () => {
    let mode = "json";
    const fixture = await startHttpFixture(async (_row, response) => {
      response.writeHead(200, {
        "content-type":
          mode === "sse" || mode === "changed-id" ? "text/event-stream" : "application/json",
      });
      if (mode === "changed-id") {
        response.end(
          'data: {"id":"first","choices":[{"delta":{"content":"{}"}}]}\n\ndata: {"id":"second","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
        );
        return;
      }
      response.write(
        mode === "sse" ? 'data: {"choices":[]}\n\n' : mode === "large" ? "x".repeat(128) : "{",
      );
      if (mode === "partial") {
        await new Promise((resolve) => setTimeout(resolve, 15));
        response.destroy();
      } else response.end();
    });
    try {
      for (mode of ["json", "sse", "partial", "large"])
        expect(
          await new DeepSeekProvider({
            baseUrl: "https://api.deepseek.com",
            model: "synthetic",
            ...fixture,
            maxResponseBytes: 64,
          }).complete(request, context()),
        ).toMatchObject({ ok: false, retryable: false, receivedByte: true });
      mode = "changed-id";
      expect(
        await new DeepSeekProvider({
          baseUrl: "https://api.deepseek.com",
          model: "synthetic",
          ...fixture,
        }).complete(request, context()),
      ).toMatchObject({ ok: false, internalCode: "INVALID_JSON", retryable: false });
    } finally {
      await fixture.close();
    }
  });
  it("[timeout-cancel-retry] pre-abort sends zero requests and cancellation interrupts a blocked body read", async () => {
    let closed = false;
    const fixture = await startHttpFixture((_row, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
      response.on("close", () => {
        closed = true;
      });
    });
    try {
      const provider = () =>
        new DeepSeekProvider({
          baseUrl: "https://api.deepseek.com",
          model: "synthetic",
          ...fixture,
        });
      const controller = new AbortController();
      controller.abort();
      expect(
        await provider().complete(request, {
          signal: controller.signal,
          deadlineAt: Date.now() + 1000,
        }),
      ).toMatchObject({ ok: false, errorCode: "CANCELLED", definitelyNotSent: true });
      expect(fixture.requests).toHaveLength(0);
      const active = new AbortController();
      const start = Date.now();
      const pending = provider().complete(request, {
        signal: active.signal,
        deadlineAt: start + 2000,
      });
      await fixture.waitForRequests(1);
      active.abort();
      expect(await pending).toMatchObject({ ok: false, errorCode: "CANCELLED", retryable: false });
      expect(Date.now() - start).toBeLessThan(1500);
      await vi.waitFor(() => expect(closed).toBe(true));
      expect(await provider().complete(request, context(100))).toMatchObject({
        ok: false,
        errorCode: "PROVIDER_TIMEOUT",
        retryable: false,
      });
    } finally {
      await fixture.close();
    }
  });
  it("[isolation] business SDK, network, direct adapter and secret imports stay inside declared boundaries", () => {
    expect(scanAiBoundary()).toEqual([]);
  });
});
