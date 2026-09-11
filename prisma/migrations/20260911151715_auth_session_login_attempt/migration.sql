-- CreateEnum
CREATE TYPE "AuthSessionStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AuthLoginAttemptStatus" AS ENUM ('RESERVED', 'FAILED', 'SUCCEEDED', 'EXPIRED');

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "audience" VARCHAR(16) NOT NULL,
    "sessionVersion" INTEGER NOT NULL,
    "status" "AuthSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "issuedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthLoginAttempt" (
    "id" TEXT NOT NULL,
    "scope" VARCHAR(16) NOT NULL,
    "ipHash" CHAR(64) NOT NULL,
    "accountHash" CHAR(64) NOT NULL,
    "status" "AuthLoginAttemptStatus" NOT NULL DEFAULT 'RESERVED',
    "reservedUntil" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "requestId" VARCHAR(36) NOT NULL,

    CONSTRAINT "AuthLoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_tokenHash_key" ON "AuthSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthSession_userId_status_expiresAt_id_idx" ON "AuthSession"("userId", "status", "expiresAt", "id");

-- CreateIndex
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthLoginAttempt_requestId_key" ON "AuthLoginAttempt"("requestId");

-- CreateIndex
CREATE INDEX "AuthLoginAttempt_scope_ipHash_createdAt_idx" ON "AuthLoginAttempt"("scope", "ipHash", "createdAt");

-- CreateIndex
CREATE INDEX "AuthLoginAttempt_scope_accountHash_createdAt_idx" ON "AuthLoginAttempt"("scope", "accountHash", "createdAt");

-- CreateIndex
CREATE INDEX "AuthLoginAttempt_status_reservedUntil_id_idx" ON "AuthLoginAttempt"("status", "reservedUntil", "id");

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Append to the Prisma-generated migration before its first application.
-- The application role may execute this clock but cannot replace it or issue DDL.
-- Only the owner of an isolated fixture database may install a deterministic clock.
CREATE FUNCTION public.auth_now() RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT statement_timestamp();
$$;

ALTER TABLE "AuthSession"
  ADD CONSTRAINT "AuthSession_identity" CHECK (
    id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND "tokenHash"::text ~ '^[0-9a-f]{64}$'
    AND audience IN ('USER', 'ADMIN') AND "sessionVersion" >= 0
  ),
  ADD CONSTRAINT "AuthSession_time_bounds" CHECK (
    isfinite("issuedAt") AND isfinite("expiresAt") AND isfinite("createdAt")
    AND "createdAt" <= "issuedAt"
    AND "expiresAt" > "issuedAt" AND "expiresAt" <= "issuedAt" + INTERVAL '12 hours'
    AND ("lastSeenAt" IS NULL OR (isfinite("lastSeenAt") AND "lastSeenAt" >= "issuedAt" AND "lastSeenAt" < "expiresAt"))
    AND ("revokedAt" IS NULL OR (isfinite("revokedAt") AND "revokedAt" >= "issuedAt"))
    AND ((status = 'REVOKED') = ("revokedAt" IS NOT NULL))
  );

ALTER TABLE "AuthLoginAttempt"
  ADD CONSTRAINT "AuthLoginAttempt_identity" CHECK (
    id ~ '^[A-Za-z0-9_-]{1,128}$' AND scope IN ('LOGIN', 'REGISTER')
    AND "ipHash"::text ~ '^[0-9a-f]{64}$' AND "accountHash"::text ~ '^[0-9a-f]{64}$'
    AND "requestId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  ADD CONSTRAINT "AuthLoginAttempt_time_bounds" CHECK (
    isfinite("createdAt") AND isfinite("reservedUntil")
    AND "reservedUntil" > "createdAt" AND "reservedUntil" <= "createdAt" + INTERVAL '60 seconds'
    AND ((status = 'RESERVED') = ("completedAt" IS NULL))
    AND ("completedAt" IS NULL OR (isfinite("completedAt") AND "completedAt" >= "createdAt"))
    AND (status NOT IN ('FAILED', 'SUCCEEDED') OR "completedAt" < "reservedUntil")
    AND (status <> 'EXPIRED' OR "completedAt" >= "reservedUntil")
  );

CREATE FUNCTION public.protect_auth_session() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE current_clock TIMESTAMPTZ := public.auth_now();
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Authentication history cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE' OR NEW."issuedAt" > current_clock OR NEW."expiresAt" <= current_clock
       OR NEW."createdAt" > current_clock OR NEW."revokedAt" IS NOT NULL OR NEW."lastSeenAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A session must begin active at the database clock';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'ACTIVE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A terminal session is immutable';
  END IF;
  IF ROW(NEW.id, NEW."userId", NEW."tokenHash", NEW.audience, NEW."sessionVersion", NEW."issuedAt", NEW."expiresAt", NEW."createdAt")
     IS DISTINCT FROM ROW(OLD.id, OLD."userId", OLD."tokenHash", OLD.audience, OLD."sessionVersion", OLD."issuedAt", OLD."expiresAt", OLD."createdAt") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Session identity and absolute lifetime are immutable';
  END IF;
  IF NEW.status = 'EXPIRED' AND current_clock < OLD."expiresAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Session expiry requires the database deadline';
  END IF;
  IF NEW."revokedAt" IS NOT NULL AND NEW."revokedAt" > current_clock THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Session revocation cannot be future dated';
  END IF;
  IF NEW."lastSeenAt" IS DISTINCT FROM OLD."lastSeenAt" AND
     (NEW."lastSeenAt" IS NULL OR NEW."lastSeenAt" > current_clock OR
       (OLD."lastSeenAt" IS NOT NULL AND NEW."lastSeenAt" < OLD."lastSeenAt")) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Session activity must advance within its absolute lifetime';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.protect_auth_login_attempt() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE current_clock TIMESTAMPTZ := public.auth_now();
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Authentication history cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'RESERVED' OR NEW."completedAt" IS NOT NULL
       OR NEW."createdAt" > current_clock OR NEW."reservedUntil" <= current_clock THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An attempt must begin as a live reservation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'RESERVED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A completed login attempt is immutable';
  END IF;
  IF ROW(NEW.id, NEW.scope, NEW."ipHash", NEW."accountHash", NEW."requestId", NEW."createdAt", NEW."reservedUntil")
     IS DISTINCT FROM ROW(OLD.id, OLD.scope, OLD."ipHash", OLD."accountHash", OLD."requestId", OLD."createdAt", OLD."reservedUntil") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Login reservation identity and deadline are immutable';
  END IF;
  IF NEW.status = 'RESERVED' OR NEW."completedAt" IS NULL OR NEW."completedAt" > current_clock THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A reservation may only settle once at the database clock';
  END IF;
  IF (NEW.status = 'EXPIRED' AND current_clock < OLD."reservedUntil")
     OR (NEW.status IN ('FAILED', 'SUCCEEDED') AND current_clock >= OLD."reservedUntil") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Login settlement must respect its reservation deadline';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AuthSession_lifecycle" BEFORE INSERT OR UPDATE OR DELETE ON "AuthSession"
FOR EACH ROW EXECUTE FUNCTION public.protect_auth_session();
CREATE TRIGGER "AuthSession_no_truncate" BEFORE TRUNCATE ON "AuthSession"
FOR EACH STATEMENT EXECUTE FUNCTION public.protect_auth_session();
CREATE TRIGGER "AuthLoginAttempt_lifecycle" BEFORE INSERT OR UPDATE OR DELETE ON "AuthLoginAttempt"
FOR EACH ROW EXECUTE FUNCTION public.protect_auth_login_attempt();
CREATE TRIGGER "AuthLoginAttempt_no_truncate" BEFORE TRUNCATE ON "AuthLoginAttempt"
FOR EACH STATEMENT EXECUTE FUNCTION public.protect_auth_login_attempt();

REVOKE ALL ON FUNCTION public.auth_now() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_auth_session() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_auth_login_attempt() FROM PUBLIC;
REVOKE ALL ON TABLE "AuthSession", "AuthLoginAttempt" FROM PUBLIC;
