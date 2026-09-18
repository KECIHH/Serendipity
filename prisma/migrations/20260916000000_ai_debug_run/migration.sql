-- Phase018: administrator AI debug runs on the single Mock provider.
-- Debug output is tracked by AiOutputRecord only; no formal plan table is touched.

-- CreateEnum
CREATE TYPE "AiDebugRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "AiDebugRun" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "idempotencyReceiptId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "payloadRef" VARCHAR(128) NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "status" "AiDebugRunStatus" NOT NULL DEFAULT 'PENDING',
    "traceId" VARCHAR(128) NOT NULL,
    "attemptIdsJson" JSONB NOT NULL DEFAULT '[]',
    "finalSummaryJson" JSONB,
    "errorCode" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AiDebugRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiDebugRun_idempotencyReceiptId_key" ON "AiDebugRun"("idempotencyReceiptId");
CREATE UNIQUE INDEX "AiDebugRun_taskId_key" ON "AiDebugRun"("taskId");
CREATE UNIQUE INDEX "AiDebugRun_traceId_key" ON "AiDebugRun"("traceId");
CREATE INDEX "AiDebugRun_adminUserId_createdAt_id_idx" ON "AiDebugRun"("adminUserId", "createdAt", "id");
CREATE INDEX "AiDebugRun_status_createdAt_id_idx" ON "AiDebugRun"("status", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "AiDebugRun" ADD CONSTRAINT "AiDebugRun_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiDebugRun" ADD CONSTRAINT "AiDebugRun_idempotencyReceiptId_fkey" FOREIGN KEY ("idempotencyReceiptId") REFERENCES "AdminCommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AiDebugRun" ADD CONSTRAINT "AiDebugRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "DurableTask"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The debug run is a controlled, admin-only projection: identity is immutable, terminal
-- state cannot be reopened and the attempt list stays bounded.
ALTER TABLE "AiDebugRun"
  ADD CONSTRAINT "AiDebugRun_identity" CHECK (
    id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND "adminUserId" ~ '^[A-Za-z0-9_-]{1,128}$'
    AND "traceId" ~ '^[A-Za-z0-9_.:-]{1,128}$'
    AND "payloadRef" ~ '^task-payload:[A-Za-z0-9_-]{1,100}$'
    AND "payloadHash"::text ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("attemptIdsJson") = 'array'
    AND jsonb_array_length("attemptIdsJson") <= 8
    AND ("finalSummaryJson" IS NULL OR jsonb_typeof("finalSummaryJson") = 'object')
    AND ("errorCode" IS NULL OR "errorCode" ~ '^[A-Z][A-Z0-9_]{1,63}$')
    AND isfinite("createdAt")
    AND ("completedAt" IS NULL OR isfinite("completedAt"))
  ),
  ADD CONSTRAINT "AiDebugRun_state" CHECK (
    ((status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')) = ("completedAt" IS NOT NULL))
    AND (status <> 'FAILED' OR "errorCode" IS NOT NULL)
    AND (status <> 'SUCCEEDED' OR "errorCode" IS NULL)
    AND (status <> 'SUCCEEDED' OR "finalSummaryJson" IS NOT NULL)
    AND ("completedAt" IS NULL OR "completedAt" >= "createdAt")
  );

CREATE FUNCTION public.protect_ai_debug_run() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED') THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'An active debug run cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW."completedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Debug runs begin pending';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW."adminUserId", NEW."idempotencyReceiptId", NEW."taskId", NEW."payloadRef",
         NEW."payloadHash", NEW."traceId", NEW."createdAt")
     IS DISTINCT FROM
     ROW(OLD.id, OLD."adminUserId", OLD."idempotencyReceiptId", OLD."taskId", OLD."payloadRef",
         OLD."payloadHash", OLD."traceId", OLD."createdAt")
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Debug run input identity is immutable';
  END IF;
  IF OLD.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A terminal debug run cannot be reopened';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('RUNNING', 'FAILED', 'CANCELLED'))
    OR (OLD.status = 'RUNNING' AND NEW.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')))
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Debug run state cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AiDebugRun_lifecycle" BEFORE INSERT OR UPDATE OR DELETE ON "AiDebugRun"
FOR EACH ROW EXECUTE FUNCTION public.protect_ai_debug_run();

-- Debug tasks reuse the Phase012 receipt ledger and a controlled encrypted payload.
ALTER TABLE "DurableTask" DROP CONSTRAINT "DurableTask_valid";
ALTER TABLE "DurableTask" ADD CONSTRAINT "DurableTask_valid" CHECK (
  kind IN ('CHAT_COMMAND','ADMIN_KEY_ROTATION','AI_DEBUG') AND "payloadHash" ~ '^[a-f0-9]{64}$' AND "payloadSchemaVersion"=1
  AND "maxAttempts" BETWEEN 1 AND 20 AND "attemptCount" BETWEEN 0 AND "maxAttempts" AND "fencingToken">=0
  AND jsonb_typeof("checkpointJson")='object'
  AND ((status='RUNNING') = ("leaseOwner" IS NOT NULL AND "leaseUntil" IS NOT NULL))
  AND (("leaseOwner" IS NULL) = ("leaseUntil" IS NULL))
  AND (status<>'RUNNING' OR ("fencingToken">0 AND "attemptCount">0))
  AND ((kind='CHAT_COMMAND' AND "commandId" IS NOT NULL AND "commandId"="aggregateId" AND "adminReceiptId" IS NULL AND "payloadRef" ~ '^task-payload:[A-Za-z0-9_-]+$')
    OR (kind='ADMIN_KEY_ROTATION' AND "adminReceiptId" IS NOT NULL AND "adminReceiptId"="aggregateId" AND "commandId" IS NULL AND "payloadRef"='admin-command:'||"adminReceiptId")
    OR (kind='AI_DEBUG' AND "adminReceiptId" IS NOT NULL AND "adminReceiptId"="aggregateId" AND "commandId" IS NULL AND "payloadRef" ~ '^task-payload:[A-Za-z0-9_-]{1,100}$'))
);

-- The stored debug payload must already exist and belong to the authorizing administrator.
CREATE FUNCTION public.require_debug_task_input() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.kind = 'AI_DEBUG' AND NOT EXISTS (
    SELECT 1 FROM public."TaskPayload" p
    JOIN public."AdminCommandReceipt" r ON r.id = NEW."adminReceiptId"
    WHERE 'task-payload:' || p.id = NEW."payloadRef"
      AND p."contentHash" = NEW."payloadHash"
      AND p."schemaVersion" = NEW."payloadSchemaVersion"
      AND p."ownerKeyHash" = encode(sha256(('ai-debug:' || r."ownerUserId")::bytea), 'hex'))
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Debug tasks require their controlled stored input';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "DurableTask_debug_input" BEFORE INSERT ON "DurableTask"
FOR EACH ROW EXECUTE FUNCTION public.require_debug_task_input();

-- The application role may only append attempts and move a run forward.
REVOKE ALL ON TABLE "AiDebugRun" FROM PUBLIC;
