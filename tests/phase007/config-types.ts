import type { Prisma, SystemConfig, User } from "@prisma/client";
import type { SystemConfigGroup } from "@/lib/schemas/system-config";
import type { AdminUser, ADMIN_USER_SELECT } from "@/server/projections/admin-user";
import type { PublicUser, PUBLIC_USER_SELECT } from "@/server/projections/public-user";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type PublicFields =
  | "id"
  | "email"
  | "name"
  | "avatarUrl"
  | "role"
  | "status"
  | "lastLoginAt"
  | "createdAt";

export type GeneratedConfigAndProjectionContract = [
  Assert<Equal<PublicUser, Pick<User, PublicFields>>>,
  Assert<Equal<AdminUser, Pick<User, PublicFields | "revision">>>,
  Assert<Equal<Prisma.UserGetPayload<{ select: typeof PUBLIC_USER_SELECT }>, PublicUser>>,
  Assert<Equal<Prisma.UserGetPayload<{ select: typeof ADMIN_USER_SELECT }>, AdminUser>>,
  Assert<Equal<keyof typeof PUBLIC_USER_SELECT, PublicFields>>,
  Assert<Equal<keyof typeof ADMIN_USER_SELECT, PublicFields | "revision">>,
  Assert<Equal<SystemConfigGroup, "AI" | "UI" | "EXPORT" | "SECURITY" | "GENERAL">>,
  Assert<Equal<SystemConfig["group"], string>>,
  Assert<Equal<SystemConfig["valueJson"], Prisma.JsonValue>>,
  Assert<Equal<SystemConfig["description"], string>>,
  Assert<Equal<SystemConfig["isPublic"], boolean>>,
  Assert<Equal<SystemConfig["revision"], number>>,
  Assert<Equal<SystemConfig["updatedBy"], string | null>>,
  Assert<Equal<SystemConfig["createdAt"], Date>>,
  Assert<Equal<SystemConfig["updatedAt"], Date>>,
  Assert<
    Equal<
      keyof SystemConfig,
      | "id"
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
  >,
];
