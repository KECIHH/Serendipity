import "server-only";

import { normalizeEmailV1 } from "@/server/auth";
import type { EnvValue } from "@/lib/env-schema";

export type SeedErrorCode =
  | "INVALID_INPUT"
  | "UNSAFE_TARGET"
  | "MIGRATION_DRIFT"
  | "EXISTING_DATA_CONFLICT"
  | "RETRY_EXHAUSTED"
  | "DATABASE_FAILURE";
export class SeedError extends Error {
  constructor(readonly code: SeedErrorCode) {
    super(`Seed refused: ${code}.`);
    this.name = "SeedError";
  }
}

export const SEED_SOURCE_MARKER = "PHASE010_BASE_SEED_V1";
export const SEED_CONFIG_DEFAULTS = Object.freeze([
  Object.freeze({
    key: "planner.quick.defaultDurationDays",
    valueJson: 3,
    description: "默认快速规划天数",
    group: "GENERAL",
    isPublic: false,
  }),
  Object.freeze({
    key: "planner.quick.defaultTravelerCount",
    valueJson: 1,
    description: "默认快速规划人数",
    group: "GENERAL",
    isPublic: false,
  }),
  Object.freeze({
    key: "planner.quick.defaultPace",
    valueJson: "moderate",
    description: "默认快速规划节奏",
    group: "GENERAL",
    isPublic: false,
  }),
] as const);
export const SEED_RETRY_DELAYS_MS = Object.freeze([25, 50, 100] as const);

export interface SeedInput {
  databaseUrl: string;
  database: string;
  databaseRole: string;
  databaseMarker: string;
  seedRunId: string;
  email: string;
  password: string;
}

export function parseSeedInput(env: Readonly<Record<string, EnvValue>>): SeedInput {
  // This guard must execute before any client is constructed or database is contacted.
  if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test")
    throw new SeedError("UNSAFE_TARGET");
  let url: URL;
  try {
    if (typeof env.DATABASE_URL !== "string") throw new Error();
    url = new URL(env.DATABASE_URL);
  } catch {
    throw new SeedError("UNSAFE_TARGET");
  }
  const match = /^\/(phase[0-9]{3}|serendipity)_disposable_([0-9a-f]{12})(?:_[a-z0-9_]+)?$/.exec(
    url.pathname,
  );
  if (
    !match ||
    url.pathname.length > 64 ||
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    Number(url.port) < 1 ||
    url.hash ||
    !/^[a-z_][a-z0-9_]*$/.test(url.username) ||
    !url.password ||
    [...url.searchParams.keys()].some(
      (key) => !["connect_timeout", "pool_timeout", "connection_limit"].includes(key),
    ) ||
    [...url.searchParams.keys()].some(
      (key) =>
        url.searchParams.getAll(key).length !== 1 ||
        !/^[1-9][0-9]{0,2}$/.test(url.searchParams.get(key) ?? ""),
    )
  )
    throw new SeedError("UNSAFE_TARGET");
  let email: string;
  try {
    if (typeof env.ADMIN_EMAIL !== "string") throw new Error();
    email = normalizeEmailV1(env.ADMIN_EMAIL);
  } catch {
    throw new SeedError("INVALID_INPUT");
  }
  const password = env.ADMIN_INITIAL_PASSWORD;
  if (
    typeof password !== "string" ||
    !password.isWellFormed() ||
    Buffer.byteLength(password, "utf8") < 12 ||
    Buffer.byteLength(password, "utf8") > 72 ||
    /[\u0000-\u001f\u007f]/.test(password) ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/[0-9]/.test(password) ||
    !/[^A-Za-z0-9\s]/.test(password)
  )
    throw new SeedError("INVALID_INPUT");
  return {
    databaseUrl: url.toString(),
    database: url.pathname.slice(1),
    databaseRole: url.username,
    databaseMarker: `serendipity-${match[1]}-disposable:${match[2]}`,
    seedRunId: `${match[1]}_${match[2]}`,
    email,
    password,
  };
}
