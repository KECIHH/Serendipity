import "server-only";

import type { Prisma, User } from "@prisma/client";

import { PUBLIC_USER_FIELDS } from "@/server/projections/public-user";

// Consumers must establish ADMIN authorization before selecting this projection.
export const ADMIN_USER_FIELDS = [
  ...PUBLIC_USER_FIELDS,
  "revision",
] as const satisfies readonly (keyof User)[];

export type AdminUser = Pick<User, (typeof ADMIN_USER_FIELDS)[number]>;

export const ADMIN_USER_SELECT = Object.freeze(
  Object.fromEntries(ADMIN_USER_FIELDS.map((field) => [field, true])) as {
    readonly [Field in (typeof ADMIN_USER_FIELDS)[number]]: true;
  },
) satisfies Prisma.UserSelect;
