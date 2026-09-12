import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { parseApiKeyId } from "@/lib/admin-api-keys";
import type { ApiErrorCode } from "@/lib/api-response";
import { stableStringify } from "@/lib/json";
import { AuditLogError } from "@/server/audit-log";

export class KeyLifecycleError extends AuditLogError {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 503,
    readonly publicCode: ApiErrorCode,
    readonly details?: unknown,
  ) {
    super(publicCode === "VALIDATION_ERROR" ? "VALIDATION_ERROR" : "INTERNAL_ERROR");
    this.name = "KeyLifecycleError";
  }
}

export interface KeyReference {
  readonly adapterId: string;
  readonly referenceId: string;
  readonly revision: number;
  readonly configVersion: number;
  readonly contentHash: string;
}

/** Persisted exact tagged identifiers, never credentials, endpoints or arbitrary config JSON. */
export interface KeyReferenceCandidate {
  readonly adapterId: string;
  readonly referenceId: string;
  readonly candidateId: string;
  readonly configVersion: number;
  readonly referenceRevision: number;
  readonly contentHash: string;
}

export interface KeyConnectionTarget {
  readonly url: string;
  readonly keyId: string;
  readonly candidate: KeyReferenceCandidate;
}

/** Phase015 must register its real immutable-version/activation adapter here when its tables exist. */
export interface KeyReferenceAdapter {
  readonly id: string;
  listActiveReferences(
    tx: Prisma.TransactionClient,
    keyId: string,
  ): Promise<readonly KeyReference[]>;
  prepareCandidates(
    tx: Prisma.TransactionClient,
    references: readonly KeyReference[],
    newKeyId: string,
  ): Promise<readonly KeyReferenceCandidate[]>;
  connectionTarget(
    tx: Prisma.TransactionClient,
    candidate: KeyReferenceCandidate,
    newKeyId: string,
  ): Promise<KeyConnectionTarget>;
  activate(
    tx: Prisma.TransactionClient,
    reference: KeyReference,
    candidate: KeyReferenceCandidate,
    newKeyId: string,
  ): Promise<void>;
}

function integer(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647
  );
}
function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
export function parseReferenceCandidates(value: unknown): KeyReferenceCandidate[] {
  if (!Array.isArray(value) || value.length > 127) throw new KeyLifecycleError(503, "CONFIG_ERROR");
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new KeyLifecycleError(503, "CONFIG_ERROR");
    const row = item as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(",") !==
        "adapterId,candidateId,configVersion,contentHash,referenceId,referenceRevision" ||
      !integer(row.configVersion) ||
      !integer(row.referenceRevision) ||
      !hash(row.contentHash)
    )
      throw new KeyLifecycleError(503, "CONFIG_ERROR");
    const result = {
      adapterId: parseApiKeyId(row.adapterId),
      referenceId: parseApiKeyId(row.referenceId),
      candidateId: parseApiKeyId(row.candidateId),
      configVersion: row.configVersion,
      referenceRevision: row.referenceRevision,
      contentHash: row.contentHash,
    };
    const identity = `${result.adapterId}:${result.referenceId}`;
    if (seen.has(identity)) throw new KeyLifecycleError(503, "CONFIG_ERROR");
    seen.add(identity);
    return Object.freeze(result);
  });
}

export function referenceRevisionKey(
  reference: Pick<KeyReference, "adapterId" | "referenceId">,
): string {
  return `ref_${createHash("sha256").update(`${reference.adapterId}\0${reference.referenceId}`).digest("hex")}`;
}

export function referenceSetHash(references: readonly KeyReference[]): string {
  return createHash("sha256").update(stableStringify(references)).digest("hex");
}

export function createKeyReferenceRegistry(adapters: readonly KeyReferenceAdapter[] = []) {
  const byId = new Map<string, KeyReferenceAdapter>();
  for (const adapter of adapters) {
    const id = parseApiKeyId(adapter.id);
    if (byId.has(id)) throw new KeyLifecycleError(503, "CONFIG_ERROR");
    byId.set(id, adapter);
  }
  return Object.freeze({
    adapter(id: string) {
      const adapter = byId.get(id);
      if (!adapter) throw new KeyLifecycleError(503, "CONFIG_ERROR");
      return adapter;
    },
    async list(tx: Prisma.TransactionClient, keyId: string): Promise<KeyReference[]> {
      const all: KeyReference[] = [];
      for (const [id, adapter] of byId) {
        const rows = await adapter.listActiveReferences(tx, keyId);
        for (const row of rows) {
          if (
            Object.keys(row).sort().join(",") !==
              "adapterId,configVersion,contentHash,referenceId,revision" ||
            row.adapterId !== id ||
            !integer(row.revision) ||
            !integer(row.configVersion) ||
            !hash(row.contentHash)
          )
            throw new KeyLifecycleError(503, "CONFIG_ERROR");
          parseApiKeyId(row.referenceId);
          all.push(Object.freeze({ ...row }));
        }
      }
      all.sort((left, right) =>
        `${left.adapterId}:${left.referenceId}`.localeCompare(
          `${right.adapterId}:${right.referenceId}`,
          "en",
        ),
      );
      if (all.length > 127 || new Set(all.map(referenceRevisionKey)).size !== all.length)
        throw new KeyLifecycleError(503, "CONFIG_ERROR");
      return all;
    },
    async prepare(
      tx: Prisma.TransactionClient,
      references: readonly KeyReference[],
      newKeyId: string,
    ) {
      const result: KeyReferenceCandidate[] = [];
      for (const [id, adapter] of byId)
        result.push(
          ...(await adapter.prepareCandidates(
            tx,
            references.filter((row) => row.adapterId === id),
            newKeyId,
          )),
        );
      const parsed = parseReferenceCandidates(result);
      if (
        parsed.length !== references.length ||
        parsed.some(
          (candidate) =>
            !references.some(
              (ref) =>
                ref.adapterId === candidate.adapterId &&
                ref.referenceId === candidate.referenceId &&
                ref.revision === candidate.referenceRevision,
            ),
        )
      )
        throw new KeyLifecycleError(503, "CONFIG_ERROR");
      return parsed;
    },
  });
}
