export type AuthAudience = "ADMIN" | "USER";
export type AuthScope = "LOGIN" | "REGISTER";

/** Safe server principal: no credential digest, session version or raw token. */
export interface AuthPrincipal {
  readonly id: string;
  readonly email: string;
  readonly role: "ADMIN" | "USER";
  readonly audience: AuthAudience;
  readonly expiresAt: Date;
}

export interface CredentialsInput {
  readonly email: unknown;
  readonly password: unknown;
  readonly audience: AuthAudience;
  /** Already authenticated by the trusted Node ingress, never copied from a request header. */
  readonly clientAddress: string;
}

export interface IssuedAuthSession {
  readonly opaqueToken: string;
  readonly userId: string;
  readonly audience: AuthAudience;
  readonly expiresAt: Date;
}

export type CredentialsResult =
  | { readonly kind: "SUCCESS"; readonly session: IssuedAuthSession }
  | { readonly kind: "INVALID_CREDENTIALS" }
  | { readonly kind: "RATE_LIMITED"; readonly retryAfter: number }
  | { readonly kind: "UNAVAILABLE" };

export interface LoginIdentity {
  readonly scope: AuthScope;
  readonly ipHash: string;
  readonly accountHash: string;
}

export interface LoginReservation extends LoginIdentity {
  readonly id: string;
  readonly requestId: string;
  readonly reservedUntil: Date;
}

export type LoginAdmission =
  | { readonly kind: "RESERVED"; readonly reservation: LoginReservation }
  | {
      readonly kind: "RATE_LIMITED";
      readonly retryAfter: number;
      readonly identity: LoginIdentity;
    };

export type LoginFailureReason =
  | "UNKNOWN_ACCOUNT"
  | "PASSWORD_MISMATCH"
  | "ROLE_NOT_ALLOWED"
  | "ACCOUNT_DISABLED"
  | "STATE_CHANGED";
