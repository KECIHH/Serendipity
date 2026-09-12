import { createHash, randomUUID } from "node:crypto";
import { PrismaClient, type SystemConfig, type User } from "@prisma/client";
import type { AuditLogInput } from "@/server/services/audit-log-service";

export const AUDIT_FIELDS = [
  "id",
  "actorId",
  "actorEmailSnapshot",
  "action",
  "targetType",
  "targetId",
  "requestId",
  "traceId",
  "detailJson",
  "ipHash",
  "userAgentSummary",
  "createdAt",
];
export const AUDIT_INDEXES = [
  "AuditLog_action_createdAt_idx",
  "AuditLog_actorId_createdAt_idx",
  "AuditLog_requestId_idx",
  "AuditLog_targetType_targetId_createdAt_idx",
  "AuditLog_traceId_idx",
];
export const SENSITIVE_KEYS = [
  "password",
  "passwordHash",
  "secret",
  "apiKey",
  "encryptedKey",
  "authorization",
  "cookie",
  "token",
  "anonToken",
  "shareToken",
  "promptContent",
  "DATABASE_URL",
  "sessionToken",
  "envelope",
  "ciphertext",
  "Set-Cookie",
  "receipt",
  "rawOutput",
  "rawResponse",
  "systemPrompt",
  "query",
  "description",
  "email",
  "phone",
  "coordinate",
  "address",
  "chat",
  "messages",
  "privateText",
  "X-Share-Token",
  "X-Feedback-Receipt",
  "X-Data-Request-Receipt",
];

export function sensitiveCanary(label: string): string {
  return `private-${createHash("sha256").update(`phase009:${label}`).digest("hex")}`;
}

export function systemInput(targetId: string | null = null): AuditLogInput {
  return {
    actor: { kind: "SYSTEM", systemActor: "SCHEDULER" },
    action: "CONFIG_UPDATE",
    targetType: "SystemConfig",
    targetId,
    detailJson: { result: "SUCCESS" },
  };
}

export function readPhase009Target(
  value: string | undefined,
  runtime: boolean,
): { url: URL; runId: string; phase: "009" | "010" | "011" | "012" } {
  let url: URL;
  try {
    if (value === undefined) throw new Error();
    url = new URL(value);
  } catch {
    throw new Error("Phase009 requires an explicit disposable database URL");
  }
  const match = /^\/phase(009|010|011|012)_disposable_([a-f0-9]{12})(?:_[a-z0-9_]+)?$/.exec(
    url.pathname,
  );
  if (
    !match ||
    url.pathname.length > 64 ||
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.hash ||
    url.username !== `phase${match[1]}_${runtime ? "app" : "runner"}` ||
    [...url.searchParams.keys()].some(
      (key) => !["connect_timeout", "pool_timeout", "connection_limit"].includes(key),
    )
  )
    throw new Error("Phase009 rejected an unowned database target");
  return { url, runId: match[2], phase: match[1] as "009" | "010" | "011" | "012" };
}

export async function connectPhase009Database(
  adminValue: string | undefined,
  appValue: string | undefined,
): Promise<{ admin: PrismaClient; app: PrismaClient }> {
  const owner = readPhase009Target(adminValue, false);
  const runtime = readPhase009Target(appValue, true);
  if (owner.url.host !== runtime.url.host || owner.url.pathname !== runtime.url.pathname)
    throw new Error("Phase009 role connections must refer to the same database");
  process.env.DATABASE_URL = runtime.url.toString();
  const { db: app, connectDb } = await import("@/server/db");
  const admin = new PrismaClient({ datasourceUrl: owner.url.toString(), log: [] });
  await connectDb(app);
  await connectDb(admin);
  try {
    for (const [client, role] of [
      [app, `phase${runtime.phase}_app`],
      [admin, `phase${owner.phase}_runner`],
    ] as const) {
      const [identity] = await client.$queryRaw<
        Array<{ name: string; role: string; version: string; marker: string | null }>
      >`
        SELECT d.datname AS name, current_user AS role, current_setting('server_version') AS version,
               shobj_description(d.oid, 'pg_database') AS marker FROM pg_database d WHERE d.datname=current_database()
      `;
      if (
        identity?.name !== owner.url.pathname.slice(1) ||
        identity.role !== role ||
        !/^17\./.test(identity.version) ||
        identity.marker !== `serendipity-phase${owner.phase}-disposable:${owner.runId}`
      )
        throw new Error("Phase009 rejected the connected database identity");
    }
    return { admin, app };
  } catch (error) {
    await app.$disconnect();
    await admin.$disconnect();
    throw error;
  }
}

export class AuditFixture {
  readonly prefix = `phase009-${randomUUID()}`;
  private readonly users = new Set<string>();
  private readonly configs = new Set<string>();
  private sequence = 0;

  constructor(
    readonly admin: PrismaClient,
    readonly app: PrismaClient,
  ) {}

  id(): string {
    this.sequence += 1;
    return `${this.prefix}-${this.sequence}`;
  }

  async createUser(): Promise<User> {
    const row = await this.app.user.create({
      data: { email: `${this.id()}@example.invalid`, passwordHash: `$2b$12$${"a".repeat(53)}` },
    });
    this.users.add(row.id);
    return row;
  }

  async createConfig(): Promise<SystemConfig> {
    const row = await this.app.systemConfig.create({
      data: {
        key: this.id(),
        description: "Synthetic audit fixture",
        group: "GENERAL",
        valueJson: { enabled: false },
      },
    });
    this.configs.add(row.id);
    return row;
  }

  async cleanup(): Promise<void> {
    if (this.configs.size)
      await this.app.systemConfig.deleteMany({ where: { id: { in: [...this.configs] } } });
    if (this.users.size) await this.app.user.deleteMany({ where: { id: { in: [...this.users] } } });
    this.configs.clear();
    this.users.clear();
  }
}

export async function rejectsOperation(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch {
    return true;
  }
}
