-- Audit rows may outlive their actors; only the real FK may clear a deleted actor reference.
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actor_shape" CHECK (
  ("actorEmailSnapshot" IS NOT NULL AND ("detailJson" IS NULL OR NOT ("detailJson" ? 'systemActor')))
  OR ("actorId" IS NULL AND "actorEmailSnapshot" IS NULL
      AND COALESCE("detailJson"->>'systemActor' IN ('MIGRATION', 'SCHEDULER', 'MAINTENANCE'), FALSE))
);

ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_metadata_bounds" CHECK (
  "action" ~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$'
  AND "targetType" ~ '^[A-Za-z][A-Za-z0-9]{0,63}$'
  AND ("actorId" IS NULL OR "actorId" ~ '^[A-Za-z0-9_-]{1,128}$')
  AND ("targetId" IS NULL OR "targetId" ~ '^[A-Za-z0-9_-]{1,128}$')
  AND ("actorEmailSnapshot" IS NULL OR length("actorEmailSnapshot") BETWEEN 3 AND 254)
  AND ("requestId" IS NULL OR "requestId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  AND ("traceId" IS NULL OR "traceId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  AND ("ipHash" IS NULL OR "ipHash"::text ~ '^[0-9a-f]{64}$')
  AND ("userAgentSummary" IS NULL OR "userAgentSummary" !~ '[[:cntrl:]]')
  AND ("detailJson" IS NULL OR (jsonb_typeof("detailJson") = 'object' AND octet_length("detailJson"::text) <= 32768))
);

CREATE FUNCTION public.audit_log_reject_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF pg_trigger_depth() > 1
       AND OLD."actorId" IS NOT NULL AND NEW."actorId" IS NULL
       AND (to_jsonb(NEW) - 'actorId') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'actorId')
       AND NOT EXISTS (SELECT 1 FROM public."User" WHERE id = OLD."actorId") THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'AuditLog is append-only';
END;
$$;

CREATE TRIGGER "AuditLog_append_only" BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION public.audit_log_reject_mutation();
CREATE TRIGGER "AuditLog_no_truncate" BEFORE TRUNCATE ON "AuditLog"
FOR EACH STATEMENT EXECUTE FUNCTION public.audit_log_reject_mutation();

REVOKE ALL ON FUNCTION public.audit_log_reject_mutation() FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "AuditLog" FROM PUBLIC;
