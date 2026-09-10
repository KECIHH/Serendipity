const apiErrorCodes = [
  "VALIDATION_ERROR",
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "IDEMPOTENCY_KEY_REUSED",
  "VERSION_CONFLICT",
  "PLANNING_IN_PROGRESS",
  "USE_PLAN_MUTATION",
  "REQUIREMENT_CONFIRMATION_REQUIRED",
  "RESYNC_REQUIRED",
  "FEATURE_DISABLED",
  "CONFIG_ERROR",
  "RATE_LIMITED",
  "COST_LIMIT",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "CANCELLED",
  "INTERNAL_ERROR",
  "OPERATION_NOT_AVAILABLE",
  "CONFIRMATION_EXPIRED",
  "REVALIDATION_REQUIRED",
] as const;

export type ApiErrorCode = (typeof apiErrorCodes)[number];

export type ApiError = {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
};

export type ApiResponse<T> =
  | { success: true; data: T; requestId: string }
  | { success: false; error: ApiError; requestId: string };

const knownErrorCodes: ReadonlySet<string> = new Set(apiErrorCodes);

function assertRequestId(requestId: string): void {
  if (typeof requestId !== "string" || requestId.trim().length === 0) {
    throw new TypeError("requestId must be supplied by the caller.");
  }
}

export function ok<T>(data: T, requestId: string): ApiResponse<T> {
  assertRequestId(requestId);
  if (data === undefined) throw new TypeError("A successful response must have defined data.");
  return { success: true, data, requestId };
}

export function fail(
  code: ApiErrorCode,
  message: string,
  requestId: string,
  details?: unknown,
): ApiResponse<never> {
  assertRequestId(requestId);
  if (!knownErrorCodes.has(code) || typeof message !== "string") {
    throw new TypeError("Expected a public API error code and a safe message.");
  }
  const error: ApiError = details === undefined ? { code, message } : { code, message, details };
  return { success: false, error, requestId };
}

export function isApiError(value: unknown): value is ApiError {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (!Object.hasOwn(value, "code") || !Object.hasOwn(value, "message")) return false;
  const error = value as Record<string, unknown>;
  return (
    Reflect.ownKeys(error).every(
      (key) => key === "code" || key === "message" || key === "details",
    ) &&
    typeof error.code === "string" &&
    knownErrorCodes.has(error.code) &&
    typeof error.message === "string"
  );
}
