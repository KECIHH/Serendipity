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

-- CreateTable
CREATE TABLE "ChatCommand" (
    "id" TEXT NOT NULL,
    "travelRecordId" TEXT NOT NULL,
    "ownerKeyHash" CHAR(64) NOT NULL,
    "kind" "ChatCommandKind" NOT NULL,
    "idempotencyKeyHash" CHAR(64) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "payloadRef" VARCHAR(128),
    "payloadSchemaVersion" INTEGER,
    "status" "ChatCommandStatus" NOT NULL DEFAULT 'PENDING',
    "userMessageId" TEXT NOT NULL,
    "assistantMessageId" TEXT,
    "traceId" VARCHAR(36) NOT NULL,
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
    "sequence" BIGSERIAL NOT NULL,
    "aggregateId" VARCHAR(128) NOT NULL,
    "traceId" VARCHAR(36) NOT NULL,
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
    "payloadRef" VARCHAR(128),
    "payloadSchemaVersion" INTEGER,
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
