import type { Role, User, UserStatus } from "@prisma/client";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type GeneratedUserContract = [
  Assert<Equal<Role, "USER" | "ADMIN">>,
  Assert<Equal<UserStatus, "ACTIVE" | "DISABLED">>,
  Assert<Equal<User["revision"], number>>,
  Assert<Equal<User["sessionVersion"], number>>,
  Assert<Equal<User["email"], string>>,
  Assert<Equal<User["passwordHash"], string>>,
  Assert<Equal<User["lastLoginAt"], Date | null>>,
  Assert<
    Equal<
      keyof User,
      | "id"
      | "email"
      | "phone"
      | "name"
      | "avatarUrl"
      | "passwordHash"
      | "role"
      | "status"
      | "sessionVersion"
      | "revision"
      | "lastLoginAt"
      | "createdAt"
      | "updatedAt"
    >
  >,
];
