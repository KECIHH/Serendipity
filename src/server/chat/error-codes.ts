import "server-only";

export const CHAT_ERROR_CODES = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "AUTH_REQUIRED",
  "IDEMPOTENCY_KEY_REUSED",
  "FEATURE_DISABLED",
  "CONFIG_ERROR",
  "RATE_LIMITED",
  "COST_LIMIT",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "CANCELLED",
  "RESYNC_REQUIRED",
  "INTERNAL_ERROR",
] as const;
export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number];
const messages: Record<ChatErrorCode, string> = {
  VALIDATION_ERROR: "The command input is invalid.",
  NOT_FOUND: "The requested command or record was not found.",
  AUTH_REQUIRED: "An authenticated owner is required.",
  IDEMPOTENCY_KEY_REUSED: "The idempotency key was already used for different content.",
  FEATURE_DISABLED: "This feature is disabled.",
  CONFIG_ERROR: "Command configuration is unavailable.",
  RATE_LIMITED: "The AI provider is rate limiting requests.",
  COST_LIMIT: "The AI cost limit was reached.",
  PROVIDER_TIMEOUT: "The AI provider timed out.",
  PROVIDER_UNAVAILABLE: "The AI provider is unavailable.",
  CANCELLED: "The command was cancelled.",
  RESYNC_REQUIRED: "Reload persistent messages and command status.",
  INTERNAL_ERROR: "The command could not be processed.",
};
export function isChatErrorCode(value: string): value is ChatErrorCode {
  return (CHAT_ERROR_CODES as readonly string[]).includes(value);
}
export function chatErrorMessage(code: ChatErrorCode): string {
  return messages[code];
}
export class ChatCommandError extends Error {
  constructor(
    readonly code: ChatErrorCode,
    readonly status = 400,
    readonly details?: Record<string, string>,
  ) {
    super(code + ": " + messages[code]);
    this.name = "ChatCommandError";
  }
}
