-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorEmailSnapshot" VARCHAR(254),
    "action" VARCHAR(64) NOT NULL,
    "targetType" VARCHAR(64) NOT NULL,
    "targetId" VARCHAR(128),
    "requestId" VARCHAR(36),
    "traceId" VARCHAR(36),
    "detailJson" JSONB,
    "ipHash" CHAR(64),
    "userAgentSummary" VARCHAR(256),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_createdAt_idx" ON "AuditLog"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_requestId_idx" ON "AuditLog"("requestId");

-- CreateIndex
CREATE INDEX "AuditLog_traceId_idx" ON "AuditLog"("traceId");

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
