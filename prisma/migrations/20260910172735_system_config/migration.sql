-- CreateTable
CREATE TABLE "SystemConfig" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueJson" JSONB NOT NULL,
    "description" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SystemConfig_key_key" ON "SystemConfig"("key");

-- CreateIndex
CREATE INDEX "SystemConfig_group_key_idx" ON "SystemConfig"("group", "key");

-- CreateIndex
CREATE INDEX "SystemConfig_updatedBy_idx" ON "SystemConfig"("updatedBy");

-- AddForeignKey
ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Keep direct SQL writes within the same closed group and revision contract.
ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_group_check" CHECK ("group" IN ('AI', 'UI', 'EXPORT', 'SECURITY', 'GENERAL'));
ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_revision_nonnegative" CHECK ("revision" >= 0);
