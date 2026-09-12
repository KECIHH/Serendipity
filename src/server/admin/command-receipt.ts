import "server-only";

import { parseSettingPatch, type SettingPatch } from "@/lib/admin-settings";

import { createHash } from "node:crypto";
import { Prisma, type AdminCommandReceipt } from "@prisma/client";
import {
  AdminUserInputError,
  parseAdminUserId,
  parseAdminUserPatch,
  type AdminUserDto,
  type AdminUserPatch,
} from "@/lib/admin-users";
import { stableStringify } from "@/lib/json";
import { AuditLogError } from "@/server/audit-log";
import { readAuthClock } from "@/server/auth/clock";
import {
  parseApiKeyDto,
  parseApiKeyId,
  parseApiKeyPatch,
  parseKeyRotationReceipt,
  type ApiKeyDto,
  type ApiKeyPatch,
  type KeyRotationReceipt,
} from "@/lib/admin-api-keys";
import { parseReferenceCandidates, type KeyReferenceCandidate } from "@/server/admin/key-reference";

export const ADMIN_RECEIPT_MIN_RETENTION_MS = 86_400_000;
export const ADMIN_USER_OPERATION = "patch.admin.users.id";

export class AdminCommandError extends AuditLogError {
  constructor(
    readonly kind: "VALIDATION_ERROR" | "IDEMPOTENCY_KEY_REUSED" | "CLAIM_LOST" | "INVALID_STATE",
  ) {
    super(kind === "VALIDATION_ERROR" ? "VALIDATION_ERROR" : "INTERNAL_ERROR");
    this.name = "AdminCommandError";
  }
}

export interface AdminCommandIdentity {
  readonly ownerUserId: string;
  readonly operationId: string;
  readonly resourceId: string;
  readonly idempotencyKeyHash: string;
  readonly requestHash: string;
}

interface FingerprintPayload {
  expectedVersion: number;
  keyFingerprint: string;
}

export type AdminKeyCommandPayload =
  | ApiKeyPatch
  | {
      name: string;
      provider: string;
      keyFingerprint: string;
      expectedVersion?: number;
    };

function keyPayload(value: unknown, rotating: boolean) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AdminCommandError("VALIDATION_ERROR");
  const row = value as Record<string, unknown>;
  const fields = rotating
    ? ["expectedVersion", "keyFingerprint", "name", "provider"]
    : ["keyFingerprint", "name", "provider"];
  if (
    Object.keys(row).sort().join(",") !== fields.sort().join(",") ||
    typeof row.name !== "string" ||
    row.name.trim() !== row.name ||
    [...row.name].length < 1 ||
    [...row.name].length > 200 ||
    !row.name.isWellFormed() ||
    /[\u0000-\u001f\u007f]/u.test(row.name) ||
    typeof row.keyFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.keyFingerprint)
  )
    throw new AdminCommandError("VALIDATION_ERROR");
  const normalized = {
    name: row.name,
    provider: parseApiKeyId(row.provider),
    keyFingerprint: row.keyFingerprint,
  };
  if (!rotating) return normalized;
  return {
    ...normalized,
    expectedVersion: fingerprintPayload({
      expectedVersion: row.expectedVersion,
      keyFingerprint: row.keyFingerprint,
    }).expectedVersion,
  };
}

function safeDomain(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    throw new AdminCommandError("VALIDATION_ERROR");
  }
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fingerprintPayload(value: unknown): FingerprintPayload {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AdminCommandError("VALIDATION_ERROR");
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).length !== 2 ||
    typeof fields.expectedVersion !== "number" ||
    !Number.isInteger(fields.expectedVersion) ||
    fields.expectedVersion < 0 ||
    fields.expectedVersion > 2_147_483_647 ||
    typeof fields.keyFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(fields.keyFingerprint)
  )
    throw new AdminCommandError("VALIDATION_ERROR");
  return { expectedVersion: fields.expectedVersion, keyFingerprint: fields.keyFingerprint };
}

/** The raw key and reason never enter a row; only hashes of validated non-secret payload fields do. */
export function makeAdminCommandIdentity(input: {
  ownerUserId: string;
  operationId: string;
  resourceId: string;
  idempotencyKey: string;
  payload: AdminUserPatch | FingerprintPayload | AdminKeyCommandPayload | SettingPatch;
}): AdminCommandIdentity {
  try {
    if (
      typeof input.idempotencyKey !== "string" ||
      !/^[A-Za-z0-9_.:-]{8,128}$/.test(input.idempotencyKey)
    ) {
      throw new AdminCommandError("VALIDATION_ERROR");
    }
    const operationId = safeDomain(input.operationId);
    const payload =
      operationId === "patch.admin.settings.key"
        ? parseSettingPatch(input.payload)
        : operationId === ADMIN_USER_OPERATION
          ? parseAdminUserPatch(input.payload)
          : operationId === "post.admin.api-keys"
            ? keyPayload(input.payload, false)
            : operationId === "post.admin.api-keys.id.rotate"
              ? keyPayload(input.payload, true)
              : operationId === "patch.admin.api-keys.id"
                ? parseApiKeyPatch(input.payload)
                : fingerprintPayload(input.payload);
    return Object.freeze({
      ownerUserId: parseAdminUserId(input.ownerUserId),
      operationId,
      resourceId: safeDomain(input.resourceId),
      idempotencyKeyHash: digest(input.idempotencyKey),
      requestHash: digest(stableStringify(payload)),
    });
  } catch (error) {
    if (error instanceof AdminCommandError) throw error;
    throw new AdminCommandError("VALIDATION_ERROR");
  }
}

function identityWhere(identity: AdminCommandIdentity) {
  return {
    ownerUserId_operationId_resourceId_idempotencyKeyHash: {
      ownerUserId: identity.ownerUserId,
      operationId: identity.operationId,
      resourceId: identity.resourceId,
      idempotencyKeyHash: identity.idempotencyKeyHash,
    },
  };
}

export async function findAdminCommandReceipt(
  tx: Prisma.TransactionClient,
  identity: AdminCommandIdentity,
): Promise<AdminCommandReceipt | null> {
  const receipt = await tx.adminCommandReceipt.findUnique({ where: identityWhere(identity) });
  if (receipt && receipt.requestHash !== identity.requestHash) {
    throw new AdminCommandError("IDEMPOTENCY_KEY_REUSED");
  }
  return receipt;
}

/** Call inside the same transaction as preparation. A thrown preparation rolls this row back too. */
export async function reserveAdminCommand(
  tx: Prisma.TransactionClient,
  identity: AdminCommandIdentity,
) {
  const previous = await findAdminCommandReceipt(tx, identity);
  if (previous) return previous;
  const now = await readAuthClock(tx);
  return tx.adminCommandReceipt.create({
    data: {
      ...identity,
      status: "PENDING",
      createdAt: now,
      availableAt: now,
      expiresAt: new Date(now.getTime() + ADMIN_RECEIPT_MIN_RETENTION_MS),
    },
  });
}

/** Synchronous user commands publish their immutable result atomically with their business effect. */
export async function writeSucceededUserReceipt(
  tx: Prisma.TransactionClient,
  identity: AdminCommandIdentity,
  response: AdminUserDto,
): Promise<void> {
  const now = await readAuthClock(tx);
  await tx.adminCommandReceipt.create({
    data: {
      ...identity,
      status: "SUCCEEDED",
      responseJson: { ...response },
      createdAt: now,
      availableAt: now,
      completedAt: now,
      expiresAt: new Date(now.getTime() + ADMIN_RECEIPT_MIN_RETENTION_MS),
    },
    select: { id: true },
  });
}

/** Even a retained response crosses the exact DTO boundary before it can be replayed. */
export function readSucceededUserReceipt(receipt: AdminCommandReceipt): AdminUserDto {
  if (
    receipt.status !== "SUCCEEDED" ||
    !receipt.responseJson ||
    Array.isArray(receipt.responseJson) ||
    typeof receipt.responseJson !== "object"
  ) {
    throw new AdminCommandError("INVALID_STATE");
  }
  const row = receipt.responseJson as Record<string, unknown>;
  const fields = [
    "id",
    "email",
    "name",
    "avatarUrl",
    "role",
    "status",
    "lastLoginAt",
    "createdAt",
    "revision",
  ];
  const validInstant = (value: unknown) => {
    if (typeof value !== "string" || value.length !== 24) return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  };
  if (
    Object.keys(row).length !== fields.length ||
    Object.keys(row).some((key) => !fields.includes(key)) ||
    typeof row.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(row.id) ||
    typeof row.email !== "string" ||
    row.email.length > 254 ||
    (row.name !== null && typeof row.name !== "string") ||
    (row.avatarUrl !== null && typeof row.avatarUrl !== "string") ||
    (row.role !== "USER" && row.role !== "ADMIN") ||
    (row.status !== "ACTIVE" && row.status !== "DISABLED") ||
    (row.lastLoginAt !== null && !validInstant(row.lastLoginAt)) ||
    !validInstant(row.createdAt) ||
    typeof row.revision !== "number" ||
    !Number.isInteger(row.revision) ||
    row.revision < 0
  )
    throw new AdminCommandError("INVALID_STATE");
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl,
    role: row.role,
    status: row.status,
    lastLoginAt: row.lastLoginAt as string | null,
    createdAt: row.createdAt as string,
    revision: row.revision,
  };
}

export interface AdminCommandClaim {
  readonly receiptId: string;
  readonly leaseOwner: string;
  readonly fencingToken: number;
  readonly leaseUntil: Date;
}

export async function claimAdminCommand(
  tx: Prisma.TransactionClient,
  input: { receiptId: string; leaseOwner: string; leaseMs: number },
): Promise<AdminCommandClaim | null> {
  const receiptId = parseAdminUserId(input.receiptId),
    leaseOwner = parseAdminUserId(input.leaseOwner);
  if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1_000 || input.leaseMs > 60_000) {
    throw new AdminCommandError("VALIDATION_ERROR");
  }
  await tx.$queryRaw`SELECT id FROM "AdminCommandReceipt" WHERE id = ${receiptId} FOR UPDATE`;
  const receipt = await tx.adminCommandReceipt.findUnique({ where: { id: receiptId } });
  const now = await readAuthClock(tx);
  if (
    !receipt ||
    receipt.status === "SUCCEEDED" ||
    receipt.status === "FAILED" ||
    receipt.availableAt > now ||
    (receipt.status === "RUNNING" && receipt.leaseUntil !== null && receipt.leaseUntil > now)
  )
    return null;
  const leaseUntil = new Date(now.getTime() + input.leaseMs);
  const row = await tx.adminCommandReceipt.update({
    where: { id: receiptId, fencingToken: receipt.fencingToken },
    data: {
      status: "RUNNING",
      leaseOwner,
      leaseUntil,
      fencingToken: { increment: 1 },
      attemptCount: { increment: 1 },
    },
    select: { fencingToken: true },
  });
  return Object.freeze({ receiptId, leaseOwner, fencingToken: row.fencingToken, leaseUntil });
}

export async function assertAdminCommandClaim(
  tx: Prisma.TransactionClient,
  claim: AdminCommandClaim,
) {
  parseAdminUserId(claim.receiptId);
  parseAdminUserId(claim.leaseOwner);
  if (
    !Number.isSafeInteger(claim.fencingToken) ||
    claim.fencingToken < 1 ||
    !(claim.leaseUntil instanceof Date)
  ) {
    throw new AdminCommandError("CLAIM_LOST");
  }
  await tx.$queryRaw`SELECT id FROM "AdminCommandReceipt" WHERE id = ${claim.receiptId} FOR UPDATE`;
  const receipt = await tx.adminCommandReceipt.findUnique({ where: { id: claim.receiptId } });
  const now = await readAuthClock(tx);
  if (
    !receipt ||
    receipt.status !== "RUNNING" ||
    receipt.leaseOwner !== claim.leaseOwner ||
    receipt.fencingToken !== claim.fencingToken ||
    !receipt.leaseUntil ||
    receipt.leaseUntil <= now ||
    receipt.leaseUntil.getTime() !== claim.leaseUntil.getTime()
  )
    throw new AdminCommandError("CLAIM_LOST");
  await tx.$executeRaw`
    SELECT set_config('serendipity.admin_lease_owner', ${claim.leaseOwner}, true),
           set_config('serendipity.admin_fencing_token', ${String(claim.fencingToken)}, true)
  `;
  return { receipt, now };
}

function revisions(value: Record<string, number>, oldKeyId: string): Prisma.InputJsonObject {
  try {
    const entries = Object.entries(value);
    if (entries.length < 1 || entries.length > 128 || !Object.hasOwn(value, oldKeyId)) {
      throw new AdminCommandError("VALIDATION_ERROR");
    }
    for (const [id, revision] of entries) {
      parseAdminUserId(id);
      if (!Number.isInteger(revision) || revision < 0 || revision > 2_147_483_647) {
        throw new AdminCommandError("VALIDATION_ERROR");
      }
    }
    return Object.fromEntries(entries);
  } catch {
    throw new AdminCommandError("VALIDATION_ERROR");
  }
}

/** Persistence foundation only: callers supply existing key references; this never creates or switches keys. */
export async function prepareKeyRotationRun(
  tx: Prisma.TransactionClient,
  input: {
    claim: AdminCommandClaim;
    oldKeyId: string;
    newKeyId?: string | null;
    referenceSetHash: string;
    baseRevisionsJson: Record<string, number>;
    candidateIdsJson?: readonly KeyReferenceCandidate[];
  },
) {
  const { receipt, now } = await assertAdminCommandClaim(tx, input.claim);
  const oldKeyId = parseAdminUserId(input.oldKeyId);
  const newKeyId =
    input.newKeyId === undefined || input.newKeyId === null
      ? null
      : parseAdminUserId(input.newKeyId);
  const baseRevisionsJson = revisions(input.baseRevisionsJson, oldKeyId);
  const candidateIdsJson = parseReferenceCandidates(input.candidateIdsJson ?? []);
  if (
    receipt.resourceId !== oldKeyId ||
    newKeyId === oldKeyId ||
    !/^[a-f0-9]{64}$/.test(input.referenceSetHash)
  )
    throw new AdminCommandError("VALIDATION_ERROR");
  const previous = await tx.keyRotationRun.findUnique({ where: { receiptId: receipt.id } });
  if (previous) {
    if (
      previous.oldKeyId !== oldKeyId ||
      previous.newKeyId !== newKeyId ||
      previous.referenceSetHash !== input.referenceSetHash ||
      stableStringify(previous.candidateIdsJson) !== stableStringify(candidateIdsJson) ||
      stableStringify(previous.baseRevisionsJson) !== stableStringify(baseRevisionsJson)
    )
      throw new AdminCommandError("IDEMPOTENCY_KEY_REUSED");
    return previous;
  }
  const oldKey = await tx.apiKeyConfig.findUnique({
    where: { id: oldKeyId },
    select: { status: true, revision: true, provider: true },
  });
  const newKey =
    newKeyId === null
      ? null
      : await tx.apiKeyConfig.findUnique({
          where: { id: newKeyId },
          select: { status: true, provider: true },
        });
  if (
    !oldKey ||
    oldKey.status !== "ACTIVE" ||
    oldKey.revision !== baseRevisionsJson[oldKeyId] ||
    (newKeyId !== null &&
      (!newKey || newKey.status !== "DISABLED" || newKey.provider !== oldKey.provider))
  )
    throw new AdminCommandError("INVALID_STATE");
  return tx.keyRotationRun.create({
    data: {
      receiptId: receipt.id,
      oldKeyId,
      newKeyId,
      candidateIdsJson: candidateIdsJson.map((candidate) => ({ ...candidate })),
      referenceSetHash: input.referenceSetHash,
      baseRevisionsJson,
      stage: "PREPARING",
      checkpointJson: { version: 1, fencingToken: input.claim.fencingToken, step: "PREPARED" },
      createdAt: now,
      updatedAt: now,
    },
  });
}

const checkpointSteps = {
  PREPARING: "PREPARED",
  TESTING: "TESTING",
  READY: "VERIFIED",
  ACTIVATED: "ACTIVATED",
  ABORTED: "ABORTED",
} as const;

/** A reclaimed lease resumes persisted progress. An expired owner/fence cannot alter the checkpoint. */
export async function saveKeyRotationCheckpoint(
  tx: Prisma.TransactionClient,
  input: {
    claim: AdminCommandClaim;
    runId: string;
    stage: keyof typeof checkpointSteps;
    step: (typeof checkpointSteps)[keyof typeof checkpointSteps];
    errorCode?: string;
    verificationHash?: string;
  },
) {
  const { receipt, now } = await assertAdminCommandClaim(tx, input.claim);
  const runId = parseAdminUserId(input.runId);
  if (!Object.hasOwn(checkpointSteps, input.stage) || input.step !== checkpointSteps[input.stage]) {
    throw new AdminCommandError("VALIDATION_ERROR");
  }
  if (
    (input.errorCode !== undefined &&
      ![
        "CONFIG_ERROR",
        "PROVIDER_UNAVAILABLE",
        "PROVIDER_TIMEOUT",
        "VERSION_CONFLICT",
        "INTERNAL_ERROR",
      ].includes(input.errorCode)) ||
    (input.verificationHash !== undefined && !/^[a-f0-9]{64}$/.test(input.verificationHash))
  )
    throw new AdminCommandError("VALIDATION_ERROR");
  const row = await tx.keyRotationRun.findUnique({ where: { id: runId } });
  if (
    !row ||
    row.receiptId !== receipt.id ||
    row.stage === "ACTIVATED" ||
    row.stage === "ABORTED"
  ) {
    throw new AdminCommandError("INVALID_STATE");
  }
  return tx.keyRotationRun.update({
    where: { id: runId },
    data: {
      stage: input.stage,
      checkpointJson: {
        version: 1,
        fencingToken: input.claim.fencingToken,
        step: input.step,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        ...(input.verificationHash === undefined
          ? {}
          : { verificationHash: input.verificationHash }),
      },
      updatedAt: now,
    },
  });
}

export function isAdminCommandValidation(error: unknown): boolean {
  return (
    error instanceof AdminUserInputError ||
    (error instanceof AdminCommandError && error.kind === "VALIDATION_ERROR")
  );
}

export async function writeSucceededKeyReceipt(
  tx: Prisma.TransactionClient,
  identity: AdminCommandIdentity,
  response: ApiKeyDto,
): Promise<void> {
  const safe = parseApiKeyDto(response),
    now = await readAuthClock(tx);
  await tx.adminCommandReceipt.create({
    data: {
      ...identity,
      status: "SUCCEEDED",
      responseJson: { ...safe },
      createdAt: now,
      availableAt: now,
      completedAt: now,
      expiresAt: new Date(now.getTime() + ADMIN_RECEIPT_MIN_RETENTION_MS),
    },
    select: { id: true },
  });
}

export function readSucceededKeyReceipt(receipt: AdminCommandReceipt): ApiKeyDto {
  if (receipt.status !== "SUCCEEDED") throw new AdminCommandError("INVALID_STATE");
  try {
    return parseApiKeyDto(receipt.responseJson);
  } catch {
    throw new AdminCommandError("INVALID_STATE");
  }
}

export function readTerminalRotationReceipt(receipt: AdminCommandReceipt): KeyRotationReceipt {
  if (receipt.status !== "SUCCEEDED" && receipt.status !== "FAILED")
    throw new AdminCommandError("INVALID_STATE");
  try {
    return { ...parseKeyRotationReceipt(receipt.responseJson), replayed: true };
  } catch {
    throw new AdminCommandError("INVALID_STATE");
  }
}

export async function finishKeyRotationCommand(
  tx: Prisma.TransactionClient,
  claim: AdminCommandClaim,
  response: KeyRotationReceipt,
  failureCode?: string,
): Promise<void> {
  const { now, receipt } = await assertAdminCommandClaim(tx, claim);
  const safe = parseKeyRotationReceipt(response);
  if (
    failureCode !== undefined &&
    !["CONFIG_ERROR", "VERSION_CONFLICT", "INTERNAL_ERROR"].includes(failureCode)
  )
    throw new AdminCommandError("VALIDATION_ERROR");
  await tx.adminCommandReceipt.update({
    where: { id: claim.receiptId, fencingToken: claim.fencingToken },
    data: {
      status: failureCode === undefined ? "SUCCEEDED" : "FAILED",
      responseJson: { ...safe, key: { ...safe.key } },
      errorCode: failureCode ?? null,
      completedAt: now,
      expiresAt: new Date(
        Math.max(receipt.expiresAt.getTime(), now.getTime() + ADMIN_RECEIPT_MIN_RETENTION_MS),
      ),
      leaseOwner: null,
      leaseUntil: null,
    },
    select: { id: true },
  });
}

export async function releaseKeyRotationCommand(
  tx: Prisma.TransactionClient,
  claim: AdminCommandClaim,
): Promise<void> {
  const { now } = await assertAdminCommandClaim(tx, claim);
  await tx.adminCommandReceipt.update({
    where: { id: claim.receiptId, fencingToken: claim.fencingToken },
    data: { status: "RETRY_WAIT", availableAt: now, leaseOwner: null, leaseUntil: null },
    select: { id: true },
  });
}
