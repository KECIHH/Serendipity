import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { Prisma, TaskPayload } from "@prisma/client";
import { env } from "@/lib/env";
import { canonicalJson, canonicalHash } from "@/lib/ai/schemas";

export const PAYLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_PAYLOAD_BYTES = 128 * 1024;
const pins = new Map<
  string,
  (tx: Prisma.TransactionClient, payload: TaskPayload) => Promise<boolean>
>();
/** Domain producers register live workspace/clarification/override/erasure references when created. */
export function registerPayloadPin(
  name: string,
  pin: (tx: Prisma.TransactionClient, payload: TaskPayload) => Promise<boolean>,
) {
  if (!/^[A-Z_]{1,64}$/.test(name) || pins.has(name)) throw new Error("PAYLOAD_PIN_INVALID");
  pins.set(name, pin);
  return () => {
    pins.delete(name);
  };
}
function key() {
  const master = Buffer.from(env.ENCRYPTION_KEY, "base64");
  if (master.length !== 32) throw new Error("CONFIG_ERROR");
  return {
    bytes: createHash("sha256").update("serendipity.task-payload.v1").update(master).digest(),
    id: createHash("sha256").update(master).digest("hex"),
  };
}
function aad(
  row: Pick<TaskPayload, "id" | "ownerKeyHash" | "schemaVersion" | "contentHash" | "expiresAt">,
) {
  return Buffer.from(
    canonicalJson({
      id: row.id,
      ownerKeyHash: row.ownerKeyHash,
      schemaVersion: row.schemaVersion,
      contentHash: row.contentHash,
      expiresAt: row.expiresAt.toISOString(),
    }),
  );
}
export function payloadId(reference: string): string {
  if (!/^task-payload:[A-Za-z0-9_-]{1,100}$/.test(reference))
    throw new Error("PAYLOAD_REFERENCE_INVALID");
  return reference.slice("task-payload:".length);
}
function validatePayload(value: unknown) {
  const text = canonicalJson(value);
  if (
    Buffer.byteLength(text) > MAX_PAYLOAD_BYTES ||
    /"(?:password|plainKey|secret|cookie|authorization|token)"\s*:/i.test(text) ||
    /(?:authorization\s*:|bearer\s+[a-z0-9._-]{20,}|cookie\s*:)/i.test(text)
  )
    throw new Error("PAYLOAD_INVALID");
  return text;
}
export async function storeTaskPayload(
  tx: Prisma.TransactionClient,
  input: {
    ownerKeyHash: string;
    schemaVersion: number;
    value: unknown;
    now?: Date;
  },
) {
  if (
    !/^[a-f0-9]{64}$/.test(input.ownerKeyHash) ||
    !Number.isSafeInteger(input.schemaVersion) ||
    input.schemaVersion < 1
  )
    throw new Error("PAYLOAD_INVALID");
  const content = validatePayload(input.value),
    active = key();
  const metadata = {
    id: "payload_" + randomUUID().replaceAll("-", ""),
    ownerKeyHash: input.ownerKeyHash,
    schemaVersion: input.schemaVersion,
    contentHash: canonicalHash(input.value),
    expiresAt: new Date((input.now ?? new Date()).getTime() + PAYLOAD_RETENTION_MS),
  };
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", active.bytes, iv);
  cipher.setAAD(aad(metadata));
  const encrypted = Buffer.concat([cipher.update(content, "utf8"), cipher.final()]);
  const row = await tx.taskPayload.create({
    data: {
      ...metadata,
      encryptionKeyId: active.id,
      ciphertext: JSON.stringify({
        version: 1,
        iv: iv.toString("base64url"),
        encrypted: encrypted.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
      }),
    },
  });
  return {
    payloadRef: "task-payload:" + row.id,
    payloadHash: row.contentHash,
    payloadSchemaVersion: row.schemaVersion,
  };
}
export async function readTaskPayload(
  tx: Prisma.TransactionClient,
  input: {
    payloadRef: string;
    payloadHash: string;
    payloadSchemaVersion: number;
    ownerKeyHash?: string;
  },
): Promise<unknown> {
  const row = await tx.taskPayload.findUnique({ where: { id: payloadId(input.payloadRef) } });
  if (
    !row ||
    row.contentHash !== input.payloadHash ||
    row.schemaVersion !== input.payloadSchemaVersion ||
    (input.ownerKeyHash && row.ownerKeyHash !== input.ownerKeyHash)
  )
    throw new Error("PAYLOAD_REFERENCE_INVALID");
  try {
    const active = key(),
      envelope = JSON.parse(row.ciphertext) as Record<string, unknown>;
    if (
      row.encryptionKeyId !== active.id ||
      envelope.version !== 1 ||
      Object.keys(envelope).sort().join() !== "encrypted,iv,tag,version"
    )
      throw new Error();
    const iv = Buffer.from(String(envelope.iv), "base64url"),
      tag = Buffer.from(String(envelope.tag), "base64url");
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", active.bytes, iv);
    decipher.setAAD(aad(row));
    decipher.setAuthTag(tag);
    const bytes = Buffer.concat([
      decipher.update(Buffer.from(String(envelope.encrypted), "base64url")),
      decipher.final(),
    ]);
    if (bytes.length > MAX_PAYLOAD_BYTES) throw new Error();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (canonicalHash(value) !== row.contentHash) throw new Error();
    validatePayload(value);
    return value;
  } catch {
    throw new Error("PAYLOAD_DECRYPT_FAILED");
  }
}
export async function cleanupTaskPayload(
  tx: Prisma.TransactionClient,
  input: { id: string; now?: Date },
) {
  await tx.$queryRawUnsafe('SELECT id FROM "TaskPayload" WHERE id=$1 FOR UPDATE', input.id);
  const row = await tx.taskPayload.findUnique({ where: { id: input.id } });
  if (!row) return false;
  const now = input.now ?? new Date(),
    reference = "task-payload:" + row.id;
  if (row.expiresAt > now) return false;
  const tasks = await tx.durableTask.findMany({
    where: {
      OR: [
        { payloadRef: reference },
        { checkpointJson: { path: ["resultPayloadRef"], equals: reference } },
      ],
    },
  });
  if (
    tasks.some(
      (task) =>
        !["SUCCEEDED", "FAILED", "CANCELLED"].includes(task.status) ||
        task.updatedAt.getTime() + PAYLOAD_RETENTION_MS > now.getTime(),
    )
  )
    return false;
  const commands = await tx.chatCommand.findMany({
    where: { payloadRef: reference },
    select: { status: true, completedAt: true },
  });
  if (
    commands.some(
      (command) =>
        !command.completedAt ||
        command.completedAt.getTime() + PAYLOAD_RETENTION_MS > now.getTime(),
    )
  )
    return false;
  for (const pin of pins.values()) if (await pin(tx, row)) return false;
  await tx.$queryRawUnsafe("SELECT set_config('serendipity.payload_cleanup','authorized',true)");
  await tx.taskPayload.delete({ where: { id: row.id } });
  return true;
}
