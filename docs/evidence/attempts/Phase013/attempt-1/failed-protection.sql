-- Phase013: existing-table contract repair. No model, column or parallel secret store is created.
-- Phase012 rows with [] candidates and exact three-field checkpoints remain valid.
CREATE FUNCTION public.key_rotation_candidates_valid(value JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog AS $$
DECLARE item JSONB; item_count INTEGER; unique_count INTEGER;
BEGIN
  IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) > 127 OR octet_length(value::text) > 65536 THEN RETURN FALSE; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
    IF jsonb_typeof(item) <> 'object' THEN RETURN FALSE; END IF;
    SELECT count(*) INTO item_count FROM jsonb_object_keys(item);
    IF item_count <> 6 OR NOT (item ?& ARRAY['adapterId','referenceId','candidateId','configVersion','referenceRevision','contentHash'])
       OR jsonb_typeof(item->'adapterId') <> 'string' OR item->>'adapterId' !~ '^[A-Za-z0-9_-]{1,128}$'
       OR jsonb_typeof(item->'referenceId') <> 'string' OR item->>'referenceId' !~ '^[A-Za-z0-9_-]{1,128}$'
       OR jsonb_typeof(item->'candidateId') <> 'string' OR item->>'candidateId' !~ '^[A-Za-z0-9_-]{1,128}$'
       OR jsonb_typeof(item->'contentHash') <> 'string' OR item->>'contentHash' !~ '^[a-f0-9]{64}$'
       OR jsonb_typeof(item->'configVersion') <> 'number' OR (item->>'configVersion') !~ '^(0|[1-9][0-9]{0,9})$'
       OR (item->>'configVersion')::numeric > 2147483647
       OR jsonb_typeof(item->'referenceRevision') <> 'number' OR (item->>'referenceRevision') !~ '^(0|[1-9][0-9]{0,9})$'
       OR (item->>'referenceRevision')::numeric > 2147483647 THEN RETURN FALSE; END IF;
  END LOOP;
  SELECT count(DISTINCT (item->>'adapterId',item->>'referenceId')) INTO unique_count FROM jsonb_array_elements(value) item;
  RETURN unique_count = jsonb_array_length(value);
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END;
$$;

ALTER TABLE "KeyRotationRun" DROP CONSTRAINT "KeyRotationRun_identity";
ALTER TABLE "KeyRotationRun" ADD CONSTRAINT "KeyRotationRun_identity" CHECK (
  id ~ '^[A-Za-z0-9_-]{1,128}$' AND "receiptId" ~ '^[A-Za-z0-9_-]{1,128}$'
  AND "oldKeyId" ~ '^[A-Za-z0-9_-]{1,128}$'
  AND ("newKeyId" IS NULL OR ("newKeyId" ~ '^[A-Za-z0-9_-]{1,128}$' AND "newKeyId" <> "oldKeyId"))
  AND "referenceSetHash"::text ~ '^[a-f0-9]{64}$'
  AND public.key_rotation_candidates_valid("candidateIdsJson") IS TRUE
  AND jsonb_typeof("baseRevisionsJson") = 'object' AND octet_length("baseRevisionsJson"::text) <= 16384
  AND isfinite("createdAt") AND isfinite("updatedAt") AND "updatedAt" >= "createdAt"
);

CREATE OR REPLACE FUNCTION public.protect_key_rotation_run() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  command public."AdminCommandReceipt"%ROWTYPE;
  current_clock TIMESTAMPTZ := public.auth_now();
  checkpoint_keys INTEGER;
  revision_keys INTEGER;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Rotation checkpoints are retained with their key audit history';
  END IF;
  SELECT * INTO command FROM public."AdminCommandReceipt" WHERE id=NEW."receiptId" FOR UPDATE;
  IF NOT FOUND OR command.status <> 'RUNNING' OR command."leaseUntil" <= current_clock
    OR current_setting('serendipity.admin_lease_owner',true) IS DISTINCT FROM command."leaseOwner"
    OR current_setting('serendipity.admin_fencing_token',true) IS DISTINCT FROM command."fencingToken"::text
    OR command."resourceId" <> NEW."oldKeyId" THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='A rotation checkpoint requires the current live administrative claim';
  END IF;
  IF jsonb_typeof(NEW."checkpointJson") <> 'object' OR jsonb_typeof(NEW."baseRevisionsJson") <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='A rotation checkpoint has a controlled shape';
  END IF;
  SELECT count(*) INTO checkpoint_keys FROM jsonb_object_keys(NEW."checkpointJson");
  SELECT count(*) INTO revision_keys FROM jsonb_object_keys(NEW."baseRevisionsJson");
  IF checkpoint_keys < 3 OR checkpoint_keys > 5
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(NEW."checkpointJson") name WHERE name NOT IN ('version','fencingToken','step','errorCode','verificationHash'))
    OR NEW."checkpointJson"->'version' IS DISTINCT FROM '1'::jsonb
    OR NEW."checkpointJson"->'fencingToken' IS DISTINCT FROM to_jsonb(command."fencingToken")
    OR NEW."checkpointJson"->>'step' IS DISTINCT FROM (CASE NEW.stage
      WHEN 'PREPARING' THEN 'PREPARED' WHEN 'TESTING' THEN 'TESTING' WHEN 'READY' THEN 'VERIFIED'
      WHEN 'ACTIVATED' THEN 'ACTIVATED' WHEN 'ABORTED' THEN 'ABORTED' END)
    OR (NEW."checkpointJson" ? 'errorCode' AND (jsonb_typeof(NEW."checkpointJson"->'errorCode') <> 'string'
      OR NEW."checkpointJson"->>'errorCode' NOT IN ('CONFIG_ERROR','PROVIDER_UNAVAILABLE','PROVIDER_TIMEOUT','VERSION_CONFLICT','INTERNAL_ERROR')
      OR NEW.stage NOT IN ('TESTING','READY','ABORTED')))
    OR (NEW."checkpointJson" ? 'verificationHash' AND (jsonb_typeof(NEW."checkpointJson"->'verificationHash') <> 'string'
      OR NEW."checkpointJson"->>'verificationHash' !~ '^[a-f0-9]{64}$' OR NEW.stage NOT IN ('READY','ACTIVATED')))
    OR revision_keys < 1 OR revision_keys > 128 OR NOT (NEW."baseRevisionsJson" ? NEW."oldKeyId")
    OR EXISTS (SELECT 1 FROM jsonb_each(NEW."baseRevisionsJson") item
      WHERE item.key !~ '^[A-Za-z0-9_-]{1,128}$' OR jsonb_typeof(item.value) <> 'number'
        OR item.value::text !~ '^(0|[1-9][0-9]{0,9})$' OR item.value::text::numeric > 2147483647) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='A rotation checkpoint contains only validated revisions and progress';
  END IF;
  IF NEW."createdAt" > current_clock OR NEW."updatedAt" > current_clock THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Rotation progress cannot be future dated';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.stage <> 'PREPARING' THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Rotation preparation must be persisted before testing';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.stage IN ('ACTIVATED','ABORTED') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='A terminal rotation checkpoint is immutable';
  END IF;
  IF ROW(NEW.id,NEW."receiptId",NEW."oldKeyId",NEW."candidateIdsJson",NEW."referenceSetHash",NEW."baseRevisionsJson",NEW."createdAt")
    IS DISTINCT FROM ROW(OLD.id,OLD."receiptId",OLD."oldKeyId",OLD."candidateIdsJson",OLD."referenceSetHash",OLD."baseRevisionsJson",OLD."createdAt")
    OR (NEW."newKeyId" IS DISTINCT FROM OLD."newKeyId" AND (OLD."newKeyId" IS NOT NULL OR OLD.stage <> 'PREPARING'))
    OR NEW."updatedAt" < OLD."updatedAt"
    OR NOT ((OLD.stage='PREPARING' AND NEW.stage IN ('PREPARING','TESTING','ABORTED'))
      OR (OLD.stage='TESTING' AND NEW.stage IN ('TESTING','READY','ABORTED'))
      OR (OLD.stage='READY' AND NEW.stage IN ('READY','ACTIVATED','ABORTED'))) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Rotation identity, references and forward progress are immutable';
  END IF;
  IF NEW.stage='ACTIVATED' AND (NEW."newKeyId" IS NULL OR NOT (NEW."checkpointJson" ? 'verificationHash')
    OR NEW."checkpointJson" ? 'errorCode'
    OR NOT EXISTS (SELECT 1 FROM public."ApiKeyConfig" WHERE id=NEW."oldKeyId" AND status='REVOKED')
    OR NOT EXISTS (SELECT 1 FROM public."ApiKeyConfig" WHERE id=NEW."newKeyId" AND status='ACTIVE')) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='An activated rotation requires a verified atomic key switch';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.protect_key_rotation_run() FROM PUBLIC;
