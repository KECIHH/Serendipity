import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type ChatMessage,
  type PrismaClient,
  type TravelRecord,
  type User,
} from "@prisma/client";

export const TRAVEL_STATUSES = [
  "DRAFT",
  "NEEDS_INFO",
  "PLANNED",
  "MODIFIED",
  "FINALIZED",
  "NEEDS_REVALIDATION",
  "ARCHIVED",
] as const;

export const TRAVEL_RECORD_FIELDS = [
  "id",
  "userId",
  "anonTokenHash",
  "title",
  "status",
  "version",
  "requirementJson",
  "createdAt",
  "updatedAt",
] as const;

export const CHAT_MESSAGE_FIELDS = [
  "id",
  "travelRecordId",
  "role",
  "kind",
  "content",
  "contentJson",
  "sequence",
  "clientMessageId",
  "replyToMessageId",
  "createdAt",
] as const;

export function readPhase008Target(value: string | undefined): {
  target: URL;
  runId: string;
  phase: string;
} {
  let target: URL;
  try {
    if (value === undefined) throw new Error();
    target = new URL(value);
  } catch {
    throw new Error("PHASE008_DATABASE_URL must identify this run's disposable database");
  }
  const name = /^\/phase(00[89]|01[01])_disposable_([a-f0-9]{12})(?:_[a-z0-9_]+)?$/.exec(
    target.pathname,
  );
  const allowedOptions = new Set(["schema", "connect_timeout", "pool_timeout", "connection_limit"]);
  if (
    !["postgresql:", "postgres:"].includes(target.protocol) ||
    target.hostname !== "127.0.0.1" ||
    target.hash !== "" ||
    !name ||
    target.pathname.length > 64 ||
    [...target.searchParams.keys()].some((key) => !allowedOptions.has(key)) ||
    (target.searchParams.has("schema") && target.searchParams.get("schema") !== "public")
  ) {
    throw new Error("Phase008 database guard rejected an unowned target");
  }
  return { target, phase: name[1], runId: name[2] };
}

/** Resolve the application singleton only after the URL guard, then prove the database marker. */
export async function connectPhase008Database(value: string | undefined): Promise<PrismaClient> {
  const { target, runId, phase } = readPhase008Target(value);
  process.env.DATABASE_URL = target.toString();
  const { connectDb, db } = await import("@/server/db");
  await connectDb();
  const [identity] = await db.$queryRaw<
    Array<{ name: string; version: string; marker: string | null }>
  >`
    SELECT d.datname AS name, current_setting('server_version') AS version,
           shobj_description(d.oid, 'pg_database') AS marker
    FROM pg_database d WHERE d.datname = current_database()
  `;
  if (
    identity?.name !== target.pathname.slice(1) ||
    !/^17\./.test(identity.version) ||
    identity.marker !== `serendipity-phase${phase}-disposable:${runId}`
  ) {
    await db.$disconnect();
    throw new Error("Phase008 database identity guard rejected the connected target");
  }
  return db;
}

type RecordOverrides = Partial<Omit<Prisma.TravelRecordUncheckedCreateInput, "id">>;
type MessageOverrides = Partial<
  Omit<Prisma.ChatMessageUncheckedCreateInput, "id" | "travelRecordId">
>;
type UserOverrides = Partial<
  Omit<Prisma.UserUncheckedCreateInput, "id" | "email" | "passwordHash">
>;

interface RawRecordOverrides {
  userId?: string | null;
  anonTokenHash?: string | null;
  title?: string | null;
  status?: string | null;
  version?: number | null;
  requirementJson?: Prisma.InputJsonValue | null;
}

interface RawMessageOverrides {
  role?: string | null;
  kind?: string | null;
  content?: string | null;
  contentJson?: Prisma.InputJsonValue | null;
  sequence?: number | null;
  clientMessageId?: string | null;
  replyToMessageId?: string | null;
}

// Synthetic hash-shaped data: no password or authentication behavior is exercised by these rows.
const syntheticPasswordHash = `$2b$12$${"a".repeat(53)}`;

export class DataFixture {
  readonly prefix = `phase008-${randomUUID()}`;
  private readonly createdUserIds = new Set<string>();
  private readonly createdRecordIds = new Set<string>();
  private readonly createdMessageIds = new Set<string>();
  private identitySequence = 0;

  constructor(private readonly database: PrismaClient) {}

  get userIds(): readonly string[] {
    return [...this.createdUserIds];
  }

  get recordIds(): readonly string[] {
    return [...this.createdRecordIds];
  }

  get messageIds(): readonly string[] {
    return [...this.createdMessageIds];
  }

  uniqueLabel(): string {
    this.identitySequence += 1;
    return `${this.prefix}-${this.identitySequence}`;
  }

  /** This is a direct database fixture hash, not a Cookie or a trusted application owner. */
  syntheticOwnerHash(): string {
    return createHash("sha256").update(this.uniqueLabel()).digest("hex");
  }

  rememberRecord<T extends { id: string }>(row: T): T {
    this.createdRecordIds.add(row.id);
    return row;
  }

  rememberMessage<T extends { id: string }>(row: T): T {
    this.createdMessageIds.add(row.id);
    return row;
  }

  async createUser(overrides: UserOverrides = {}): Promise<User> {
    const row = await this.database.user.create({
      data: {
        email: `${this.uniqueLabel()}@example.invalid`,
        passwordHash: syntheticPasswordHash,
        ...overrides,
      },
    });
    this.createdUserIds.add(row.id);
    return row;
  }

  async createRecord(overrides: RecordOverrides = {}): Promise<TravelRecord> {
    const row = await this.database.travelRecord.create({
      data: {
        title: "Synthetic travel record",
        anonTokenHash: overrides.userId ? null : this.syntheticOwnerHash(),
        ...overrides,
      },
    });
    return this.rememberRecord(row);
  }

  async createMessage(
    travelRecordId: string,
    overrides: MessageOverrides = {},
  ): Promise<ChatMessage> {
    const row = await this.database.chatMessage.create({
      data: {
        travelRecordId,
        role: "USER",
        kind: "TEXT",
        content: "Synthetic message",
        sequence: 1,
        ...overrides,
      },
    });
    return this.rememberMessage(row);
  }

  async insertRawRecord(overrides: RawRecordOverrides = {}): Promise<string> {
    const row = {
      id: randomUUID(),
      userId: null as string | null,
      anonTokenHash: this.syntheticOwnerHash() as string | null,
      title: "Synthetic SQL record",
      status: "DRAFT",
      version: 0,
      requirementJson: null as Prisma.InputJsonValue | null,
      ...overrides,
    };
    const requirementJson =
      row.requirementJson === null ? null : JSON.stringify(row.requirementJson);
    await this.database.$executeRaw`
      INSERT INTO "TravelRecord"
        (id, "userId", "anonTokenHash", title, status, version, "requirementJson", "updatedAt")
      VALUES
        (${row.id}, ${row.userId}, ${row.anonTokenHash}, ${row.title}, ${row.status}::"TravelStatus",
         ${row.version}, ${requirementJson}::jsonb, NOW())
    `;
    this.createdRecordIds.add(row.id);
    return row.id;
  }

  async insertRawMessage(
    travelRecordId: string,
    overrides: RawMessageOverrides = {},
  ): Promise<string> {
    const row = {
      id: randomUUID(),
      role: "USER",
      kind: "TEXT",
      content: "Synthetic SQL message",
      contentJson: null as Prisma.InputJsonValue | null,
      sequence: 1,
      clientMessageId: null as string | null,
      replyToMessageId: null as string | null,
      ...overrides,
    };
    const contentJson = row.contentJson === null ? null : JSON.stringify(row.contentJson);
    await this.database.$executeRaw`
      INSERT INTO "ChatMessage"
        (id, "travelRecordId", role, kind, content, "contentJson", sequence,
         "clientMessageId", "replyToMessageId")
      VALUES
        (${row.id}, ${travelRecordId}, ${row.role}::"MessageRole", ${row.kind}::"ChatMessageKind",
         ${row.content}, ${contentJson}::jsonb, ${row.sequence}, ${row.clientMessageId}, ${row.replyToMessageId})
    `;
    this.createdMessageIds.add(row.id);
    return row.id;
  }

  async deleteUser(id: string): Promise<void> {
    if (!this.createdUserIds.has(id)) throw new Error("Fixture does not own this user");
    await this.database.user.delete({ where: { id } });
    this.createdUserIds.delete(id);
  }

  /** Test-only purge; this deliberately does not create a business deletion API. */
  async purgeRecord(id: string): Promise<void> {
    if (!this.createdRecordIds.has(id)) throw new Error("Fixture does not own this record");
    await this.database.travelRecord.delete({ where: { id } });
    this.createdRecordIds.delete(id);
  }

  /** Direct fixture mutation proving the self foreign key's SetNull behavior. */
  async deleteReplyTarget(id: string): Promise<void> {
    if (!this.createdMessageIds.has(id)) throw new Error("Fixture does not own this message");
    await this.database.chatMessage.delete({ where: { id } });
    this.createdMessageIds.delete(id);
  }

  async cleanup(): Promise<void> {
    if (this.createdMessageIds.size > 0) {
      await this.database.chatMessage.deleteMany({
        where: { id: { in: [...this.createdMessageIds] } },
      });
      this.createdMessageIds.clear();
    }
    if (this.createdRecordIds.size > 0) {
      await this.database.travelRecord.deleteMany({
        where: { id: { in: [...this.createdRecordIds] } },
      });
      this.createdRecordIds.clear();
    }
    if (this.createdUserIds.size > 0) {
      await this.database.user.deleteMany({ where: { id: { in: [...this.createdUserIds] } } });
      this.createdUserIds.clear();
    }
  }
}

export const SQL_CHECK_ERROR = { code: "P2010", meta: { code: "23514" } } as const;
export const SQL_FOREIGN_KEY_ERROR = { code: "P2010", meta: { code: "23503" } } as const;
export const SQL_REQUIRED_ERROR = { code: "P2010", meta: { code: "23502" } } as const;

/** Schema fixtures use JSON directly only to establish nullable storage, never product validity. */
export const DATABASE_NULL = Prisma.DbNull;
