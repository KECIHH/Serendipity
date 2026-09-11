/** Only fixed safe classifications cross an authentication boundary. */
export class AuthAuthorizationError extends Error {
  constructor(
    readonly status: 401 | 403 = 401,
    readonly code: "AUTH_REQUIRED" | "FORBIDDEN" = "AUTH_REQUIRED",
  ) {
    super(status === 401 ? "Authentication is required." : "Access is forbidden.");
    this.name = "AuthAuthorizationError";
  }
}

export class AuthUnavailableError extends Error {
  readonly status = 503;
  readonly code = "AUTH_UNAVAILABLE";

  constructor() {
    super("Authentication is temporarily unavailable.");
    this.name = "AuthUnavailableError";
  }
}
