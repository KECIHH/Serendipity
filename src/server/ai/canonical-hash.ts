import "server-only";
import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/ai/canonical-json";

/** Preserve the Phase015 governance hash protocol, including its terminal LF. */
export function canonicalHash(value: unknown): string {
  return createHash("sha256")
    .update(`${canonicalJson(value)}\n`, "utf8")
    .digest("hex");
}

/** Requirement snapshots use RFC8785 bytes without the governance protocol's LF. */
export function requirementHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
