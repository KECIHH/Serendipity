-- CreateEnum
CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'DISABLED', 'REVOKED');

-- CreateTable
CREATE TABLE "ApiKeyConfig" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "encryptionKeyId" TEXT NOT NULL,
    "envelopeVersion" INTEGER NOT NULL DEFAULT 1,
    "keyFingerprint" CHAR(64) NOT NULL,
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ApiKeyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiKeyConfig_keyFingerprint_key" ON "ApiKeyConfig"("keyFingerprint");

-- CreateIndex
CREATE INDEX "ApiKeyConfig_provider_status_idx" ON "ApiKeyConfig"("provider", "status");

-- Added to the generated migration before its first application.
CREATE FUNCTION public.api_key_base64_valid(value TEXT, minimum_bytes INTEGER, maximum_bytes INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS $$
DECLARE decoded BYTEA;
BEGIN
  IF length(value) = 0 OR length(value) > 21848 OR length(value) % 4 <> 0
     OR value !~ '^[A-Za-z0-9+/]+={0,2}$' THEN RETURN FALSE; END IF;
  decoded := decode(value, 'base64');
  RETURN octet_length(decoded) BETWEEN minimum_bytes AND maximum_bytes
     AND replace(encode(decoded, 'base64'), E'\n', '') = value;
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END;
$$;

CREATE FUNCTION public.api_key_envelope_v1_valid(value TEXT, key_id TEXT, envelope_version INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS $$
DECLARE envelope JSONB; canonical TEXT;
BEGIN
  IF octet_length(value) > 22500 OR envelope_version <> 1 OR key_id !~ '^[0-9a-f]{64}$' THEN RETURN FALSE; END IF;
  envelope := value::jsonb;
  IF jsonb_typeof(envelope) IS DISTINCT FROM 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(envelope)) <> 6
     OR jsonb_typeof(envelope->'version') IS DISTINCT FROM 'number'
     OR envelope->>'version' IS DISTINCT FROM '1'
     OR envelope->>'algorithm' IS DISTINCT FROM 'A256GCM'
     OR envelope->>'keyId' IS DISTINCT FROM key_id
     OR jsonb_typeof(envelope->'iv') IS DISTINCT FROM 'string'
     OR jsonb_typeof(envelope->'tag') IS DISTINCT FROM 'string'
     OR jsonb_typeof(envelope->'ciphertext') IS DISTINCT FROM 'string'
     OR public.api_key_base64_valid(envelope->>'iv', 12, 12) IS NOT TRUE
     OR public.api_key_base64_valid(envelope->>'tag', 16, 16) IS NOT TRUE
     OR public.api_key_base64_valid(envelope->>'ciphertext', 1, 16384) IS NOT TRUE
  THEN RETURN FALSE; END IF;
  -- All six fields are constrained to ASCII literals, hex or base64. This is exact RFC8785 JCS.
  canonical := '{"algorithm":"A256GCM","ciphertext":"' || (envelope->>'ciphertext') ||
    '","iv":"' || (envelope->>'iv') || '","keyId":"' || key_id ||
    '","tag":"' || (envelope->>'tag') || '","version":1}';
  RETURN value = canonical;
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END;
$$;

ALTER TABLE "ApiKeyConfig"
  ADD CONSTRAINT "ApiKeyConfig_fingerprint" CHECK ("keyFingerprint"::text ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "ApiKeyConfig_envelope" CHECK (public.api_key_envelope_v1_valid("encryptedKey", "encryptionKeyId", "envelopeVersion") IS TRUE),
  ADD CONSTRAINT "ApiKeyConfig_revision" CHECK (revision >= 0),
  ADD CONSTRAINT "ApiKeyConfig_revocation" CHECK ((status = 'REVOKED') = ("revokedAt" IS NOT NULL));

CREATE FUNCTION public.protect_api_key_config()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF ROW(NEW.id, NEW.provider, NEW."encryptedKey", NEW."encryptionKeyId", NEW."envelopeVersion", NEW."keyFingerprint", NEW."createdAt")
     IS DISTINCT FROM ROW(OLD.id, OLD.provider, OLD."encryptedKey", OLD."encryptionKeyId", OLD."envelopeVersion", OLD."keyFingerprint", OLD."createdAt")
  THEN RAISE EXCEPTION 'Secret record content is immutable' USING ERRCODE = '23514'; END IF;
  IF OLD.status = 'REVOKED' AND (NEW.status <> 'REVOKED' OR NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt")
  THEN RAISE EXCEPTION 'Revocation is irreversible' USING ERRCODE = '23514'; END IF;
  IF NEW.revision::bigint <> OLD.revision::bigint +
      CASE WHEN ROW(NEW.name, NEW.status) IS DISTINCT FROM ROW(OLD.name, OLD.status) THEN 1 ELSE 0 END
  THEN RAISE EXCEPTION 'Secret revision must match the actual change' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ApiKeyConfig_immutable_lifecycle" BEFORE UPDATE ON "ApiKeyConfig"
FOR EACH ROW EXECUTE FUNCTION public.protect_api_key_config();
