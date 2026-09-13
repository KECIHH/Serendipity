import "server-only";
import { lookup } from "node:dns/promises";
import { isPublicKeyClientAddress } from "@/server/admin/key-candidate-client";

export interface UrlGuardOptions {
  readonly allowlistedHosts?: readonly string[];
  readonly allowedPorts?: readonly number[];
  readonly dnsLookup?: typeof lookup;
}
export interface ResolvedEndpoint {
  readonly url: URL;
  readonly address: string;
  readonly family: number;
}
export function validateProviderUrlShape(value: string, options: UrlGuardOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CONFIG_ERROR");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(options.allowlistedHosts ?? ["api.deepseek.com"]).includes(url.hostname) ||
    !(options.allowedPorts ?? [443]).includes(url.port ? Number(url.port) : 443)
  )
    throw new Error("CONFIG_ERROR");
  return url;
}
export async function resolveProviderEndpoint(
  value: string,
  options: UrlGuardOptions = {},
  signal?: AbortSignal,
): Promise<ResolvedEndpoint> {
  const url = validateProviderUrlShape(value, options);
  if (signal?.aborted) throw new Error("CANCELLED");
  if (options.dnsLookup && process.env.NODE_ENV !== "test") throw new Error("CONFIG_ERROR");
  const records = await new Promise<Array<{ address: string; family: number }>>(
    (resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new Error("CANCELLED"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        reject(new Error("CONFIG_ERROR"));
      }, 5000);
      signal?.addEventListener("abort", abort, { once: true });
      void (options.dnsLookup ?? lookup)(url.hostname, { all: true, verbatim: true }).then(
        (rows) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve(rows);
        },
        () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(new Error("CONFIG_ERROR"));
        },
      );
    },
  );
  if (signal?.aborted) throw new Error("CANCELLED");
  if (!records.length || records.some((record) => !isPublicKeyClientAddress(record.address)))
    throw new Error("CONFIG_ERROR");
  return { url, ...records[0] };
}
export async function validateProviderUrl(
  value: string,
  options: UrlGuardOptions = {},
): Promise<URL> {
  return (await resolveProviderEndpoint(value, options)).url;
}
