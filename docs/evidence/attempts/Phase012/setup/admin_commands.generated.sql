-- CreateEnum
CREATE TYPE "AdminCommandStatus" AS ENUM ('PENDING', 'RUNNING', 'RETRY_WAIT', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "KeyRotationStage" AS ENUM ('PREPARING', 'TESTING', 'READY', 'ACTIVATED', 'ABORTED');

-- CreateTable
CREATE TABLE "AdminCommandReceipt" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "operationId" VARCHAR(128) NOT NULL,
    "resourceId" VARCHAR(128) NOT NULL,
    "idempotencyKeyHash" CHAR(64) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "status" "AdminCommandStatus" NOT NULL DEFAULT 'PENDING',
    "responseJson" JSONB,
    "errorCode" VARCHAR(64),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" VARCHAR(128),
    "leaseUntil" TIMESTAMPTZ(3),
    "fencingToken" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AdminCommandReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeyRotationRun" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "oldKeyId" TEXT NOT NULL,
    "newKeyId" TEXT,
    "candidateIdsJson" JSONB NOT NULL DEFAULT '[]',
    "referenceSetHash" CHAR(64) NOT NULL,
    "baseRevisionsJson" JSONB NOT NULL,
    "stage" "KeyRotationStage" NOT NULL DEFAULT 'PREPARING',
    "checkpointJson" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "KeyRotationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminCommandReceipt_status_availableAt_leaseUntil_id_idx" ON "AdminCommandReceipt"("status", "availableAt", "leaseUntil", "id");

-- CreateIndex
CREATE INDEX "AdminCommandReceipt_expiresAt_idx" ON "AdminCommandReceipt"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminCommandReceipt_ownerUserId_operationId_resourceId_idem_key" ON "AdminCommandReceipt"("ownerUserId", "operationId", "resourceId", "idempotencyKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "KeyRotationRun_receiptId_key" ON "KeyRotationRun"("receiptId");

-- CreateIndex
CREATE INDEX "KeyRotationRun_oldKeyId_idx" ON "KeyRotationRun"("oldKeyId");

-- CreateIndex
CREATE INDEX "KeyRotationRun_newKeyId_idx" ON "KeyRotationRun"("newKeyId");

-- CreateIndex
CREATE INDEX "KeyRotationRun_stage_updatedAt_id_idx" ON "KeyRotationRun"("stage", "updatedAt", "id");

-- CreateIndex
CREATE INDEX "User_createdAt_id_idx" ON "User"("createdAt", "id");

-- CreateIndex
CREATE INDEX "User_role_status_id_idx" ON "User"("role", "status", "id");

-- AddForeignKey
ALTER TABLE "AdminCommandReceipt" ADD CONSTRAINT "AdminCommandReceipt_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "KeyRotationRun" ADD CONSTRAINT "KeyRotationRun_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "AdminCommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "KeyRotationRun" ADD CONSTRAINT "KeyRotationRun_oldKeyId_fkey" FOREIGN KEY ("oldKeyId") REFERENCES "ApiKeyConfig"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "KeyRotationRun" ADD CONSTRAINT "KeyRotationRun_newKeyId_fkey" FOREIGN KEY ("newKeyId") REFERENCES "ApiKeyConfig"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
