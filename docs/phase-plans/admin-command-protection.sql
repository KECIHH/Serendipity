-- Phase012: append to the generated migration before its first application.
-- This clock is shared with authentication; only disposable database owners may replace it.
ALTER TABLE "AdminCommandReceipt"
  ADD CONSTRAINT "AdminCommandReceipt_identity" CHECK (
    id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND "ownerUserId" ~ '^[A-Za-z0-9_-]{1,128}$'
    AND "operationId" ~ '^[A-Za-z0-9_.:-]{1,128}$'
    AND "resourceId" ~ '^[A-Za-z0-9_.:-]{1,128}$'
    AND "idempotencyKeyHash"::text ~ '^[a-f0-9]{64}$'
    AND "requestHash"::text ~ '^[a-f0-9]{64}$'
    AND "attemptCount" >= 0 AND "fencingToken" >= 0
    AND ("leaseOwner" IS NULL OR "leaseOwner" ~ '^[A-Za-z0-9_-]{1,128}$')
    AND ("errorCode" IS NULL OR "errorCode" ~ '^[A-Z][A-Z0-9_]{1,63}$')
  ),
  ADD CONSTRAINT "AdminCommandReceipt_state" CHECK (
    ((status IN ('SUCCEEDED', 'FAILED')) = ("completedAt" IS NOT NULL))
    AND ((status = 'RUNNING') = ("leaseOwner" IS NOT NULL AND "leaseUntil" IS NOT NULL))
    AND (("leaseOwner" IS NULL) = ("leaseUntil" IS NULL))
    AND (status <> 'RUNNING' OR ("fencingToken" > 0 AND "attemptCount" > 0))
    AND (status <> 'SUCCEEDED' OR ("responseJson" IS NOT NULL AND "errorCode" IS NULL))
    AND (status <> 'FAILED' OR "errorCode" IS NOT NULL)
    AND (status IN ('SUCCEEDED', 'FAILED') OR ("responseJson" IS NULL AND "errorCode" IS NULL))
    AND ("responseJson" IS NULL OR (jsonb_typeof("responseJson") = 'object' AND octet_length("responseJson"::text) <= 32768))
  ),
  ADD CONSTRAINT "AdminCommandReceipt_time_bounds" CHECK (
    isfinite("createdAt") AND isfinite("availableAt") AND isfinite("expiresAt")
    AND "availableAt" >= "createdAt" AND "expiresAt" >= "createdAt" + INTERVAL '24 hours'
    AND ("completedAt" IS NULL OR (isfinite("completedAt") AND "completedAt" >= "createdAt"
      AND "expiresAt" >= "completedAt" + INTERVAL '24 hours'))
    AND ("leaseUntil" IS NULL OR (isfinite("leaseUntil") AND "leaseUntil" > "createdAt"))
  );

CREATE FUNCTION public.protect_admin_command_receipt() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE current_clock TIMESTAMPTZ := public.auth_now();
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Administrative command history cannot be truncated';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('SUCCEEDED', 'FAILED') OR OLD."expiresAt" > current_clock
       OR EXISTS (SELECT 1 FROM public."KeyRotationRun" WHERE "receiptId" = OLD.id) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'An active or retained administrative command cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('PENDING', 'SUCCEEDED') OR NEW."createdAt" > current_clock
       OR NEW."attemptCount" <> 0 OR NEW."fencingToken" <> 0
       OR NEW."leaseOwner" IS NOT NULL OR NEW."leaseUntil" IS NOT NULL
       OR (NEW."completedAt" IS NOT NULL AND NEW."completedAt" > current_clock) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An administrative command must begin pending or atomically completed';
    END IF;
    IF NEW.status = 'SUCCEEDED' THEN
      -- Retention starts at actual completion, never a caller-supplied historical timestamp.
      NEW."completedAt" := current_clock;
      NEW."expiresAt" := GREATEST(NEW."expiresAt", current_clock + INTERVAL '24 hours');
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('SUCCEEDED', 'FAILED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A terminal administrative response is immutable';
  END IF;
  IF ROW(NEW.id, NEW."ownerUserId", NEW."operationId", NEW."resourceId", NEW."idempotencyKeyHash", NEW."requestHash", NEW."createdAt")
     IS DISTINCT FROM ROW(OLD.id, OLD."ownerUserId", OLD."operationId", OLD."resourceId", OLD."idempotencyKeyHash", OLD."requestHash", OLD."createdAt")
     OR NEW."expiresAt" < OLD."expiresAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Administrative command identity and minimum retention are immutable';
  END IF;
  IF NEW.status = 'RUNNING' THEN
    IF (OLD.status = 'RUNNING' AND OLD."leaseUntil" > current_clock)
       OR OLD.status NOT IN ('PENDING', 'RETRY_WAIT', 'RUNNING')
       OR OLD."availableAt" > current_clock
       OR NEW."fencingToken" <> OLD."fencingToken" + 1
       OR NEW."attemptCount" <> OLD."attemptCount" + 1
       OR NEW."leaseUntil" <= current_clock
       OR NEW."leaseUntil" > current_clock + INTERVAL '60 seconds' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An administrative claim requires a new fence and a bounded available lease';
    END IF;
  ELSE
    IF OLD.status <> 'RUNNING' OR NEW.status NOT IN ('RETRY_WAIT', 'SUCCEEDED', 'FAILED')
       OR NEW."fencingToken" <> OLD."fencingToken" OR NEW."attemptCount" <> OLD."attemptCount" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Administrative command state cannot move backwards';
    END IF;
    IF OLD."leaseUntil" <= current_clock
      OR current_setting('serendipity.admin_lease_owner', true) IS DISTINCT FROM OLD."leaseOwner"
      OR current_setting('serendipity.admin_fencing_token', true) IS DISTINCT FROM OLD."fencingToken"::text
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Administrative completion requires the current live claim';
    END IF;
    IF NEW."completedAt" IS NOT NULL AND NEW."completedAt" > current_clock THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Administrative completion cannot be future dated';
    END IF;
    IF NEW.status IN ('SUCCEEDED', 'FAILED') THEN
      NEW."completedAt" := current_clock;
      NEW."expiresAt" := GREATEST(NEW."expiresAt", current_clock + INTERVAL '24 hours');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AdminCommandReceipt_lifecycle" BEFORE INSERT OR UPDATE OR DELETE ON "AdminCommandReceipt"
FOR EACH ROW EXECUTE FUNCTION public.protect_admin_command_receipt();
CREATE TRIGGER "AdminCommandReceipt_no_truncate" BEFORE TRUNCATE ON "AdminCommandReceipt"
FOR EACH STATEMENT EXECUTE FUNCTION public.protect_admin_command_receipt();

ALTER TABLE "KeyRotationRun"
  ADD CONSTRAINT "KeyRotationRun_identity" CHECK (
    id ~ '^[A-Za-z0-9_-]{1,128}$' AND "receiptId" ~ '^[A-Za-z0-9_-]{1,128}$'
    AND "oldKeyId" ~ '^[A-Za-z0-9_-]{1,128}$'
    AND ("newKeyId" IS NULL OR ("newKeyId" ~ '^[A-Za-z0-9_-]{1,128}$' AND "newKeyId" <> "oldKeyId"))
    AND "referenceSetHash"::text ~ '^[a-f0-9]{64}$'
    -- Provider adapters do not exist until Phase015: no untyped candidate payload is accepted.
    AND "candidateIdsJson" = '[]'::jsonb
    AND jsonb_typeof("baseRevisionsJson") = 'object' AND octet_length("baseRevisionsJson"::text) <= 16384
    AND isfinite("createdAt") AND isfinite("updatedAt") AND "updatedAt" >= "createdAt"
  );

CREATE FUNCTION public.protect_key_rotation_run() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  command public."AdminCommandReceipt"%ROWTYPE;
  current_clock TIMESTAMPTZ := public.auth_now();
  checkpoint_keys INTEGER;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    -- No audit-expiry purge protocol exists yet. Retain this FK chain until its producer adds one.
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Rotation checkpoints are retained with their key audit history';
  END IF;
  SELECT * INTO command FROM public."AdminCommandReceipt" WHERE id = NEW."receiptId" FOR UPDATE;
  IF NOT FOUND OR command.status <> 'RUNNING' OR command."leaseUntil" <= current_clock
     OR current_setting('serendipity.admin_lease_owner', true) IS DISTINCT FROM command."leaseOwner"
     OR current_setting('serendipity.admin_fencing_token', true) IS DISTINCT FROM command."fencingToken"::text
     OR command."resourceId" <> NEW."oldKeyId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A rotation checkpoint requires the current live administrative claim';
  END IF;
  IF jsonb_typeof(NEW."checkpointJson") <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A rotation checkpoint has a controlled shape';
  END IF;
  SELECT count(*) INTO checkpoint_keys FROM jsonb_object_keys(NEW."checkpointJson");
  IF checkpoint_keys <> 3 OR NEW."checkpointJson"->'version' IS DISTINCT FROM '1'::jsonb
     OR NEW."checkpointJson"->'fencingToken' IS DISTINCT FROM to_jsonb(command."fencingToken")
     OR NEW."checkpointJson"->>'step' IS DISTINCT FROM (CASE NEW.stage
       WHEN 'PREPARING' THEN 'PREPARED' WHEN 'TESTING' THEN 'TESTING'
       WHEN 'READY' THEN 'VERIFIED' WHEN 'ACTIVATED' THEN 'ACTIVATED' WHEN 'ABORTED' THEN 'ABORTED' END)
     OR EXISTS (
       SELECT 1 FROM jsonb_each(NEW."baseRevisionsJson") item
       WHERE item.key !~ '^[A-Za-z0-9_-]{1,128}$' OR jsonb_typeof(item.value) <> 'number'
          OR item.value::text !~ '^(0|[1-9][0-9]{0,9})$' OR item.value::text::numeric > 2147483647
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A rotation checkpoint contains only validated revisions and progress';
  END IF;
  IF NEW."createdAt" > current_clock OR NEW."updatedAt" > current_clock THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Rotation progress cannot be future dated';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.stage <> 'PREPARING' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Rotation preparation must be persisted before testing';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.stage IN ('ACTIVATED', 'ABORTED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A terminal rotation checkpoint is immutable';
  END IF;
  IF ROW(NEW.id, NEW."receiptId", NEW."oldKeyId", NEW."candidateIdsJson", NEW."referenceSetHash", NEW."baseRevisionsJson", NEW."createdAt")
     IS DISTINCT FROM ROW(OLD.id, OLD."receiptId", OLD."oldKeyId", OLD."candidateIdsJson", OLD."referenceSetHash", OLD."baseRevisionsJson", OLD."createdAt")
     OR (NEW."newKeyId" IS DISTINCT FROM OLD."newKeyId" AND (OLD."newKeyId" IS NOT NULL OR OLD.stage <> 'PREPARING'))
     OR NEW."updatedAt" < OLD."updatedAt"
     OR NOT (
       (OLD.stage = 'PREPARING' AND NEW.stage IN ('PREPARING', 'TESTING', 'ABORTED'))
       OR (OLD.stage = 'TESTING' AND NEW.stage IN ('TESTING', 'READY', 'ABORTED'))
       OR (OLD.stage = 'READY' AND NEW.stage IN ('READY', 'ACTIVATED', 'ABORTED'))
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Rotation identity, references and forward progress are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "KeyRotationRun_lifecycle" BEFORE INSERT OR UPDATE OR DELETE ON "KeyRotationRun"
FOR EACH ROW EXECUTE FUNCTION public.protect_key_rotation_run();
CREATE TRIGGER "KeyRotationRun_no_truncate" BEFORE TRUNCATE ON "KeyRotationRun"
FOR EACH STATEMENT EXECUTE FUNCTION public.protect_key_rotation_run();

REVOKE ALL ON FUNCTION public.protect_admin_command_receipt() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_key_rotation_run() FROM PUBLIC;
REVOKE ALL ON TABLE "AdminCommandReceipt", "KeyRotationRun" FROM PUBLIC;
