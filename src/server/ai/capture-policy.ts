import "server-only";
import { env } from "@/lib/env";

export interface AiCapturePolicy {
  readonly mode: "SYNTHETIC_DEBUG";
  readonly maxChars: number;
}
export function captureAiOutput(
  output: string | undefined,
  policy: AiCapturePolicy | undefined,
  syntheticMock: boolean,
): string | null {
  if (
    env.NODE_ENV === "production" ||
    !syntheticMock ||
    !policy ||
    policy.mode !== "SYNTHETIC_DEBUG" ||
    !Number.isSafeInteger(policy.maxChars) ||
    policy.maxChars < 1 ||
    policy.maxChars > 1024 ||
    output === undefined
  )
    return null;
  if (
    /(?:authorization|cookie|bearer|encryptedKey|ciphertext|system\s*prompt|\b(?:sk|rk)[-_][A-Za-z0-9_-]{20,})/i.test(
      output,
    )
  )
    return "[REDACTED]";
  return Array.from(output).slice(0, policy.maxChars).join("");
}
