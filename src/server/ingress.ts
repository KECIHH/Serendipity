import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

/** Node transport boundary. This module has no environment reads or browser imports. */
export class IngressError extends Error {
  constructor() {
    super("Trusted request transport is unavailable.");
    this.name = "IngressError";
  }
}

function invalid(): never {
  throw new IngressError();
}

function ipv6Integer(address: string): bigint {
  const [left, right] = address.split("::");
  const first = left ? left.split(":") : [];
  const last = right ? right.split(":") : [];
  const parts =
    right === undefined
      ? first
      : [...first, ...Array(8 - first.length - last.length).fill("0"), ...last];
  if (parts.length !== 8) invalid();
  return parts.reduce((value, part) => (value << BigInt(16)) | BigInt(`0x${part}`), BigInt(0));
}

export function canonicalIp(input: string): string {
  if (typeof input !== "string" || input.length > 64 || input.includes("%") || !isIP(input))
    invalid();
  if (isIP(input) === 4) return input;
  const canonical = new URL(`http://[${input}]/`).hostname.slice(1, -1);
  const numeric = ipv6Integer(canonical);
  if (numeric >> BigInt(32) === BigInt(0xffff)) {
    return [BigInt(24), BigInt(16), BigInt(8), BigInt(0)]
      .map((shift) => Number((numeric >> shift) & BigInt(255)))
      .join(".");
  }
  return canonical;
}

function ipInteger(input: string): { bits: number; value: bigint } {
  const address = canonicalIp(input);
  return isIP(address) === 4
    ? {
        bits: 32,
        value: address
          .split(".")
          .reduce((value, part) => (value << BigInt(8)) | BigInt(part), BigInt(0)),
      }
    : { bits: 128, value: ipv6Integer(address) };
}

function cidr(value: string) {
  const parts = value.split("/");
  if (parts.length !== 2 || !/^(0|[1-9][0-9]{0,2})$/.test(parts[1])) invalid();
  const address = ipInteger(parts[0]);
  let prefix = Number(parts[1]);
  if (isIP(parts[0]) === 6 && address.bits === 32) prefix -= 96;
  if (prefix < 0 || prefix > address.bits) invalid();
  const shift = BigInt(address.bits - prefix);
  if ((address.value >> shift) << shift !== address.value) invalid();
  return { ...address, prefix, shift };
}

export function parseTrustedProxyCidrs(value: string): readonly string[] {
  if (typeof value !== "string" || value.length > 2_048) invalid();
  if (value === "") return Object.freeze([]);
  const entries = value.split(",").map((item) => item.trim());
  if (entries.length > 32 || new Set(entries).size !== entries.length) invalid();
  for (const entry of entries) cidr(entry);
  return Object.freeze(entries);
}

function matchesCidr(address: string, network: string): boolean {
  const actual = ipInteger(address),
    expected = cidr(network);
  return (
    actual.bits === expected.bits &&
    actual.value >> expected.shift === expected.value >> expected.shift
  );
}

type RequestHeaders = Headers | Readonly<Record<string, string | string[] | undefined>>;

function readHeader(headers: RequestHeaders, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const values = Object.entries(headers)
    .filter(([key]) => key.toLowerCase() === name)
    .map(([, value]) => value);
  if (values.length > 1 || Array.isArray(values[0])) invalid();
  return values[0] ?? null;
}

function forwardedAddress(value: string): string {
  let token = value.trim();
  if (token.startsWith('"') && token.endsWith('"')) token = token.slice(1, -1);
  if (token.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::([0-9]{1,5}))?$/.exec(token);
    if (!match || (match[2] && Number(match[2]) > 65535)) invalid();
    return canonicalIp(match[1]);
  }
  // Forwarded IPv4 may contain a port; unbracketed IPv6 stays an IP, never a host name.
  if (isIP(token)) return canonicalIp(token);
  const match = /^([0-9.]+):([0-9]{1,5})$/.exec(token);
  if (!match || Number(match[2]) > 65535) invalid();
  return canonicalIp(match[1]);
}

function forwardingChain(headers: RequestHeaders): string[] {
  const forwarded = readHeader(headers, "forwarded");
  const xff = readHeader(headers, "x-forwarded-for");
  if (forwarded !== null && xff !== null) invalid();
  const raw = forwarded ?? xff;
  if (raw === null) return [];
  if (raw.length === 0 || raw.length > 2_048) invalid();
  const elements = raw.split(",");
  if (elements.length > 16) invalid();
  return elements.map((element) => {
    if (forwarded === null) return canonicalIp(element.trim());
    const parameters = element.split(";").map((part) => part.trim());
    const forValues = parameters.filter((part) => /^for=/i.test(part));
    if (forValues.length !== 1) invalid();
    return forwardedAddress(forValues[0].slice(4));
  });
}

/** Untrusted peers never get to select a bucket through forwarding headers. */
export function resolveClientAddress(input: {
  directAddress: string;
  headers: RequestHeaders;
  trustedProxyCidrs?: readonly string[];
}): string {
  const direct = canonicalIp(input.directAddress);
  const networks = input.trustedProxyCidrs ?? [];
  for (const network of networks) cidr(network);
  const trusted = (address: string) => networks.some((network) => matchesCidr(address, network));
  if (!trusted(direct)) return direct;
  const chain = forwardingChain(input.headers);
  if (chain.length === 0) invalid();
  let current = direct;
  for (let index = chain.length - 1; index >= 0 && trusted(current); index--)
    current = chain[index];
  return current;
}

const proofHeader = "x-serendipity-transport";
const proofDomain = "serendipity:auth:transport:v1\0";
const proofLifetimeMs = 30_000;
interface TransportScope {
  proof: string;
  consumed: boolean;
}
const transportScopeKey = Symbol.for("serendipity.auth.transport-scope.v1");
const transportGlobal = globalThis as typeof globalThis & {
  [transportScopeKey]?: AsyncLocalStorage<TransportScope>;
};
// Next bundles server modules separately from the Node entry; both share this process-local context.
const transportScope = (transportGlobal[transportScopeKey] ??=
  new AsyncLocalStorage<TransportScope>());

/** The Node handler establishes a fresh context for this specific stamped request only. */
export function runWithTrustedRequest<Value>(
  request: IncomingMessage,
  operation: () => Value,
): Value {
  const proof = request.headers[proofHeader];
  if (typeof proof !== "string") invalid();
  return transportScope.run({ proof, consumed: false }, operation);
}

function proofSignature(payload: string, secret: string): string {
  if (typeof secret !== "string" || secret.length < 32) invalid();
  return createHmac("sha256", secret).update(proofDomain).update(payload).digest("base64url");
}

/** Overwrite every caller-supplied proof before handing the request to Next.js. */
export function stampTrustedRequest(
  request: IncomingMessage,
  options: { secret: string; trustedProxyCidrs: readonly string[] },
): void {
  for (const name of Object.keys(request.headers))
    if (name.startsWith("x-serendipity-")) delete request.headers[name];
  const address = resolveClientAddress({
    directAddress: request.socket.remoteAddress ?? invalid(),
    headers: request.headers,
    trustedProxyCidrs: options.trustedProxyCidrs,
  });
  const target = request.url ?? "/";
  if (!target.startsWith("/") || target.startsWith("//") || target.length > 8_192) invalid();
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      address,
      method: request.method,
      target,
      issuedAt: Date.now(),
      nonce: randomUUID(),
    }),
  ).toString("base64url");
  request.headers[proofHeader] = `${payload}.${proofSignature(payload, options.secret)}`;
  // These headers cannot influence Next/Auth.js URL construction downstream.
  delete request.headers.forwarded;
  delete request.headers["x-forwarded-for"];
  delete request.headers["x-forwarded-host"];
  delete request.headers["x-forwarded-proto"];
  delete request.headers["x-forwarded-port"];
}

export function verifyTrustedRequest(request: Request, secret: string): string {
  const value = request.headers.get(proofHeader);
  const scope = transportScope.getStore();
  if (!scope || scope.consumed || scope.proof !== value) invalid();
  if (!value || value.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value))
    invalid();
  const [payload, signature] = value.split(".");
  const expected = Buffer.from(proofSignature(payload, secret));
  const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) invalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    invalid();
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) invalid();
  const proof = decoded as Record<string, unknown>;
  const url = new URL(request.url);
  if (
    Object.keys(proof).sort().join(",") !== "address,issuedAt,method,nonce,target,v" ||
    proof.v !== 1 ||
    proof.method !== request.method ||
    proof.target !== url.pathname + url.search ||
    typeof proof.issuedAt !== "number" ||
    !Number.isSafeInteger(proof.issuedAt) ||
    Math.abs(Date.now() - proof.issuedAt) > proofLifetimeMs ||
    typeof proof.nonce !== "string" ||
    !/^[0-9a-f-]{36}$/.test(proof.nonce) ||
    typeof proof.address !== "string"
  )
    invalid();
  const address = canonicalIp(proof.address);
  scope.consumed = true;
  return address;
}
