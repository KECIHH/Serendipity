-- CreateEnum
CREATE TYPE "AuthSessionStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AuthLoginAttemptStatus" AS ENUM ('RESERVED', 'FAILED', 'SUCCEEDED', 'EXPIRED');

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "audience" VARCHAR(16) NOT NULL,
    "sessionVersion" INTEGER NOT NULL,
    "status" "AuthSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "issuedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthLoginAttempt" (
    "id" TEXT NOT NULL,
    "scope" VARCHAR(16) NOT NULL,
    "ipHash" CHAR(64) NOT NULL,
    "accountHash" CHAR(64) NOT NULL,
    "status" "AuthLoginAttemptStatus" NOT NULL DEFAULT 'RESERVED',
    "reservedUntil" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "requestId" VARCHAR(36) NOT NULL,

    CONSTRAINT "AuthLoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_tokenHash_key" ON "AuthSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthSession_userId_status_expiresAt_id_idx" ON "AuthSession"("userId", "status", "expiresAt", "id");

-- CreateIndex
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthLoginAttempt_requestId_key" ON "AuthLoginAttempt"("requestId");

-- CreateIndex
CREATE INDEX "AuthLoginAttempt_scope_ipHash_createdAt_idx" ON "AuthLoginAttempt"("scope", "ipHash", "createdAt");

-- CreateIndex
CREATE INDEX "AuthLoginAttempt_scope_accountHash_createdAt_idx" ON "AuthLoginAttempt"("scope", "accountHash", "createdAt");

-- CreateIndex
CREATE INDEX "AuthLoginAttempt_status_reservedUntil_id_idx" ON "AuthLoginAttempt"("status", "reservedUntil", "id");

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
