import "server-only";

import type { Prisma, User } from "@prisma/client";

export const PUBLIC_USER_FIELDS = [
  "id",
  "email",
  "name",
  "avatarUrl",
  "role",
  "status",
  "lastLoginAt",
  "createdAt",
  "sessionVersion",
] as const satisfies readonly (keyof User)[];

export type PublicUser = Pick<User, (typeof PUBLIC_USER_FIELDS)[number]>;

export const PUBLIC_USER_SELECT = Object.freeze(
  Object.fromEntries(PUBLIC_USER_FIELDS.map((field) => [field, true])) as {
    readonly [Field in (typeof PUBLIC_USER_FIELDS)[number]]: true;
  },
) satisfies Prisma.UserSelect;
