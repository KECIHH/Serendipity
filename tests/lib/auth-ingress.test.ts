// @vitest-environment node
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalIp,
  IngressError,
  parseTrustedProxyCidrs,
  resolveClientAddress,
  stampTrustedRequest,
  runWithTrustedRequest,
  verifyTrustedRequest,
} from "@/server/ingress";

describe("auth trusted transport", () => {
  it("canonicalizes IPv6 and mapped IPv4 without hostnames or zone identifiers", () => {
    expect(canonicalIp("2001:0DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
    expect(canonicalIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(canonicalIp("::ffff:c000:201")).toBe("192.0.2.1");
    for (const address of [
      "localhost",
      "127.1",
      "010.0.0.1",
      "fe80::1%eth0",
      "192.0.2.1,192.0.2.2",
    ])
      expect(() => canonicalIp(address)).toThrow(IngressError);
  });

  it("ignores even malformed forwarding headers from an untrusted direct peer", () => {
    for (const headers of [
      new Headers({ "x-forwarded-for": "203.0.113.1" }),
      new Headers({ forwarded: "for=unknown", "x-forwarded-for": "attacker.invalid" }),
      new Headers({ "x-forwarded-for": "x".repeat(4_000) }),
    ]) {
      expect(resolveClientAddress({ directAddress: "192.0.2.10", headers })).toBe("192.0.2.10");
      expect(
        resolveClientAddress({
          directAddress: "192.0.2.10",
          headers,
          trustedProxyCidrs: ["10.0.0.0/8"],
        }),
      ).toBe("192.0.2.10");
    }
  });

  it("walks trusted proxy chains from the socket toward the first untrusted hop", () => {
    const trustedProxyCidrs = parseTrustedProxyCidrs("10.0.0.0/8,2001:db8:1::/48");
    expect(
      resolveClientAddress({
        directAddress: "10.0.0.5",
        trustedProxyCidrs,
        headers: new Headers({ "x-forwarded-for": "192.0.2.99, 203.0.113.9, 10.0.0.4" }),
      }),
    ).toBe("203.0.113.9");
    expect(
      resolveClientAddress({
        directAddress: "2001:db8:1::5",
        trustedProxyCidrs,
        headers: new Headers({
          forwarded: 'for="[2001:db8:2::9]:443";proto=https, for="[2001:db8:1::4]"',
        }),
      }),
    ).toBe("2001:db8:2::9");
    for (const headers of [
      new Headers(),
      new Headers({ forwarded: "for=unknown" }),
      new Headers({ forwarded: "for=203.0.113.1;for=203.0.113.2" }),
      new Headers({ "x-forwarded-for": "203.0.113.1", forwarded: "for=203.0.113.1" }),
      new Headers({ "x-forwarded-for": Array(17).fill("203.0.113.1").join(",") }),
    ])
      expect(() =>
        resolveClientAddress({ directAddress: "10.0.0.5", trustedProxyCidrs, headers }),
      ).toThrow(IngressError);
    for (const value of [
      "bad/24",
      "10.0.0.1/8",
      "10.0.0.0/33",
      "10.0.0.0/8,",
      "10.0.0.0/8,10.0.0.0/8",
    ])
      expect(() => parseTrustedProxyCidrs(value)).toThrow(IngressError);
  });

  it("uses a real socket and rejects missing, altered, wrong-key, wrong-path and wrong-method proofs", async () => {
    const secret = randomBytes(32).toString("hex");
    let incoming: IncomingMessage | undefined;
    const server = createServer((request, response) => {
      incoming = request;
      stampTrustedRequest(request, { secret, trustedProxyCidrs: [] });
      const proof = request.headers["x-serendipity-transport"] as string;
      // The test-only server returns a synthetic proof; the application never reflects this header.
      response.end(proof);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test listener");
    const url = `http://127.0.0.1:${address.port}/api/auth/callback/credentials`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "x-serendipity-transport": "forged", "x-forwarded-for": "203.0.113.88" },
      });
      const proof = await response.text();
      const request = new Request(url, {
        method: "POST",
        headers: { "x-serendipity-transport": proof },
      });
      expect(() => verifyTrustedRequest(request, secret)).toThrow(IngressError);
      runWithTrustedRequest(incoming!, () => {
        expect(verifyTrustedRequest(request, secret)).toBe("127.0.0.1");
        expect(() => verifyTrustedRequest(request, secret)).toThrow(IngressError);
      });
      expect(incoming?.headers["x-forwarded-for"]).toBeUndefined();
      expect(() => verifyTrustedRequest(new Request(url), secret)).toThrow(IngressError);
      runWithTrustedRequest(incoming!, () => {
        expect(() => verifyTrustedRequest(request, randomBytes(32).toString("hex"))).toThrow(
          IngressError,
        );
        expect(() =>
          verifyTrustedRequest(
            new Request(`${url}?replayed=1`, { method: "POST", headers: request.headers }),
            secret,
          ),
        ).toThrow(IngressError);
        expect(() =>
          verifyTrustedRequest(
            new Request(url, { method: "GET", headers: request.headers }),
            secret,
          ),
        ).toThrow(IngressError);
        expect(() =>
          verifyTrustedRequest(
            new Request(url, {
              method: "POST",
              headers: { "x-serendipity-transport": `${proof.slice(0, -1)}!` },
            }),
            secret,
          ),
        ).toThrow(IngressError);
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps concurrent asynchronous request proofs isolated and single-use", async () => {
    const secret = randomBytes(32).toString("hex");
    const incoming: IncomingMessage[] = [];
    const server = createServer((request, response) => {
      stampTrustedRequest(request, { secret, trustedProxyCidrs: [] });
      incoming.push(request);
      response.end("ready");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test listener");
    const url = `http://127.0.0.1:${address.port}/api/auth/callback/credentials`;
    try {
      await Promise.all([fetch(url, { method: "POST" }), fetch(url, { method: "POST" })]);
      expect(incoming).toHaveLength(2);
      const requests = incoming.map(
        (request) =>
          new Request(url, {
            method: "POST",
            headers: {
              "x-serendipity-transport": request.headers["x-serendipity-transport"] as string,
            },
          }),
      );
      let entered = 0;
      let release!: () => void;
      const bothEntered = new Promise<void>((resolve) => {
        release = resolve;
      });
      await Promise.all(
        incoming.map((request, index) =>
          runWithTrustedRequest(request, async () => {
            entered += 1;
            if (entered === 2) release();
            await bothEntered;
            expect(() => verifyTrustedRequest(requests[1 - index], secret)).toThrow(IngressError);
            expect(verifyTrustedRequest(requests[index], secret)).toBe("127.0.0.1");
            await Promise.resolve();
            expect(() => verifyTrustedRequest(requests[index], secret)).toThrow(IngressError);
          }),
        ),
      );
      for (const request of requests)
        expect(() => verifyTrustedRequest(request, secret)).toThrow(IngressError);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
