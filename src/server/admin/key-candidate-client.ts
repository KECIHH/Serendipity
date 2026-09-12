import "server-only";

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { PrismaClient } from "@prisma/client";
import { stableStringify } from "@/lib/json";
import { parseApiKeyId } from "@/lib/admin-api-keys";
import { decryptSecret, type KeyResolver } from "@/server/security/secret-envelope";
import {
  KeyLifecycleError,
  type KeyConnectionTarget,
  type KeyReferenceAdapter,
} from "@/server/admin/key-reference";

export interface KeyCandidateClientOptions {
  readonly mode?: "ISOLATED_SYNTHETIC" | "LIVE";
  readonly inventory?: readonly { origin: string; pathPrefix: string }[];
  readonly timeoutMs?: number;
}

export interface KeyCandidateClient {
  verify(target: KeyConnectionTarget, plainKey: string): Promise<string>;
}

function ipv4Bits(address: string): bigint {
  return address
    .split(".")
    .reduce((result, part) => (result << BigInt(8)) | BigInt(Number(part)), BigInt(0));
}

function ipv6Bits(address: string): bigint {
  let normalized = address;
  if (normalized.includes(".")) {
    const separator = normalized.lastIndexOf(":"),
      value = ipv4Bits(normalized.slice(separator + 1));
    normalized = `${normalized.slice(0, separator)}:${(value >> BigInt(16)).toString(16)}:${(value & BigInt(65535)).toString(16)}`;
  }
  const [left, right] = normalized.split("::");
  const first = left ? left.split(":") : [],
    last = right ? right.split(":") : [];
  const groups =
    right === undefined
      ? first
      : [...first, ...Array<string>(8 - first.length - last.length).fill("0"), ...last];
  return groups.reduce((result, part) => (result << BigInt(16)) | BigInt(`0x${part}`), BigInt(0));
}

function cidr(value: bigint, network: bigint, prefix: number, bits: number): boolean {
  const shift = BigInt(bits - prefix);
  return value >> shift === network >> shift;
}

/** Byte-level CIDRs reject compressed/zero-padded and embedded-address bypasses. */
export function isPublicKeyClientAddress(address: string): boolean {
  if (typeof address !== "string" || address.includes("%")) return false;
  if (isIP(address) === 4) {
    const value = ipv4Bits(address);
    const denied: ReadonlyArray<readonly [string, number]> = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ];
    return !denied.some(([network, prefix]) => cidr(value, ipv4Bits(network), prefix, 32));
  }
  if (isIP(address) !== 6) return false;
  const value = ipv6Bits(address);
  if (!cidr(value, ipv6Bits("2000::"), 3, 128)) return false;
  // Conservatively deny the entire IETF protocol allocation, including its few globally routed
  // special services. This bounded policy is not represented as a complete IANA registry.
  const denied: ReadonlyArray<readonly [string, number]> = [
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3ffe::", 16],
    ["3fff::", 20],
  ];
  return !denied.some(([network, prefix]) => cidr(value, ipv6Bits(network), prefix, 128));
}
function peerAddress(address: string | undefined): string {
  if (!address) return "";
  if (isIP(address) === 4) return `v4:${ipv4Bits(address).toString(16)}`;
  if (isIP(address) !== 6 || address.includes("%")) return "";
  const value = ipv6Bits(address);
  if (value >> BigInt(32) === BigInt(65535))
    return `v4:${(value & BigInt("0xffffffff")).toString(16)}`;
  return `v6:${value.toString(16)}`;
}

async function boundedLookup(hostname: string, timeoutMs: number) {
  return new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new KeyLifecycleError(503, "PROVIDER_TIMEOUT")),
      timeoutMs,
    );
    void lookup(hostname, { all: true, verbatim: true }).then(
      (addresses) => {
        clearTimeout(timer);
        resolve(addresses);
      },
      () => {
        clearTimeout(timer);
        reject(new KeyLifecycleError(503, "CONFIG_ERROR"));
      },
    );
  });
}

/** One bounded, inventory-bound transport. Redirects, proxy inheritance and raw responses are excluded. */
export function createKeyCandidateClient(
  options: KeyCandidateClientOptions = {},
): KeyCandidateClient {
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 5_000)
    throw new KeyLifecycleError(503, "CONFIG_ERROR");
  const inventory = (options.inventory ?? []).map((entry) => {
    const url = new URL(entry.origin);
    if (
      url.origin !== entry.origin ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !/^\/[A-Za-z0-9_-]+\/$/.test(entry.pathPrefix)
    )
      throw new KeyLifecycleError(503, "CONFIG_ERROR");
    return Object.freeze({ ...entry });
  });
  return Object.freeze({
    async verify(target: KeyConnectionTarget, plainKey: string): Promise<string> {
      try {
        parseApiKeyId(target.keyId);
        const url = new URL(target.url);
        const bound = inventory.find(
          (entry) =>
            url.origin === entry.origin &&
            url.pathname.startsWith(entry.pathPrefix) &&
            /^[A-Za-z0-9_-]{1,128}$/.test(url.pathname.slice(entry.pathPrefix.length)),
        );
        if (
          !bound ||
          target.url !== url.href ||
          url.username ||
          url.password ||
          url.hash ||
          url.search ||
          !plainKey ||
          plainKey.length > 16_384 ||
          /[^\x21-\x7e]/.test(plainKey)
        )
          throw new KeyLifecycleError(503, "CONFIG_ERROR");
        const loopback =
          url.protocol === "http:" &&
          url.hostname === "127.0.0.1" &&
          options.mode === "ISOLATED_SYNTHETIC" &&
          Boolean(url.port);
        if (!loopback && (url.protocol !== "https:" || (url.port && url.port !== "443")))
          throw new KeyLifecycleError(503, "CONFIG_ERROR");
        const started = Date.now();
        const addresses = loopback
          ? [{ address: "127.0.0.1", family: 4 }]
          : await boundedLookup(url.hostname, timeoutMs);
        if (
          addresses.length === 0 ||
          (!loopback && addresses.some(({ address }) => !isPublicKeyClientAddress(address)))
        )
          throw new KeyLifecycleError(503, "CONFIG_ERROR");
        const pinned = addresses[0];
        const result = await new Promise<unknown>((resolve, reject) => {
          let settled = false;
          const fail = (code: "CONFIG_ERROR" | "PROVIDER_TIMEOUT" | "PROVIDER_UNAVAILABLE") => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            request.destroy();
            reject(new KeyLifecycleError(503, code));
          };
          const transport = url.protocol === "https:" ? https : http;
          const request = transport.request(
            url,
            {
              method: "GET",
              agent: false,
              family: pinned.family,
              lookup: (_hostname, _options, callback) =>
                callback(null, pinned.address, pinned.family),
              headers: {
                authorization: `Bearer ${plainKey}`,
                accept: "application/json",
                "accept-encoding": "identity",
                "x-candidate-version": String(target.candidate.configVersion),
                "x-candidate-hash": target.candidate.contentHash,
              },
            },
            (response) => {
              if (
                peerAddress(response.socket.remoteAddress) !== peerAddress(pinned.address) ||
                response.statusCode !== 200 ||
                response.headers["content-type"]?.split(";", 1)[0].trim() !== "application/json" ||
                (response.headers["content-encoding"] !== undefined &&
                  response.headers["content-encoding"] !== "identity") ||
                (response.headers["content-length"] !== undefined &&
                  (!/^[0-9]+$/.test(response.headers["content-length"]) ||
                    Number(response.headers["content-length"]) > 8_192))
              ) {
                response.resume();
                fail(response.statusCode !== 200 ? "PROVIDER_UNAVAILABLE" : "CONFIG_ERROR");
                return;
              }
              const chunks: Buffer[] = [];
              let bytes = 0;
              response.on("data", (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > 8_192) {
                  fail("CONFIG_ERROR");
                  return;
                }
                chunks.push(chunk);
              });
              response.on("error", () => fail("PROVIDER_UNAVAILABLE"));
              response.on("end", () => {
                if (settled) return;
                try {
                  const parsed: unknown = JSON.parse(
                    new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)),
                  );
                  settled = true;
                  clearTimeout(timer);
                  resolve(parsed);
                } catch {
                  fail("CONFIG_ERROR");
                }
              });
            },
          );
          const timer = setTimeout(
            () => fail("PROVIDER_TIMEOUT"),
            Math.max(1, timeoutMs - (Date.now() - started)),
          );
          request.on("socket", (socket) =>
            socket.once("connect", () => {
              if (peerAddress(socket.remoteAddress) !== peerAddress(pinned.address))
                fail("CONFIG_ERROR");
            }),
          );
          request.on("error", () => fail("PROVIDER_UNAVAILABLE"));
          request.end();
        });
        if (!result || typeof result !== "object" || Array.isArray(result))
          throw new KeyLifecycleError(503, "CONFIG_ERROR");
        const row = result as Record<string, unknown>;
        if (
          Object.keys(row).sort().join(",") !== "candidateId,configVersion,contentHash,ok" ||
          row.ok !== true ||
          row.candidateId !== target.candidate.candidateId ||
          row.configVersion !== target.candidate.configVersion ||
          row.contentHash !== target.candidate.contentHash
        )
          throw new KeyLifecycleError(503, "CONFIG_ERROR");
        return createHash("sha256").update(stableStringify(target.candidate)).digest("hex");
      } catch (error) {
        if (error instanceof KeyLifecycleError) throw error;
        throw new KeyLifecycleError(503, "CONFIG_ERROR");
      }
    },
  });
}

/** Normal callers re-read ACTIVE for every new call; no previously decrypted credential is cached. */
export async function verifyActiveKeyConnection(
  db: PrismaClient,
  keyId: string,
  target: KeyConnectionTarget,
  client: KeyCandidateClient,
  resolver: KeyResolver,
  adapter: KeyReferenceAdapter,
): Promise<string> {
  try {
    parseApiKeyId(keyId);
    if (target.keyId !== keyId || target.candidate.adapterId !== adapter.id)
      throw new KeyLifecycleError(503, "CONFIG_ERROR");
    const bound = await adapter.connectionTarget(db, target.candidate, keyId);
    if (stableStringify(bound) !== stableStringify(target))
      throw new KeyLifecycleError(503, "CONFIG_ERROR");
    const row = await db.apiKeyConfig.findUnique({
      where: { id: keyId },
      select: {
        id: true,
        provider: true,
        status: true,
        encryptedKey: true,
        encryptionKeyId: true,
        envelopeVersion: true,
        newRotationRuns: { where: { stage: { not: "ACTIVATED" } }, select: { id: true }, take: 1 },
      },
    });
    if (!row || row.status !== "ACTIVE" || row.newRotationRuns.length !== 0)
      throw new KeyLifecycleError(503, "CONFIG_ERROR");
    return await client.verify(target, decryptSecret(row, resolver));
  } catch (error) {
    if (error instanceof KeyLifecycleError) throw error;
    throw new KeyLifecycleError(503, "CONFIG_ERROR");
  }
}
