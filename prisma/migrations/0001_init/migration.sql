-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('PREPARING', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_ISSUES', 'FAILED');
CREATE TYPE "RecipientStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'REJECTED', 'SENT', 'FAILED', 'DELIVERY_UNKNOWN');
CREATE TYPE "EnqueueState" AS ENUM ('NOT_READY', 'READY_TO_QUEUE', 'QUEUED', 'PROCESSING', 'TERMINAL');
CREATE TYPE "RejectionReason" AS ENUM ('EMAIL_MISSING', 'EMAIL_INVALID_FORMAT', 'DUPLICATE_EMAIL');
CREATE TYPE "DeliveryFailureReason" AS ENUM ('SMTP_REJECTED', 'SMTP_TIMEOUT', 'CONNECTION_ERROR', 'RETRIES_EXHAUSTED', 'OTHER');
CREATE TYPE "AttemptStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED', 'UNKNOWN');

-- CreateTable: Recipient
CREATE TABLE "Recipient" (
    "id" BIGSERIAL NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Recipient_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Recipient_id_idx" ON "Recipient"("id");

-- CreateTable: Campaign
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'PREPARING',
    "snapshotMaxRecipientId" BIGINT NOT NULL DEFAULT 0,
    "preparationCursor" BIGINT NOT NULL DEFAULT 0,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "pendingCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "deliveryUnknownCount" INTEGER NOT NULL DEFAULT 0,
    "totalDeliveryAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

-- Single active campaign invariant (Constitution II). A partial unique index on a
-- constant expression allows at most one row whose status is PREPARING or RUNNING.
CREATE UNIQUE INDEX "one_active_campaign" ON "Campaign" ((TRUE))
    WHERE "status" IN ('PREPARING', 'RUNNING');

-- CreateTable: CampaignRecipient
CREATE TABLE "CampaignRecipient" (
    "id" SERIAL NOT NULL,
    "campaignId" TEXT NOT NULL,
    "sourceRecipientId" BIGINT NOT NULL,
    "snapshotEmail" TEXT,
    "normalizedEmail" TEXT,
    "snapshotName" TEXT,
    "personalizedName" TEXT NOT NULL DEFAULT 'Customer',
    "status" "RecipientStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" "RejectionReason",
    "deliveryFailureReason" "DeliveryFailureReason",
    "duplicateOfId" INTEGER,
    "deliveryAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "enqueueState" "EnqueueState" NOT NULL DEFAULT 'NOT_READY',
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "attemptStartedAt" TIMESTAMP(3),
    "terminalAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- One row per source recipient in the snapshot (makes preparation idempotent).
CREATE UNIQUE INDEX "CampaignRecipient_campaignId_sourceRecipientId_key"
    ON "CampaignRecipient"("campaignId", "sourceRecipientId");

-- Canonical accepted normalized email is unique within a campaign. Duplicate
-- source rows still get their own row but lose this claim -> DUPLICATE_EMAIL.
CREATE UNIQUE INDEX "campaign_accepted_email_unique"
    ON "CampaignRecipient"("campaignId", "normalizedEmail")
    WHERE "normalizedEmail" IS NOT NULL AND "status" <> 'REJECTED';

CREATE INDEX "CampaignRecipient_campaignId_enqueueState_id_idx"
    ON "CampaignRecipient"("campaignId", "enqueueState", "id");
CREATE INDEX "CampaignRecipient_campaignId_status_idx"
    ON "CampaignRecipient"("campaignId", "status");
CREATE INDEX "CampaignRecipient_status_leaseExpiresAt_idx"
    ON "CampaignRecipient"("status", "leaseExpiresAt");

-- CreateTable: DeliveryAttempt
CREATE TABLE "DeliveryAttempt" (
    "id" SERIAL NOT NULL,
    "campaignRecipientId" INTEGER NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "jobId" TEXT NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'STARTED',
    "smtpResponse" TEXT,
    "acceptanceDefinitive" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeliveryAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DeliveryAttempt_campaignRecipientId_idx" ON "DeliveryAttempt"("campaignRecipientId");

-- Foreign keys
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_sourceRecipientId_fkey"
    FOREIGN KEY ("sourceRecipientId") REFERENCES "Recipient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_duplicateOfId_fkey"
    FOREIGN KEY ("duplicateOfId") REFERENCES "CampaignRecipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DeliveryAttempt" ADD CONSTRAINT "DeliveryAttempt_campaignRecipientId_fkey"
    FOREIGN KEY ("campaignRecipientId") REFERENCES "CampaignRecipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
