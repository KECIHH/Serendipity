import "server-only";

import { fail, type ApiErrorCode } from "@/lib/api-response";
import { DatabaseUnavailableError } from "@/server/db";
import { CookieRequestError } from "@/server/auth/cookie";
import { ChatCommandError } from "@/server/chat/error-codes";

const statusByCode: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_KEY_REUSED: 409,
  VERSION_CONFLICT: 409,
  PLANNING_IN_PROGRESS: 409,
  USE_PLAN_MUTATION: 409,
  REQUIREMENT_CONFIRMATION_REQUIRED: 409,
  RESYNC_REQUIRED: 410,
  FEATURE_DISABLED: 503,
  CONFIG_ERROR: 503,
  RATE_LIMITED: 429,
  COST_LIMIT: 429,
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_TIMEOUT: 503,
  CANCELLED: 409,
  INTERNAL_ERROR: 500,
  OPERATION_NOT_AVAILABLE: 409,
  CONFIRMATION_EXPIRED: 410,
  REVALIDATION_REQUIRED: 409,
};

const safeMessage: Partial<Record<ApiErrorCode, string>> = {
  VALIDATION_ERROR: "请求参数无效",
  AUTH_REQUIRED: "需要有效的会话",
  FORBIDDEN: "请求验证失败",
  NOT_FOUND: "请求的资源不存在",
  IDEMPOTENCY_KEY_REUSED: "幂等键已用于不同内容",
  CONFIG_ERROR: "服务配置不可用",
  RATE_LIMITED: "请求过于频繁",
  COST_LIMIT: "已达到费用上限",
  PROVIDER_TIMEOUT: "模型服务超时",
  PROVIDER_UNAVAILABLE: "模型服务暂不可用",
  FEATURE_DISABLED: "该功能暂不可用",
  CANCELLED: "命令已取消",
  INTERNAL_ERROR: "服务暂时不可用",
};

export class PlanDraftError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status = statusByCode[code],
    readonly details?: Record<string, string>,
  ) {
    super(code);
    this.name = "PlanDraftError";
  }
}

export function planErrorResponse(error: unknown, requestId: string): Response {
  const known = error instanceof PlanDraftError ? error.code : errorCode(error);
  const status =
    error instanceof PlanDraftError
      ? error.status
      : error instanceof ChatCommandError
        ? error.status
        : error instanceof CookieRequestError
          ? error.status
          : statusByCode[known];
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (status === 429) headers["retry-after"] = "1";
  return Response.json(
    fail(
      known,
      safeMessage[known] ?? "服务暂时不可用",
      requestId,
      error instanceof PlanDraftError ? error.details : undefined,
    ),
    { status, headers },
  );
}

function errorCode(error: unknown): ApiErrorCode {
  if (error instanceof CookieRequestError) return "FORBIDDEN";
  if (error instanceof DatabaseUnavailableError) return "INTERNAL_ERROR";
  if (error instanceof ChatCommandError && error.code in statusByCode)
    return error.code as ApiErrorCode;
  if (error instanceof SyntaxError) return "VALIDATION_ERROR";
  if (error instanceof Error && error.message in statusByCode) return error.message as ApiErrorCode;
  return "INTERNAL_ERROR";
}
