-- CreateEnum
CREATE TYPE "ChatCommandKind" AS ENUM ('CHAT_MESSAGE', 'PLAN_DRAFT');

-- CreateEnum
CREATE TYPE "ChatCommandStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'DELIVERED');

-- AlterTable
ALTER TABLE "AiOutputRecord" ADD COLUMN     "commandId" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN "commandId" TEXT;

-- CreateTable
CREATE TABLE "ChatCommand" (
    "id" TEXT NOT NULL,
    "travelRecordId" TEXT NOT NULL,
    "ownerKeyHash" CHAR(64) NOT NULL,
    "kind" "ChatCommandKind" NOT NULL,
    "idempotencyKeyHash" CHAR(64) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "payloadRef" VARCHAR(128) NOT NULL,
    "payloadSchemaVersion" INTEGER NOT NULL,
    "status" "ChatCommandStatus" NOT NULL DEFAULT 'PENDING',
    "userMessageId" TEXT NOT NULL,
    "assistantMessageId" TEXT,
    "traceId" VARCHAR(128) NOT NULL,
    "errorCode" VARCHAR(64),
    "errorMessage" VARCHAR(256),
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ChatCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatCommandEvent" (
    "id" TEXT NOT NULL,
    "eventId" VARCHAR(36) NOT NULL,
    "sequence" INTEGER NOT NULL,
    "aggregateId" VARCHAR(128) NOT NULL,
    "traceId" VARCHAR(128) NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "payloadVersion" INTEGER NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatCommandEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommandIdempotency" (
    "id" TEXT NOT NULL,
    "ownerKeyHash" CHAR(64) NOT NULL,
    "kind" "ChatCommandKind" NOT NULL,
    "idempotencyKeyHash" CHAR(64) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "commandId" TEXT,
    "responseJson" JSONB,
    "status" "ChatCommandStatus" NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CommandIdempotency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DurableTask" (
    "id" TEXT NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "aggregateId" VARCHAR(128) NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "payloadRef" VARCHAR(128) NOT NULL,
    "payloadSchemaVersion" INTEGER NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" VARCHAR(128),
    "leaseUntil" TIMESTAMPTZ(3),
    "fencingToken" INTEGER NOT NULL DEFAULT 0,
    "checkpointJson" JSONB NOT NULL,
    "resultRef" VARCHAR(128),
    "errorCategory" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "commandId" TEXT,
    "rotationRunId" TEXT,
    "adminReceiptId" TEXT,

    CONSTRAINT "DurableTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskPayload" (
    "id" TEXT NOT NULL,
    "ownerKeyHash" CHAR(64) NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "encryptionKeyId" TEXT NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskPayload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Outbox" (
    "id" TEXT NOT NULL,
    "aggregateId" VARCHAR(128) NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "eventId" VARCHAR(36) NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatCommand_ownerKeyHash_kind_status_createdAt_idx" ON "ChatCommand"("ownerKeyHash", "kind", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ChatCommand_travelRecordId_status_createdAt_idx" ON "ChatCommand"("travelRecordId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ChatCommand_kind_status_createdAt_idx" ON "ChatCommand"("kind", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatCommand_userMessageId_key" ON "ChatCommand"("userMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatCommand_assistantMessageId_key" ON "ChatCommand"("assistantMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatCommandEvent_eventId_key" ON "ChatCommandEvent"("eventId");

-- CreateIndex
CREATE INDEX "ChatCommandEvent_aggregateId_sequence_idx" ON "ChatCommandEvent"("aggregateId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "ChatCommandEvent_aggregateId_sequence_key" ON "ChatCommandEvent"("aggregateId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "CommandIdempotency_commandId_key" ON "CommandIdempotency"("commandId");

-- CreateIndex
CREATE INDEX "CommandIdempotency_expiresAt_idx" ON "CommandIdempotency"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommandIdempotency_ownerKeyHash_kind_idempotencyKeyHash_key" ON "CommandIdempotency"("ownerKeyHash", "kind", "idempotencyKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "DurableTask_commandId_key" ON "DurableTask"("commandId");

-- CreateIndex
CREATE UNIQUE INDEX "DurableTask_rotationRunId_key" ON "DurableTask"("rotationRunId");

-- CreateIndex
CREATE INDEX "DurableTask_status_availableAt_leaseUntil_id_idx" ON "DurableTask"("status", "availableAt", "leaseUntil", "id");

-- CreateIndex
CREATE INDEX "DurableTask_leaseOwner_fencingToken_idx" ON "DurableTask"("leaseOwner", "fencingToken");

-- CreateIndex
CREATE INDEX "DurableTask_commandId_idx" ON "DurableTask"("commandId");

-- CreateIndex
CREATE INDEX "DurableTask_rotationRunId_idx" ON "DurableTask"("rotationRunId");

-- CreateIndex
CREATE UNIQUE INDEX "DurableTask_kind_aggregateId_key" ON "DurableTask"("kind", "aggregateId");

-- CreateIndex
CREATE INDEX "TaskPayload_ownerKeyHash_expiresAt_idx" ON "TaskPayload"("ownerKeyHash", "expiresAt");

-- CreateIndex
CREATE INDEX "TaskPayload_expiresAt_idx" ON "TaskPayload"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Outbox_eventId_key" ON "Outbox"("eventId");

-- CreateIndex
CREATE INDEX "Outbox_status_availableAt_id_idx" ON "Outbox"("status", "availableAt", "id");

-- CreateIndex
CREATE INDEX "Outbox_aggregateId_idx" ON "Outbox"("aggregateId");

-- CreateIndex
CREATE INDEX "AiOutputRecord_commandId_idx" ON "AiOutputRecord"("commandId");

-- AddForeignKey
ALTER TABLE "AiOutputRecord" ADD CONSTRAINT "AiOutputRecord_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "ChatCommand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatCommand" ADD CONSTRAINT "ChatCommand_travelRecordId_fkey" FOREIGN KEY ("travelRecordId") REFERENCES "TravelRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatCommand" ADD CONSTRAINT "ChatCommand_userMessageId_fkey" FOREIGN KEY ("userMessageId") REFERENCES "ChatMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatCommand" ADD CONSTRAINT "ChatCommand_assistantMessageId_fkey" FOREIGN KEY ("assistantMessageId") REFERENCES "ChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatCommandEvent" ADD CONSTRAINT "ChatCommandEvent_aggregateId_fkey" FOREIGN KEY ("aggregateId") REFERENCES "ChatCommand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommandIdempotency" ADD CONSTRAINT "CommandIdempotency_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "ChatCommand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DurableTask" ADD CONSTRAINT "DurableTask_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "ChatCommand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DurableTask" ADD CONSTRAINT "DurableTask_rotationRunId_fkey" FOREIGN KEY ("rotationRunId") REFERENCES "KeyRotationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Phase016 invariants supplement the additive tables. Earlier migrations remain byte-identical.
CREATE UNIQUE INDEX "ChatCommand_ownerKeyHash_kind_idempotencyKeyHash_key" ON "ChatCommand"("ownerKeyHash",kind,"idempotencyKeyHash");
CREATE INDEX "ChatMessage_commandId_idx" ON "ChatMessage"("commandId");
CREATE UNIQUE INDEX "ChatMessage_command_user_key" ON "ChatMessage"("commandId") WHERE role='USER' AND "commandId" IS NOT NULL;
CREATE UNIQUE INDEX "ChatMessage_command_assistant_key" ON "ChatMessage"("commandId") WHERE role='ASSISTANT' AND "commandId" IS NOT NULL;
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "ChatCommand"(id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX "ChatCommandEvent_one_accept" ON "ChatCommandEvent"("aggregateId") WHERE type='message.accepted';
CREATE UNIQUE INDEX "ChatCommandEvent_one_terminal" ON "ChatCommandEvent"("aggregateId") WHERE type IN ('assistant.completed','command.failed','command.cancelled');
CREATE UNIQUE INDEX "DurableTask_adminReceiptId_key" ON "DurableTask"("adminReceiptId");
ALTER TABLE "DurableTask" ADD CONSTRAINT "DurableTask_adminReceiptId_fkey" FOREIGN KEY ("adminReceiptId") REFERENCES "AdminCommandReceipt"(id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ChatCommand" ADD CONSTRAINT "ChatCommand_valid" CHECK (
  "ownerKeyHash" ~ '^[a-f0-9]{64}$' AND "idempotencyKeyHash" ~ '^[a-f0-9]{64}$' AND "requestHash" ~ '^[a-f0-9]{64}$'
  AND "payloadRef" ~ '^task-payload:[A-Za-z0-9_-]+$' AND "payloadSchemaVersion"=1
  AND "traceId" ~ '^[A-Za-z0-9_.:-]{1,128}$'
  AND ((status IN ('COMPLETED','FAILED','CANCELLED')) = ("completedAt" IS NOT NULL))
  AND ("errorCode" IS NULL OR "errorCode" IN ('VALIDATION_ERROR','NOT_FOUND','AUTH_REQUIRED','IDEMPOTENCY_KEY_REUSED',
    'FEATURE_DISABLED','CONFIG_ERROR','RATE_LIMITED','COST_LIMIT','PROVIDER_TIMEOUT','PROVIDER_UNAVAILABLE','CANCELLED','RESYNC_REQUIRED','INTERNAL_ERROR'))
);
ALTER TABLE "ChatCommandEvent" ADD CONSTRAINT "ChatCommandEvent_valid" CHECK (
  sequence > 0 AND "payloadVersion"=1 AND jsonb_typeof("payloadJson")='object' AND "eventId" ~ '^evt_[a-f0-9]{32}$'
  AND type IN ('message.accepted','assistant.completed','command.failed','command.cancelled')
  AND status IN ('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED')
  AND (type <> 'message.accepted' OR status='PENDING')
  AND (type <> 'assistant.completed' OR status='COMPLETED')
  AND (type <> 'command.failed' OR status='FAILED') AND (type <> 'command.cancelled' OR status='CANCELLED')
);
ALTER TABLE "CommandIdempotency" ADD CONSTRAINT "CommandIdempotency_valid" CHECK (
  "ownerKeyHash" ~ '^[a-f0-9]{64}$' AND "idempotencyKeyHash" ~ '^[a-f0-9]{64}$' AND "requestHash" ~ '^[a-f0-9]{64}$'
  AND isfinite("expiresAt")
);
ALTER TABLE "TaskPayload" ADD CONSTRAINT "TaskPayload_valid" CHECK (
  "ownerKeyHash" ~ '^[a-f0-9]{64}$' AND "contentHash" ~ '^[a-f0-9]{64}$' AND "schemaVersion"=1
  AND "encryptionKeyId" ~ '^[a-f0-9]{64}$' AND octet_length(ciphertext) BETWEEN 32 AND 262144 AND isfinite("expiresAt")
);
ALTER TABLE "DurableTask" ADD CONSTRAINT "DurableTask_valid" CHECK (
  kind IN ('CHAT_COMMAND','ADMIN_KEY_ROTATION') AND "payloadHash" ~ '^[a-f0-9]{64}$' AND "payloadSchemaVersion"=1
  AND "maxAttempts" BETWEEN 1 AND 20 AND "attemptCount" BETWEEN 0 AND "maxAttempts" AND "fencingToken">=0
  AND jsonb_typeof("checkpointJson")='object'
  AND ((status='RUNNING') = ("leaseOwner" IS NOT NULL AND "leaseUntil" IS NOT NULL))
  AND (("leaseOwner" IS NULL) = ("leaseUntil" IS NULL))
  AND (status<>'RUNNING' OR ("fencingToken">0 AND "attemptCount">0))
  AND ((kind='CHAT_COMMAND' AND "commandId" IS NOT NULL AND "commandId"="aggregateId" AND "adminReceiptId" IS NULL AND "payloadRef" ~ '^task-payload:[A-Za-z0-9_-]+$')
    OR (kind='ADMIN_KEY_ROTATION' AND "adminReceiptId" IS NOT NULL AND "adminReceiptId"="aggregateId" AND "commandId" IS NULL AND "payloadRef"='admin-command:'||"adminReceiptId"))
);
ALTER TABLE "Outbox" ADD CONSTRAINT "Outbox_valid" CHECK (
  "payloadHash" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("payloadJson")='object' AND "attemptCount">=0
  AND ((status='DELIVERED') = ("publishedAt" IS NOT NULL))
);

CREATE FUNCTION public.protect_chat_command() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Commands require the domain erasure protocol'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'PENDING' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Commands start pending'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW."travelRecordId",NEW."ownerKeyHash",NEW.kind,NEW."idempotencyKeyHash",NEW."requestHash",NEW."payloadRef",NEW."payloadSchemaVersion",NEW."userMessageId",NEW."traceId",NEW."createdAt")
    IS DISTINCT FROM ROW(OLD.id,OLD."travelRecordId",OLD."ownerKeyHash",OLD.kind,OLD."idempotencyKeyHash",OLD."requestHash",OLD."payloadRef",OLD."payloadSchemaVersion",OLD."userMessageId",OLD."traceId",OLD."createdAt")
    OR (OLD.status IN ('COMPLETED','FAILED','CANCELLED') AND NOT (
      OLD.status='COMPLETED' AND NEW.status='COMPLETED' AND OLD."assistantMessageId" IS NULL AND NEW."assistantMessageId" IS NOT NULL
      AND NEW."completedAt"=OLD."completedAt" AND NEW."errorCode" IS NOT DISTINCT FROM OLD."errorCode"))
    OR (NEW.status<>OLD.status AND NOT (
      (OLD.status='PENDING' AND NEW.status IN ('RUNNING','FAILED','CANCELLED')) OR
      (OLD.status='RUNNING' AND NEW.status IN ('COMPLETED','FAILED','CANCELLED'))))
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Command identity and terminal state are immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChatCommand_lifecycle" BEFORE INSERT OR UPDATE OR DELETE ON "ChatCommand"
FOR EACH ROW EXECUTE FUNCTION public.protect_chat_command();

CREATE FUNCTION public.protect_command_event() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Persistent command events are append-only';
END;
$$;
CREATE TRIGGER "ChatCommandEvent_append_only" BEFORE UPDATE OR DELETE ON "ChatCommandEvent"
FOR EACH ROW EXECUTE FUNCTION public.protect_command_event();
CREATE TRIGGER "ChatCommandEvent_no_truncate" BEFORE TRUNCATE ON "ChatCommandEvent"
FOR EACH STATEMENT EXECUTE FUNCTION public.protect_command_event();

CREATE FUNCTION public.check_command_integrity() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE c public."ChatCommand"%ROWTYPE; cid TEXT; users INTEGER; assistants INTEGER; terminals INTEGER;
BEGIN
  IF TG_TABLE_NAME='ChatCommand' THEN cid:=NEW.id;
  ELSIF TG_TABLE_NAME='ChatCommandEvent' THEN cid:=NEW."aggregateId";
  ELSE cid:=NEW."commandId"; END IF;
  IF cid IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO c FROM public."ChatCommand" WHERE id=cid;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Message command is missing'; END IF;
  SELECT count(*) FILTER (WHERE role='USER'),count(*) FILTER (WHERE role='ASSISTANT')
    INTO users,assistants FROM public."ChatMessage" WHERE "commandId"=cid;
  SELECT count(*) INTO terminals FROM public."ChatCommandEvent" WHERE "aggregateId"=cid AND type<>'message.accepted';
  IF users<>1 OR assistants>1
    OR NOT EXISTS (SELECT 1 FROM public."ChatMessage" WHERE id=c."userMessageId" AND "commandId"=cid AND "travelRecordId"=c."travelRecordId" AND role='USER')
    OR EXISTS (SELECT 1 FROM public."ChatMessage" WHERE "commandId"=cid AND ("travelRecordId"<>c."travelRecordId" OR role NOT IN ('USER','ASSISTANT')))
    OR (c.status='COMPLETED' AND (assistants<>1 OR c."assistantMessageId" IS NULL
      OR NOT EXISTS (SELECT 1 FROM public."ChatMessage" WHERE id=c."assistantMessageId" AND "commandId"=cid AND role='ASSISTANT')))
    OR (c.status<>'COMPLETED' AND (assistants<>0 OR c."assistantMessageId" IS NOT NULL))
    OR (c.status IN ('COMPLETED','FAILED','CANCELLED') AND terminals<>1)
    OR (c.status IN ('PENDING','RUNNING') AND terminals<>0)
    OR NOT EXISTS (SELECT 1 FROM public."ChatCommandEvent" WHERE "aggregateId"=cid AND type='message.accepted' AND sequence=1)
    OR EXISTS (SELECT 1 FROM public."ChatCommandEvent" WHERE "aggregateId"=cid AND (("traceId"<>c."traceId") OR
      (type<>'message.accepted' AND (sequence<>2 OR status<>c.status::text))))
    OR NOT EXISTS (SELECT 1 FROM public."DurableTask" WHERE "commandId"=cid AND "payloadRef"=c."payloadRef"
      AND "payloadSchemaVersion"=c."payloadSchemaVersion" AND (c.status IN ('PENDING','RUNNING') OR
        status::text=CASE c.status WHEN 'COMPLETED' THEN 'SUCCEEDED' ELSE c.status::text END))
    OR EXISTS (SELECT 1 FROM public."ChatCommandEvent" e WHERE e."aggregateId"=cid
      AND NOT EXISTS (SELECT 1 FROM public."Outbox" o WHERE o."eventId"=e."eventId" AND o."aggregateId"=cid AND o.type=e.type))
    OR NOT EXISTS (SELECT 1 FROM public."CommandIdempotency" WHERE "commandId"=cid AND "ownerKeyHash"=c."ownerKeyHash"
      AND kind=c.kind AND "idempotencyKeyHash"=c."idempotencyKeyHash" AND "requestHash"=c."requestHash" AND status=c.status)
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Command message event and receipt integrity is required'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER "ChatCommand_integrity" AFTER INSERT OR UPDATE ON "ChatCommand"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_command_integrity();
CREATE CONSTRAINT TRIGGER "ChatMessage_command_integrity" AFTER INSERT OR UPDATE ON "ChatMessage"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_command_integrity();
CREATE CONSTRAINT TRIGGER "ChatCommandEvent_integrity" AFTER INSERT ON "ChatCommandEvent"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_command_integrity();
CREATE CONSTRAINT TRIGGER "CommandIdempotency_integrity" AFTER INSERT OR UPDATE ON "CommandIdempotency"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_command_integrity();
CREATE CONSTRAINT TRIGGER "DurableTask_command_integrity" AFTER INSERT OR UPDATE ON "DurableTask"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_command_integrity();

CREATE FUNCTION public.protect_command_message() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD."commandId" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Accepted command messages are immutable facts';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChatMessage_command_immutable" BEFORE UPDATE OR DELETE ON "ChatMessage"
FOR EACH ROW EXECUTE FUNCTION public.protect_command_message();

CREATE FUNCTION public.protect_task_payload() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' AND current_setting('serendipity.payload_cleanup',true)='authorized' AND OLD."expiresAt"<=public.auth_now()
    AND NOT EXISTS (SELECT 1 FROM public."DurableTask" WHERE ("payloadRef"='task-payload:'||OLD.id OR "checkpointJson"->>'resultPayloadRef'='task-payload:'||OLD.id)
      AND (status NOT IN ('SUCCEEDED','FAILED','CANCELLED') OR "updatedAt"+INTERVAL '24 hours'>public.auth_now()))
  THEN RETURN OLD; END IF;
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Task input is immutable and pinned until retention permits cleanup';
END;
$$;
CREATE TRIGGER "TaskPayload_immutable" BEFORE UPDATE OR DELETE ON "TaskPayload"
FOR EACH ROW EXECUTE FUNCTION public.protect_task_payload();
CREATE TRIGGER "TaskPayload_no_truncate" BEFORE TRUNCATE ON "TaskPayload"
FOR EACH STATEMENT EXECUTE FUNCTION public.protect_task_payload();

CREATE FUNCTION public.protect_durable_task() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE current_clock TIMESTAMPTZ:=public.auth_now(); claiming BOOLEAN;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'PENDING' OR NEW."fencingToken"<>0 OR NEW."attemptCount"<>0
    THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Tasks begin pending'; END IF;
    IF NEW.kind='CHAT_COMMAND' AND NOT EXISTS (
      SELECT 1 FROM public."TaskPayload" p JOIN public."ChatCommand" c ON c.id=NEW."commandId"
      WHERE 'task-payload:'||p.id=NEW."payloadRef" AND p."contentHash"=NEW."payloadHash"
        AND p."schemaVersion"=NEW."payloadSchemaVersion" AND p."ownerKeyHash"=c."ownerKeyHash"
        AND c."payloadRef"=NEW."payloadRef")
    THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Tasks require their authenticated stored input'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' OR OLD.status IN ('SUCCEEDED','FAILED','CANCELLED') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Terminal tasks cannot be reopened'; END IF;
  IF ROW(NEW.id,NEW.kind,NEW."aggregateId",NEW."payloadHash",NEW."payloadRef",NEW."payloadSchemaVersion",NEW."commandId",NEW."adminReceiptId",NEW."createdAt",NEW."maxAttempts")
    IS DISTINCT FROM ROW(OLD.id,OLD.kind,OLD."aggregateId",OLD."payloadHash",OLD."payloadRef",OLD."payloadSchemaVersion",OLD."commandId",OLD."adminReceiptId",OLD."createdAt",OLD."maxAttempts")
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Task input identity is immutable'; END IF;
  claiming:=NEW.status='RUNNING' AND NEW."fencingToken"=OLD."fencingToken"+1;
  IF claiming THEN
    IF OLD."availableAt">current_clock OR (OLD.status='RUNNING' AND OLD."leaseUntil">current_clock)
      OR NEW."leaseUntil"<=current_clock OR NEW."leaseUntil">current_clock+INTERVAL '60 seconds'
      OR NEW."attemptCount"<>(CASE WHEN OLD.status='RUNNING' THEN OLD."attemptCount" ELSE OLD."attemptCount"+1 END)
      OR NEW."checkpointJson" IS DISTINCT FROM OLD."checkpointJson"
    THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Task claims require an available bounded lease'; END IF;
  ELSIF NEW.status='CANCELLED' THEN
    IF NEW."fencingToken"<>OLD."fencingToken" THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Cancellation preserves the fence'; END IF;
  ELSE
    IF OLD.status<>'RUNNING' OR OLD."leaseUntil"<=current_clock OR NEW."fencingToken"<>OLD."fencingToken"
      OR NEW."attemptCount"<>OLD."attemptCount"
      OR current_setting('serendipity.task_id',true) IS DISTINCT FROM OLD.id
      OR current_setting('serendipity.task_owner',true) IS DISTINCT FROM OLD."leaseOwner"
      OR current_setting('serendipity.task_fence',true) IS DISTINCT FROM OLD."fencingToken"::text
    THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='A current task lease and fence are required'; END IF;
  END IF;
  IF OLD."rotationRunId" IS NOT NULL AND NEW."rotationRunId" IS DISTINCT FROM OLD."rotationRunId" THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='A rotation task cannot change its domain run'; END IF;
  IF NEW."checkpointJson"->'authorization' IS DISTINCT FROM OLD."checkpointJson"->'authorization' THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Task authorization is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "DurableTask_lifecycle" BEFORE INSERT OR UPDATE OR DELETE ON "DurableTask"
FOR EACH ROW EXECUTE FUNCTION public.protect_durable_task();

CREATE FUNCTION public.protect_outbox() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.status='DELIVERED' OR ROW(NEW.id,NEW."aggregateId",NEW.type,NEW."eventId",NEW."payloadHash",NEW."payloadJson",NEW."createdAt")
    IS DISTINCT FROM ROW(OLD.id,OLD."aggregateId",OLD.type,OLD."eventId",OLD."payloadHash",OLD."payloadJson",OLD."createdAt")
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Outbox event identity and delivered facts are immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Outbox_immutable" BEFORE UPDATE OR DELETE ON "Outbox" FOR EACH ROW EXECUTE FUNCTION public.protect_outbox();

CREATE FUNCTION public.protect_command_idempotency() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.status IN ('COMPLETED','FAILED','CANCELLED') OR
    ROW(NEW.id,NEW."ownerKeyHash",NEW.kind,NEW."idempotencyKeyHash",NEW."requestHash",NEW."commandId",NEW."createdAt")
      IS DISTINCT FROM ROW(OLD.id,OLD."ownerKeyHash",OLD.kind,OLD."idempotencyKeyHash",OLD."requestHash",OLD."commandId",OLD."createdAt")
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Idempotency history and terminal response are immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CommandIdempotency_immutable" BEFORE UPDATE OR DELETE ON "CommandIdempotency"
FOR EACH ROW EXECUTE FUNCTION public.protect_command_idempotency();

-- Phase016 shared administrative lease authority.
ALTER TABLE "AdminCommandReceipt" DROP CONSTRAINT "AdminCommandReceipt_state";
ALTER TABLE "AdminCommandReceipt" ADD CONSTRAINT "AdminCommandReceipt_state" CHECK (
  ((status IN ('SUCCEEDED','FAILED')) = ("completedAt" IS NOT NULL))
  AND (status<>'SUCCEEDED' OR ("responseJson" IS NOT NULL AND "errorCode" IS NULL))
  AND (status<>'FAILED' OR "errorCode" IS NOT NULL)
  AND (status IN ('SUCCEEDED','FAILED') OR ("responseJson" IS NULL AND "errorCode" IS NULL))
  AND ("responseJson" IS NULL OR (jsonb_typeof("responseJson")='object' AND octet_length("responseJson"::text)<=32768))
);

-- Existing active rotation inputs stay in their original immutable domain rows.
INSERT INTO "DurableTask" (id,kind,"aggregateId","payloadHash","payloadRef","payloadSchemaVersion",status,
  "maxAttempts","checkpointJson","createdAt","updatedAt","adminReceiptId","rotationRunId")
SELECT 'task_legacy_'||r.id,'ADMIN_KEY_ROTATION',r.id,r."requestHash",'admin-command:'||r.id,1,'PENDING',5,
  jsonb_build_object('version',1,'stage',COALESCE(k.stage::text,'READY'),'legacyAttemptCount',r."attemptCount",
    'authorization',jsonb_build_object('ownerUserId',r."ownerUserId",'sessionVersion',u."sessionVersion")),
  public.auth_now(),public.auth_now(),r.id,k.id
FROM "AdminCommandReceipt" r JOIN "User" u ON u.id=r."ownerUserId"
LEFT JOIN "KeyRotationRun" k ON k."receiptId"=r.id
WHERE r.status NOT IN ('SUCCEEDED','FAILED');

CREATE FUNCTION public.require_admin_task(receipt_id TEXT) RETURNS public."DurableTask"
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE task public."DurableTask"%ROWTYPE;
BEGIN
  SELECT * INTO task FROM public."DurableTask" WHERE "adminReceiptId"=receipt_id FOR UPDATE;
  IF NOT FOUND OR task.status<>'RUNNING' OR task."leaseUntil"<=public.auth_now()
    OR current_setting('serendipity.task_id',true) IS DISTINCT FROM task.id
    OR current_setting('serendipity.task_owner',true) IS DISTINCT FROM task."leaseOwner"
    OR current_setting('serendipity.task_fence',true) IS DISTINCT FROM task."fencingToken"::text
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='The current durable task lease is required'; END IF;
  RETURN task;
END;
$$;

CREATE OR REPLACE FUNCTION public.protect_admin_command_receipt() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE current_clock TIMESTAMPTZ:=public.auth_now(); task public."DurableTask"%ROWTYPE;
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Administrative history cannot be truncated'; END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.status NOT IN ('SUCCEEDED','FAILED') OR OLD."expiresAt">current_clock
      OR EXISTS(SELECT 1 FROM public."KeyRotationRun" WHERE "receiptId"=OLD.id)
      OR EXISTS(SELECT 1 FROM public."DurableTask" WHERE "adminReceiptId"=OLD.id)
    THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Administrative history is retained'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status NOT IN ('PENDING','SUCCEEDED') OR NEW."createdAt">current_clock
      OR NEW."attemptCount"<>0 OR NEW."fencingToken"<>0 OR NEW."leaseOwner" IS NOT NULL OR NEW."leaseUntil" IS NOT NULL
      OR NEW."completedAt">current_clock THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Receipts start pending or atomically completed'; END IF;
    IF NEW.status='SUCCEEDED' THEN NEW."completedAt":=current_clock;
      NEW."expiresAt":=GREATEST(NEW."expiresAt",current_clock+INTERVAL '24 hours'); END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('SUCCEEDED','FAILED') OR NEW."expiresAt"<OLD."expiresAt"
    OR ROW(NEW.id,NEW."ownerUserId",NEW."operationId",NEW."resourceId",NEW."idempotencyKeyHash",NEW."requestHash",NEW."createdAt",
      NEW."leaseOwner",NEW."leaseUntil",NEW."fencingToken",NEW."attemptCount")
    IS DISTINCT FROM ROW(OLD.id,OLD."ownerUserId",OLD."operationId",OLD."resourceId",OLD."idempotencyKeyHash",OLD."requestHash",OLD."createdAt",
      OLD."leaseOwner",OLD."leaseUntil",OLD."fencingToken",OLD."attemptCount")
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Receipt identity, historical lease and terminal response are immutable'; END IF;
  task:=public.require_admin_task(OLD.id);
  IF (NEW.status='RUNNING' AND OLD.status NOT IN ('PENDING','RETRY_WAIT','RUNNING')) OR
    (NEW.status<>'RUNNING' AND (OLD.status<>'RUNNING' OR NEW.status NOT IN ('RETRY_WAIT','SUCCEEDED','FAILED')))
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Receipt progress cannot move backwards'; END IF;
  IF NEW."completedAt">current_clock THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Completion cannot be future dated'; END IF;
  IF NEW.status IN ('SUCCEEDED','FAILED') THEN NEW."completedAt":=current_clock;
    NEW."expiresAt":=GREATEST(NEW."expiresAt",current_clock+INTERVAL '24 hours'); END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.protect_key_rotation_run() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  command public."AdminCommandReceipt"%ROWTYPE;
  task public."DurableTask"%ROWTYPE;
  current_clock TIMESTAMPTZ := public.auth_now();
  checkpoint_keys INTEGER;
  revision_keys INTEGER;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Rotation checkpoints are retained with their key audit history';
  END IF;
  SELECT * INTO command FROM public."AdminCommandReceipt" WHERE id=NEW."receiptId" FOR UPDATE;
  IF NOT FOUND OR command.status <> 'RUNNING' OR command."resourceId" <> NEW."oldKeyId" THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='A rotation checkpoint requires its running receipt';
  END IF;
  task:=public.require_admin_task(command.id);
  IF jsonb_typeof(NEW."checkpointJson") <> 'object' OR jsonb_typeof(NEW."baseRevisionsJson") <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='A rotation checkpoint has a controlled shape';
  END IF;
  SELECT count(*) INTO checkpoint_keys FROM jsonb_object_keys(NEW."checkpointJson");
  SELECT count(*) INTO revision_keys FROM jsonb_object_keys(NEW."baseRevisionsJson");
  IF checkpoint_keys < 3 OR checkpoint_keys > 5
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(NEW."checkpointJson") name WHERE name NOT IN ('version','fencingToken','step','errorCode','verificationHash'))
    OR NEW."checkpointJson"->'version' IS DISTINCT FROM '1'::jsonb
    OR NEW."checkpointJson"->'fencingToken' IS DISTINCT FROM to_jsonb(task."fencingToken")
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
