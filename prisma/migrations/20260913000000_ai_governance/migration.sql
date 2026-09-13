-- CreateEnum
CREATE TYPE "ProviderMode" AS ENUM ('MOCK', 'LIVE');
-- CreateEnum
CREATE TYPE "CredentialRequirement" AS ENUM ('NONE', 'REQUIRED');
-- CreateEnum
CREATE TYPE "PromptModelActivationStatus" AS ENUM ('ACTIVE', 'DISABLED');
-- CreateEnum
CREATE TYPE "AiOutputStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'CANCELLED');
-- CreateEnum
CREATE TYPE "AiReservationStatus" AS ENUM ('RESERVED', 'RECONCILING', 'SETTLED', 'RELEASED');
-- CreateEnum
CREATE TYPE "AiSubmissionState" AS ENUM ('NOT_SENT', 'MAY_HAVE_BEEN_SENT', 'ACCEPTED');
-- CreateTable
CREATE TABLE "PromptDefinition" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "purpose" VARCHAR(256) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PromptDefinition_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "variablesJson" JSONB NOT NULL,
    "responseSchemaVersion" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "PromptActivation" (
    "definitionId" TEXT NOT NULL,
    "championVersionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "PromptActivation_pkey" PRIMARY KEY ("definitionId")
);
-- CreateTable
CREATE TABLE "ModelDeployment" (
    "id" TEXT NOT NULL,
    "configVersion" INTEGER NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerModelName" VARCHAR(128) NOT NULL,
    "paramsJson" JSONB NOT NULL,
    "capabilitiesJson" JSONB NOT NULL,
    "contextWindowTokens" INTEGER NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "providerConfigVersion" INTEGER NOT NULL,
    CONSTRAINT "ModelDeployment_pkey" PRIMARY KEY ("id","configVersion")
);
-- CreateTable
CREATE TABLE "ProviderConfigVersion" (
    "providerId" TEXT NOT NULL,
    "configVersion" INTEGER NOT NULL,
    "mode" "ProviderMode" NOT NULL,
    "baseUrl" VARCHAR(512) NOT NULL,
    "capabilities" JSONB NOT NULL,
    "timeoutMs" INTEGER NOT NULL,
    "maxRetries" INTEGER NOT NULL,
    "quotaTokensPerDay" INTEGER NOT NULL,
    "costLimitPerDay" DECIMAL(18,8) NOT NULL,
    "region" VARCHAR(64) NOT NULL,
    "locale" VARCHAR(35) NOT NULL,
    "credentialRequirement" "CredentialRequirement" NOT NULL,
    "secretRef" TEXT,
    "contentHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderConfigVersion_pkey" PRIMARY KEY ("providerId","configVersion")
);
-- CreateTable
CREATE TABLE "PromptModelActivation" (
    "definitionId" TEXT NOT NULL,
    "promptVersionId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "deploymentConfigVersion" INTEGER NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerConfigVersion" INTEGER NOT NULL,
    "status" "PromptModelActivationStatus" NOT NULL DEFAULT 'DISABLED',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "PromptModelActivation_pkey" PRIMARY KEY ("definitionId")
);
-- CreateTable
CREATE TABLE "PlanningPolicyVersion" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "contentJson" JSONB NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlanningPolicyVersion_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "PlanningPolicyActivation" (
    "policyKey" VARCHAR(128) NOT NULL,
    "activeVersionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "PlanningPolicyActivation_pkey" PRIMARY KEY ("policyKey")
);
-- CreateTable
CREATE TABLE "AiOutputRecord" (
    "id" TEXT NOT NULL,
    "travelRecordId" TEXT,
    "traceId" VARCHAR(128) NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "promptVersionId" TEXT NOT NULL,
    "activationRevision" INTEGER NOT NULL,
    "planningPolicyVersionId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "deploymentConfigVersion" INTEGER NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerConfigVersion" INTEGER NOT NULL,
    "inputHash" CHAR(64) NOT NULL,
    "outputHash" CHAR(64) NOT NULL,
    "rawOutput" TEXT,
    "parsedOk" BOOLEAN NOT NULL,
    "status" "AiOutputStatus" NOT NULL,
    "errorCode" VARCHAR(64),
    "errorMessage" VARCHAR(256),
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiOutputRecord_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "AiUsageReservation" (
    "id" TEXT NOT NULL,
    "bucketKey" VARCHAR(128) NOT NULL,
    "traceId" VARCHAR(128) NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "estimatedTokens" INTEGER NOT NULL,
    "estimatedCost" DECIMAL(18,8) NOT NULL,
    "actualTokens" INTEGER,
    "actualCost" DECIMAL(18,8),
    "status" "AiReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "submissionState" "AiSubmissionState" NOT NULL DEFAULT 'NOT_SENT',
    "providerRequestId" VARCHAR(128),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMPTZ(3),
    CONSTRAINT "AiUsageReservation_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "PromptDefinition_key_key" ON "PromptDefinition"("key");
-- CreateIndex
CREATE INDEX "PromptDefinition_createdAt_idx" ON "PromptDefinition"("createdAt");
-- CreateIndex
CREATE INDEX "PromptVersion_createdAt_idx" ON "PromptVersion"("createdAt");
-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_definitionId_version_key" ON "PromptVersion"("definitionId", "version");
-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_definitionId_contentHash_key" ON "PromptVersion"("definitionId", "contentHash");
-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_definitionId_id_key" ON "PromptVersion"("definitionId", "id");
-- CreateIndex
CREATE INDEX "PromptActivation_updatedById_updatedAt_idx" ON "PromptActivation"("updatedById", "updatedAt");
-- CreateIndex
CREATE INDEX "ModelDeployment_providerId_createdAt_idx" ON "ModelDeployment"("providerId", "createdAt");
-- CreateIndex
CREATE INDEX "ModelDeployment_createdById_idx" ON "ModelDeployment"("createdById");
-- CreateIndex
CREATE INDEX "ProviderConfigVersion_mode_createdAt_idx" ON "ProviderConfigVersion"("mode", "createdAt");
-- CreateIndex
CREATE INDEX "ProviderConfigVersion_secretRef_idx" ON "ProviderConfigVersion"("secretRef");
-- CreateIndex
CREATE INDEX "PromptModelActivation_status_updatedAt_idx" ON "PromptModelActivation"("status", "updatedAt");
-- CreateIndex
CREATE INDEX "PromptModelActivation_updatedById_updatedAt_idx" ON "PromptModelActivation"("updatedById", "updatedAt");
-- CreateIndex
CREATE INDEX "PromptModelActivation_providerId_providerConfigVersion_idx" ON "PromptModelActivation"("providerId", "providerConfigVersion");
-- CreateIndex
CREATE UNIQUE INDEX "PlanningPolicyVersion_version_key" ON "PlanningPolicyVersion"("version");
-- CreateIndex
CREATE INDEX "PlanningPolicyVersion_createdAt_idx" ON "PlanningPolicyVersion"("createdAt");
-- CreateIndex
CREATE UNIQUE INDEX "PlanningPolicyActivation_activeVersionId_key" ON "PlanningPolicyActivation"("activeVersionId");
-- CreateIndex
CREATE INDEX "AiOutputRecord_createdAt_idx" ON "AiOutputRecord"("createdAt");
-- CreateIndex
CREATE INDEX "AiOutputRecord_travelRecordId_createdAt_idx" ON "AiOutputRecord"("travelRecordId", "createdAt");
-- CreateIndex
CREATE UNIQUE INDEX "AiOutputRecord_traceId_attemptNo_key" ON "AiOutputRecord"("traceId", "attemptNo");
-- CreateIndex
CREATE INDEX "AiUsageReservation_bucketKey_status_createdAt_idx" ON "AiUsageReservation"("bucketKey", "status", "createdAt");
-- CreateIndex
CREATE INDEX "AiUsageReservation_expiresAt_status_idx" ON "AiUsageReservation"("expiresAt", "status");
-- CreateIndex
CREATE UNIQUE INDEX "AiUsageReservation_traceId_attemptNo_key" ON "AiUsageReservation"("traceId", "attemptNo");
-- AddForeignKey
ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "PromptDefinition"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- AddForeignKey
ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
-- AddForeignKey
ALTER TABLE "PromptActivation" ADD CONSTRAINT "PromptActivation_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "PromptDefinition"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- AddForeignKey
ALTER TABLE "PromptActivation" ADD CONSTRAINT "PromptActivation_definitionId_championVersionId_fkey" FOREIGN KEY ("definitionId", "championVersionId") REFERENCES "PromptVersion"("definitionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- AddForeignKey
ALTER TABLE "PromptActivation" ADD CONSTRAINT "PromptActivation_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
-- AddForeignKey
ALTER TABLE "ModelDeployment" ADD CONSTRAINT "ModelDeployment_providerId_providerConfigVersion_fkey" FOREIGN KEY ("providerId", "providerConfigVersion") REFERENCES "ProviderConfigVersion"("providerId", "configVersion") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- AddForeignKey
ALTER TABLE "ModelDeployment" ADD CONSTRAINT "ModelDeployment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
-- AddForeignKey
ALTER TABLE "ProviderConfigVersion" ADD CONSTRAINT "ProviderConfigVersion_secretRef_fkey" FOREIGN KEY ("secretRef") REFERENCES "ApiKeyConfig"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- AddForeignKey
ALTER TABLE "PromptModelActivation" ADD CONSTRAINT "PromptModelActivation_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "PromptDefinition"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- AddForeignKey
ALTER TABLE "PromptModelActivation" ADD CONSTRAINT "PromptModelActivation_definitionId_promptVersionId_fkey" FOREIGN KEY ("definitionId", "promptVersionId") REFERENCES "PromptVersion"("definitionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- AddForeignKey
ALTER TABLE "PromptModelActivation" ADD CONSTRAINT "PromptModelActivation_deploymentId_deploymentConfigVersion_fkey" FOREIGN KEY ("deploymentId", "deploymentConfigVersion") REFERENCES "ModelDeployment"("id", "configVersion") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- AddForeignKey
ALTER TABLE "PromptModelActivation" ADD CONSTRAINT "PromptModelActivation_providerId_providerConfigVersion_fkey" FOREIGN KEY ("providerId", "providerConfigVersion") REFERENCES "ProviderConfigVersion"("providerId", "configVersion") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- AddForeignKey
ALTER TABLE "PromptModelActivation" ADD CONSTRAINT "PromptModelActivation_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
-- AddForeignKey
ALTER TABLE "PlanningPolicyVersion" ADD CONSTRAINT "PlanningPolicyVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
-- AddForeignKey
ALTER TABLE "PlanningPolicyActivation" ADD CONSTRAINT "PlanningPolicyActivation_activeVersionId_fkey" FOREIGN KEY ("activeVersionId") REFERENCES "PlanningPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- AddForeignKey
ALTER TABLE "PlanningPolicyActivation" ADD CONSTRAINT "PlanningPolicyActivation_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
-- AddForeignKey
ALTER TABLE "AiOutputRecord" ADD CONSTRAINT "AiOutputRecord_travelRecordId_fkey" FOREIGN KEY ("travelRecordId") REFERENCES "TravelRecord"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- AddForeignKey
ALTER TABLE "AiOutputRecord" ADD CONSTRAINT "AiOutputRecord_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiOutputRecord" ADD CONSTRAINT "AiOutputRecord_planningPolicyVersionId_fkey" FOREIGN KEY ("planningPolicyVersionId") REFERENCES "PlanningPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- AddForeignKey
ALTER TABLE "AiOutputRecord" ADD CONSTRAINT "AiOutputRecord_deploymentId_deploymentConfigVersion_fkey" FOREIGN KEY ("deploymentId", "deploymentConfigVersion") REFERENCES "ModelDeployment"("id", "configVersion") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- AddForeignKey
ALTER TABLE "AiOutputRecord" ADD CONSTRAINT "AiOutputRecord_providerId_providerConfigVersion_fkey" FOREIGN KEY ("providerId", "providerConfigVersion") REFERENCES "ProviderConfigVersion"("providerId", "configVersion") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Phase015 governance invariants. Immutable rows are append-only; paired prompt
-- activations are checked once at transaction commit so both pointers can move together.
CREATE FUNCTION public.reject_ai_governance_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='AI governance versions are immutable';
END;
$$;

CREATE FUNCTION public.require_paired_prompt_activation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE mismatched INTEGER;
BEGIN
  SELECT count(*) INTO mismatched
  FROM public."PromptActivation" AS prompt
  FULL JOIN public."PromptModelActivation" AS model ON model."definitionId" = prompt."definitionId"
  WHERE prompt."definitionId" IS NULL
     OR model."definitionId" IS NULL
     OR prompt.revision <> model.revision
     OR prompt."championVersionId" <> model."promptVersionId";
  IF mismatched <> 0 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Prompt and model activations must switch atomically';
  END IF;
  RETURN NULL;
END;
$$;

ALTER TABLE "PromptDefinition"
  ADD CONSTRAINT "PromptDefinition_identity" CHECK (id ~ '^[A-Za-z0-9_-]{1,128}$' AND key ~ '^[a-z][a-z0-9_.-]{1,127}$' AND isfinite("createdAt"));

ALTER TABLE "PromptVersion"
  ADD CONSTRAINT "PromptVersion_identity" CHECK (id ~ '^[A-Za-z0-9_-]{1,128}$' AND version >= 1 AND "responseSchemaVersion" >= 1 AND length(content) > 0 AND "contentHash"::text ~ '^[a-f0-9]{64}$' AND isfinite("createdAt"));

ALTER TABLE "ModelDeployment"
  ADD CONSTRAINT "ModelDeployment_identity" CHECK (id ~ '^[A-Za-z0-9_-]{1,128}$' AND "configVersion" >= 1 AND "contextWindowTokens" BETWEEN 1 AND 10000000 AND "contentHash"::text ~ '^[a-f0-9]{64}$' AND isfinite("createdAt"));

ALTER TABLE "ProviderConfigVersion"
  ADD CONSTRAINT "ProviderConfigVersion_identity" CHECK (
    "providerId" ~ '^[A-Za-z0-9_-]{1,128}$' AND "configVersion" >= 1
    AND "timeoutMs" BETWEEN 1000 AND 120000 AND "maxRetries" BETWEEN 0 AND 1
    AND "quotaTokensPerDay" > 0 AND "costLimitPerDay" > 0
    AND "contentHash"::text ~ '^[a-f0-9]{64}$' AND isfinite("createdAt")
    AND ((mode = 'MOCK' AND "baseUrl" = 'https://mock.invalid' AND "credentialRequirement" = 'NONE') OR (mode = 'LIVE' AND "baseUrl" ~ '^https://api\.deepseek\.com(:443)?(/[A-Za-z0-9_/-]*)?$'))
    AND (("credentialRequirement" = 'NONE' AND "secretRef" IS NULL)
      OR ("credentialRequirement" = 'REQUIRED' AND "secretRef" IS NOT NULL))
  );

ALTER TABLE "PromptModelActivation"
  ADD CONSTRAINT "PromptModelActivation_identity" CHECK (revision >= 0);

ALTER TABLE "PlanningPolicyVersion"
  ADD CONSTRAINT "PlanningPolicyVersion_identity" CHECK (version >= 1 AND "contentHash"::text ~ '^[a-f0-9]{64}$' AND isfinite("createdAt"));

ALTER TABLE "PlanningPolicyActivation"
  ADD CONSTRAINT "PlanningPolicyActivation_identity" CHECK ("policyKey" = 'default' AND revision >= 0);

ALTER TABLE "AiOutputRecord"
  ADD CONSTRAINT "AiOutputRecord_identity" CHECK (
    "attemptNo" >= 1 AND "activationRevision" >= 0 AND "inputHash"::text ~ '^[a-f0-9]{64}$' AND "outputHash"::text ~ '^[a-f0-9]{64}$'
    AND "durationMs" >= 0 AND "rawOutput" IS NULL
    AND (("inputTokens" IS NULL AND "outputTokens" IS NULL) OR ("inputTokens" >= 0 AND "outputTokens" >= 0))
  );

ALTER TABLE "AiUsageReservation"
  ADD CONSTRAINT "AiUsageReservation_identity" CHECK (
    "attemptNo" >= 1 AND "estimatedTokens" > 0 AND "estimatedCost" >= 0
    AND ("actualTokens" IS NULL OR "actualTokens" >= 0) AND ("actualCost" IS NULL OR "actualCost" >= 0)
    AND isfinite("expiresAt") AND ("settledAt" IS NULL OR isfinite("settledAt"))
    AND ("status" <> 'RELEASED' OR "submissionState" = 'NOT_SENT')
    AND ("status" <> 'RECONCILING' OR "submissionState" <> 'NOT_SENT')
    AND (("status" IN ('RESERVED','RECONCILING') AND "settledAt" IS NULL) OR
      ("status"='RELEASED' AND "settledAt" IS NOT NULL) OR
      ("status"='SETTLED' AND "settledAt" IS NOT NULL AND "actualTokens" IS NOT NULL
        AND "actualCost" IS NOT NULL AND "actualTokens"<="estimatedTokens" AND "actualCost"<="estimatedCost"))
  );

CREATE FUNCTION public.reject_unknown_ai_reservation_release()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (OLD."status" = 'RECONCILING' OR OLD."submissionState" = 'MAY_HAVE_BEEN_SENT')
     AND (NEW."status" = 'RELEASED' OR NEW."submissionState" = 'NOT_SENT') THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Unknown AI reservation cannot be released';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiUsageReservation_unknown_release_guard" BEFORE UPDATE ON "AiUsageReservation"
FOR EACH ROW EXECUTE FUNCTION public.reject_unknown_ai_reservation_release();

CREATE TRIGGER "PromptDefinition_immutable" BEFORE UPDATE OR DELETE ON "PromptDefinition"
FOR EACH ROW EXECUTE FUNCTION public.reject_ai_governance_mutation();
CREATE TRIGGER "PromptVersion_immutable" BEFORE UPDATE OR DELETE ON "PromptVersion"
FOR EACH ROW EXECUTE FUNCTION public.reject_ai_governance_mutation();
CREATE TRIGGER "ModelDeployment_immutable" BEFORE UPDATE OR DELETE ON "ModelDeployment"
FOR EACH ROW EXECUTE FUNCTION public.reject_ai_governance_mutation();
CREATE TRIGGER "ProviderConfigVersion_immutable" BEFORE UPDATE OR DELETE ON "ProviderConfigVersion"
FOR EACH ROW EXECUTE FUNCTION public.reject_ai_governance_mutation();
CREATE TRIGGER "PlanningPolicyVersion_immutable" BEFORE UPDATE OR DELETE ON "PlanningPolicyVersion"
FOR EACH ROW EXECUTE FUNCTION public.reject_ai_governance_mutation();

CREATE CONSTRAINT TRIGGER "PromptActivation_pair" AFTER INSERT OR UPDATE OR DELETE ON "PromptActivation"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_paired_prompt_activation();
CREATE CONSTRAINT TRIGGER "PromptModelActivation_pair" AFTER INSERT OR UPDATE OR DELETE ON "PromptModelActivation"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_paired_prompt_activation();

CREATE FUNCTION public.require_ai_activation_revision()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AI activation revision must advance exactly once';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PromptActivation_revision" BEFORE UPDATE ON "PromptActivation"
FOR EACH ROW EXECUTE FUNCTION public.require_ai_activation_revision();
CREATE TRIGGER "PromptModelActivation_revision" BEFORE UPDATE ON "PromptModelActivation"
FOR EACH ROW EXECUTE FUNCTION public.require_ai_activation_revision();
CREATE TRIGGER "PlanningPolicyActivation_revision" BEFORE UPDATE ON "PlanningPolicyActivation"
FOR EACH ROW EXECUTE FUNCTION public.require_ai_activation_revision();

CREATE FUNCTION public.require_ai_deployment_provider()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."ModelDeployment" d WHERE d.id=NEW."deploymentId"
    AND d."configVersion"=NEW."deploymentConfigVersion" AND d."providerId"=NEW."providerId"
    AND d."providerConfigVersion"=NEW."providerConfigVersion") THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='AI tuple must reference one complete deployment and provider version';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PromptModelActivation_tuple" BEFORE INSERT OR UPDATE ON "PromptModelActivation"
FOR EACH ROW EXECUTE FUNCTION public.require_ai_deployment_provider();
CREATE TRIGGER "AiOutputRecord_tuple" BEFORE INSERT ON "AiOutputRecord"
FOR EACH ROW EXECUTE FUNCTION public.require_ai_deployment_provider();

CREATE FUNCTION public.require_ai_reservation_transition()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF ROW(NEW.id,NEW."bucketKey",NEW."traceId",NEW."attemptNo",NEW."estimatedTokens",NEW."estimatedCost",NEW."createdAt",NEW."expiresAt") IS DISTINCT FROM
     ROW(OLD.id,OLD."bucketKey",OLD."traceId",OLD."attemptNo",OLD."estimatedTokens",OLD."estimatedCost",OLD."createdAt",OLD."expiresAt") THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Reservation identity and bound are immutable';
  END IF;
  IF OLD.status IN ('SETTLED','RELEASED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Terminal reservation cannot be spent again';
  END IF;
  IF (OLD.status='RECONCILING' AND NEW.status='RESERVED') OR
     (OLD."submissionState"='ACCEPTED' AND NEW."submissionState"<>'ACCEPTED') OR
     (OLD."providerRequestId" IS NOT NULL AND NEW."providerRequestId" IS DISTINCT FROM OLD."providerRequestId") THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Reservation progress and provider proof cannot regress';
  END IF;
  IF NEW.status='SETTLED' AND (NEW."actualCost" IS NULL OR NEW."actualTokens" IS NULL OR NEW."settledAt" IS NULL OR NEW."actualCost">NEW."estimatedCost" OR NEW."actualTokens">NEW."estimatedTokens") THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Settlement must respect its frozen upper bound';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AiUsageReservation_transition" BEFORE UPDATE ON "AiUsageReservation"
FOR EACH ROW EXECUTE FUNCTION public.require_ai_reservation_transition();
