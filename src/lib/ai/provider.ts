export type AiErrorCode =
  | "FEATURE_DISABLED"
  | "CONFIG_ERROR"
  | "RATE_LIMITED"
  | "COST_LIMIT"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "CANCELLED";

export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ProviderRequest {
  readonly system: string;
  readonly userMessage: string;
  readonly maxOutputTokens: number;
  readonly responseFormat: "json";
  readonly temperature?: number;
  readonly userData?: string;
}

export interface ProviderSuccess {
  readonly ok: true;
  readonly output: string;
  readonly usage: ProviderUsage;
  readonly durationMs: number;
  readonly providerRequestId?: string;
  readonly receivedByte: true;
}

export interface ProviderFailure {
  readonly ok: false;
  readonly errorCode: Exclude<AiErrorCode, "FEATURE_DISABLED" | "COST_LIMIT">;
  readonly retryable: boolean;
  readonly receivedByte: boolean;
  readonly durationMs: number;
  readonly providerRequestId?: string;
  readonly retryAfterMs?: number;
  readonly definitelyNotSent?: boolean;
  readonly internalCode?: "INVALID_JSON" | "SCHEMA_MISMATCH";
}

export type ProviderResult = ProviderSuccess | ProviderFailure;

export interface ProviderCallContext {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  /** Best-effort display only. A chunk is never a validated final response. */
  readonly onDelta?: (text: string) => Promise<void>;
}

export interface ProviderAdapter {
  readonly id: string;
  prepare?(context: ProviderCallContext): Promise<void>;
  complete(request: ProviderRequest, context: ProviderCallContext): Promise<ProviderResult>;
}

export interface ProviderSnapshot {
  readonly providerId: string;
  readonly configVersion: number;
  readonly mode: "MOCK" | "LIVE";
  readonly baseUrl: string;
  readonly timeoutMs: number;
}
