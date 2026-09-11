-- CreateEnum
CREATE TYPE "TravelStatus" AS ENUM ('DRAFT', 'NEEDS_INFO', 'PLANNED', 'MODIFIED', 'FINALIZED', 'NEEDS_REVALIDATION', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ChatMessageKind" AS ENUM ('TEXT', 'STRUCTURED');

-- CreateTable
CREATE TABLE "TravelRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "anonTokenHash" CHAR(64),
    "title" TEXT NOT NULL,
    "status" "TravelStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "requirementJson" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TravelRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "travelRecordId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "kind" "ChatMessageKind" NOT NULL,
    "content" TEXT NOT NULL,
    "contentJson" JSONB,
    "sequence" INTEGER NOT NULL,
    "clientMessageId" TEXT,
    "replyToMessageId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TravelRecord_userId_createdAt_id_idx" ON "TravelRecord"("userId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "TravelRecord_anonTokenHash_createdAt_id_idx" ON "TravelRecord"("anonTokenHash", "createdAt", "id");

-- CreateIndex
CREATE INDEX "TravelRecord_status_updatedAt_id_idx" ON "TravelRecord"("status", "updatedAt", "id");

-- CreateIndex
CREATE INDEX "ChatMessage_replyToMessageId_idx" ON "ChatMessage"("replyToMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_travelRecordId_sequence_key" ON "ChatMessage"("travelRecordId", "sequence");

-- CreateIndex

-- AddForeignKey
ALTER TABLE "TravelRecord" ADD CONSTRAINT "TravelRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_travelRecordId_fkey" FOREIGN KEY ("travelRecordId") REFERENCES "TravelRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_replyToMessageId_fkey" FOREIGN KEY ("replyToMessageId") REFERENCES "ChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Ownership and ordering are enforced even when bypassing repository helpers.
ALTER TABLE "TravelRecord" ADD CONSTRAINT "TravelRecord_owner_xor" CHECK (("userId" IS NOT NULL) <> ("anonTokenHash" IS NOT NULL));
ALTER TABLE "TravelRecord" ADD CONSTRAINT "TravelRecord_anonTokenHash_format" CHECK ("anonTokenHash" IS NULL OR "anonTokenHash"::text ~ '^[0-9a-f]{64}$');
ALTER TABLE "TravelRecord" ADD CONSTRAINT "TravelRecord_version_nonnegative" CHECK ("version" >= 0);
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_sequence_positive" CHECK ("sequence" > 0);
