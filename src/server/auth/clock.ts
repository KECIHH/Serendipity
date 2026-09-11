import "server-only";

import type { Prisma } from "@prisma/client";
import { AuthUnavailableError } from "@/server/auth/errors";

export const AUTH_SESSION_MAX_AGE_SECONDS = 43_200;
export const LOGIN_WINDOW_SECONDS = 900;
export const LOGIN_RESERVATION_SECONDS = 60;
export const LOGIN_ACCOUNT_LIMIT = 5;
export const LOGIN_IP_LIMIT = 20;

/** The owner may replace auth_now only in an isolated database fixture. No request clock exists. */
export async function readAuthClock(client: Prisma.TransactionClient): Promise<Date> {
  try {
    const rows = await client.$queryRaw<Array<{ now: Date }>>`SELECT public.auth_now() AS now`;
    const now = rows[0]?.now;
    if (rows.length !== 1 || !(now instanceof Date) || !Number.isFinite(now.getTime()))
      throw new AuthUnavailableError();
    return now;
  } catch {
    throw new AuthUnavailableError();
  }
}
