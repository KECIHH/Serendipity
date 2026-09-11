import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma, PrismaClient } from "@prisma/client";
import { normalizeEmailV1 } from "@/server/auth";
import {
  AUDIT_ACTION_TARGETS,
  AUDIT_LIMITS,
  AUDIT_SYSTEM_ACTORS,
  AuditLogError,
  readAuditContext,
  readAuditIdentifier,
  readAuditObject,
  sanitizeAuditDetail,
  type AuditLogAction,
  type AuditRequestContext,
  type AuditSystemActor,
  type AuditTargetType,
} from "@/server/audit-log";

declare const transactionBrand: unique symbol;

export type AuditTransactionClient = Prisma.TransactionClient & {
  readonly [transactionBrand]: true;
  $connect?: never;
  $disconnect?: never;
  $transaction?: never;
  $on?: never;
  $use?: never;
  $extends?: never;
};

export type AuditActor =
  | { kind: "USER"; id: string; emailSnapshot: string }
  | { kind: "SYSTEM"; systemActor: AuditSystemActor };

export interface AuditLogInput {
  actor: AuditActor;
  action: AuditLogAction;
  targetType: AuditTargetType;
  targetId?: string | null;
  context?: AuditRequestContext | null;
  detailJson?: unknown;
}

export interface AuditLogRef {
  id: string;
  action: AuditLogAction;
  createdAt: Date;
}

interface TransactionState {
  failed: boolean;
  pending: number;
  writes: number;
}

const transactions = new WeakMap<object, TransactionState>();
const transactionScopes = new AsyncLocalStorage<{
  client: Prisma.TransactionClient;
  state: TransactionState;
}>();

function invalid(): never {
  const scope = transactionScopes.getStore();
  if (scope) scope.state.failed = true;
  throw new AuditLogError("VALIDATION_ERROR");
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}

function requireTransaction(tx: AuditTransactionClient): TransactionState {
  if (tx === null || typeof tx !== "object") invalid();
  const state = transactions.get(tx);
  if (!state) invalid();
  const scope = transactionScopes.getStore();
  if (scope?.client !== tx || scope.state !== state) {
    state.failed = true;
    invalid();
  }
  for (const key of [
    "$connect",
    "$disconnect",
    "$transaction",
    "$on",
    "$use",
    "$extends",
  ] as const) {
    if (key in tx) invalid();
  }
  if (typeof tx.$queryRaw !== "function" || typeof tx.auditLog?.create !== "function") invalid();
  return state;
}

/** Safe classification retains retry semantics without retaining a driver's rejected data. */
export class AuditTransactionConflictError extends AuditLogError {
  constructor() {
    super("INTERNAL_ERROR");
    this.name = "AuditTransactionConflictError";
  }
}

function safeTransactionError(error: unknown): never {
  if (error instanceof AuditLogError) throw error;
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    ["P2034", "P2002"].includes(error.code)
  ) {
    throw new AuditTransactionConflictError();
  }
  throw new AuditLogError("INTERNAL_ERROR");
}

/** Enrollment is private: callers cannot supply transaction wrappers or global delegates. */
async function enrolledTransaction<T>(
  client: PrismaClient,
  operation: (tx: AuditTransactionClient) => Promise<T>,
  isolationLevel?: Prisma.TransactionIsolationLevel,
): Promise<T> {
  if (typeof operation !== "function" || transactionScopes.getStore()) invalid();
  try {
    return await client.$transaction(
      (tx) => {
        const state: TransactionState = { failed: false, pending: 0, writes: 0 };
        transactions.set(tx, state);
        return transactionScopes.run({ client: tx, state }, async () => {
          try {
            // This assertion grants only the private provenance brand, after actual Prisma enrollment.
            const result = await operation(tx as AuditTransactionClient);
            if (state.failed || state.pending !== 0 || state.writes === 0) {
              throw new AuditLogError("INTERNAL_ERROR");
            }
            return result;
          } finally {
            transactions.delete(tx);
          }
        });
      },
      { isolationLevel, maxWait: 5_000, timeout: 15_000 },
    );
  } catch (error: unknown) {
    return safeTransactionError(error);
  }
}

export async function runAuditedTransaction<T>(
  operation: (tx: AuditTransactionClient) => Promise<T>,
): Promise<T> {
  if (typeof operation !== "function" || transactionScopes.getStore()) invalid();
  const { db } = await import("@/server/db");
  return enrolledTransaction(db, operation);
}

/** CLI-only connection; constructed here, never supplied or enrolled by a caller. */
export function openAuditedSeedDatabase(databaseUrl: string) {
  const client = new PrismaClient({ datasourceUrl: databaseUrl, log: [] });
  return Object.freeze({
    transaction: <T>(operation: (tx: AuditTransactionClient) => Promise<T>) =>
      enrolledTransaction(client, operation, Prisma.TransactionIsolationLevel.Serializable),
    disconnect: () => client.$disconnect(),
  });
}

/** Auth services own a real connection; caller-supplied transaction wrappers are never enrolled. */
export function openAuditedAuthDatabase(databaseUrl: string) {
  const client = new PrismaClient({ datasourceUrl: databaseUrl, log: [] });
  return Object.freeze({
    transaction: <T>(operation: (tx: AuditTransactionClient) => Promise<T>) =>
      enrolledTransaction(client, operation, Prisma.TransactionIsolationLevel.ReadCommitted),
    disconnect: () => client.$disconnect(),
  });
}

function prepare(
  input: AuditLogInput,
): Prisma.AuditLogUncheckedCreateInput & { action: AuditLogAction } {
  const fields = readAuditObject(input);
  exactFields(fields, ["actor", "action", "targetType", "targetId", "context", "detailJson"]);
  if (
    typeof fields.action !== "string" ||
    fields.action.length > AUDIT_LIMITS.action ||
    !Object.hasOwn(AUDIT_ACTION_TARGETS, fields.action)
  )
    invalid();
  const action = fields.action as AuditLogAction;
  if (
    typeof fields.targetType !== "string" ||
    fields.targetType.length > AUDIT_LIMITS.targetType ||
    fields.targetType !== AUDIT_ACTION_TARGETS[action]
  )
    invalid();
  const targetId =
    fields.targetId === null || fields.targetId === undefined
      ? null
      : readAuditIdentifier(fields.targetId);
  const actor = readAuditObject(fields.actor);
  let actorId: string | null = null;
  let actorEmailSnapshot: string | null = null;
  let detailJson = sanitizeAuditDetail(fields.detailJson);
  if (detailJson !== null && Object.hasOwn(detailJson, "systemActor")) invalid();
  if (actor.kind === "USER") {
    exactFields(actor, ["kind", "id", "emailSnapshot"]);
    actorId = readAuditIdentifier(actor.id);
    if (
      typeof actor.emailSnapshot !== "string" ||
      actor.emailSnapshot.length > AUDIT_LIMITS.actorEmail
    )
      invalid();
    try {
      if (normalizeEmailV1(actor.emailSnapshot) !== actor.emailSnapshot) invalid();
    } catch {
      invalid();
    }
    actorEmailSnapshot = actor.emailSnapshot;
  } else if (actor.kind === "SYSTEM") {
    exactFields(actor, ["kind", "systemActor"]);
    if (
      typeof actor.systemActor !== "string" ||
      !AUDIT_SYSTEM_ACTORS.some((value) => value === actor.systemActor)
    )
      invalid();
    detailJson = sanitizeAuditDetail({ ...detailJson, systemActor: actor.systemActor });
  } else invalid();
  return {
    actorId,
    actorEmailSnapshot,
    action,
    targetType: fields.targetType,
    targetId,
    ...readAuditContext(fields.context),
    detailJson: detailJson === null ? Prisma.DbNull : detailJson,
  };
}

/** Await inside runAuditedTransaction; a failed or outstanding audit prevents its commit. */
export async function writeAuditLog(
  tx: AuditTransactionClient,
  input: AuditLogInput,
): Promise<AuditLogRef> {
  const state = requireTransaction(tx);
  state.pending += 1;
  try {
    const data = prepare(input);
    const row = await tx.auditLog.create({
      data,
      select: { id: true, action: true, createdAt: true },
    });
    state.writes += 1;
    return { id: row.id, action: data.action, createdAt: row.createdAt };
  } catch (error: unknown) {
    state.failed = true;
    // Driver diagnostics can contain the rejected row; they never cross this boundary.
    return safeTransactionError(error);
  } finally {
    state.pending -= 1;
  }
}
