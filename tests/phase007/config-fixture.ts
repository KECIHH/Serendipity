import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, SystemConfig, User } from "@prisma/client";

export const EXPECTED_PUBLIC_USER_FIELDS = [
  "id",
  "email",
  "name",
  "avatarUrl",
  "role",
  "status",
  "lastLoginAt",
  "createdAt",
] as const;

export const EXPECTED_ADMIN_USER_FIELDS = [...EXPECTED_PUBLIC_USER_FIELDS, "revision"] as const;

// This is synthetic hash-shaped data, never a credential or an authentication fixture.
const syntheticHash = `$2b$12$${"a".repeat(53)}`;

type ConfigOverrides = Partial<
  Pick<
    Prisma.SystemConfigUncheckedCreateInput,
    | "key"
    | "valueJson"
    | "description"
    | "group"
    | "isPublic"
    | "revision"
    | "updatedBy"
    | "createdAt"
    | "updatedAt"
  >
>;

type UserOverrides = Partial<
  Pick<
    Prisma.UserUncheckedCreateInput,
    | "name"
    | "avatarUrl"
    | "phone"
    | "role"
    | "status"
    | "revision"
    | "sessionVersion"
    | "lastLoginAt"
  >
>;

interface RawConfigOverrides {
  key?: string | null;
  valueJson?: Prisma.InputJsonValue | null;
  description?: string | null;
  group?: string | null;
  revision?: number | null;
  updatedBy?: string | null;
}

export class ConfigFixture {
  readonly prefix = `phase007-${randomUUID()}`;
  private readonly createdConfigIds = new Set<string>();
  private readonly createdUserIds = new Set<string>();
  private sequence = 0;

  constructor(private readonly database: PrismaClient) {}

  get configIds(): readonly string[] {
    return [...this.createdConfigIds];
  }

  get userIds(): readonly string[] {
    return [...this.createdUserIds];
  }

  createKey(): string {
    this.sequence += 1;
    return `${this.prefix}.${this.sequence}`;
  }

  async createConfig(overrides: ConfigOverrides = {}): Promise<SystemConfig> {
    const row = await this.database.systemConfig.create({
      data: {
        key: this.createKey(),
        valueJson: { enabled: false, displayCount: 3 },
        description: "Synthetic configuration fixture",
        group: "GENERAL",
        ...overrides,
      },
    });
    this.createdConfigIds.add(row.id);
    return row;
  }

  async createUser(overrides: UserOverrides = {}): Promise<User> {
    this.sequence += 1;
    const row = await this.database.user.create({
      data: {
        email: `${this.prefix}.${this.sequence}@example.invalid`,
        passwordHash: syntheticHash,
        ...overrides,
      },
    });
    this.createdUserIds.add(row.id);
    return row;
  }

  async insertRawConfig(overrides: RawConfigOverrides = {}): Promise<string> {
    const row = {
      id: randomUUID(),
      key: this.createKey(),
      valueJson: { enabled: false } as Prisma.InputJsonValue | null,
      description: "Synthetic direct SQL fixture",
      group: "GENERAL",
      revision: 0,
      updatedBy: null,
      ...overrides,
    };
    const json = row.valueJson === null ? null : JSON.stringify(row.valueJson);
    await this.database.$executeRaw`
      INSERT INTO "SystemConfig"
        (id, key, "valueJson", description, "group", revision, "updatedBy", "updatedAt")
      VALUES
        (${row.id}, ${row.key}, ${json}::jsonb, ${row.description}, ${row.group},
         ${row.revision}, ${row.updatedBy}, NOW())
    `;
    this.createdConfigIds.add(row.id);
    return row.id;
  }

  async deleteUser(id: string): Promise<void> {
    if (!this.createdUserIds.has(id)) throw new Error("Fixture does not own this user");
    await this.database.user.delete({ where: { id } });
    this.createdUserIds.delete(id);
  }

  async updateUserId(id: string): Promise<string> {
    if (!this.createdUserIds.has(id)) throw new Error("Fixture does not own this user");
    const row = await this.database.user.update({
      where: { id },
      data: { id: randomUUID() },
    });
    this.createdUserIds.delete(id);
    this.createdUserIds.add(row.id);
    return row.id;
  }

  async cleanup(): Promise<void> {
    if (this.createdConfigIds.size > 0) {
      await this.database.systemConfig.deleteMany({
        where: { id: { in: [...this.createdConfigIds] } },
      });
      this.createdConfigIds.clear();
    }
    if (this.createdUserIds.size > 0) {
      await this.database.user.deleteMany({
        where: { id: { in: [...this.createdUserIds] } },
      });
      this.createdUserIds.clear();
    }
  }
}
