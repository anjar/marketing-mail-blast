-- Clear ALL campaign + recipient test data.
-- Order respects FKs: attempts -> campaign_recipients -> campaigns, then recipients.
-- Safe to run before seeding a fresh scale.

BEGIN;

TRUNCATE TABLE "DeliveryAttempt" RESTART IDENTITY CASCADE;
TRUNCATE TABLE "CampaignRecipient" RESTART IDENTITY CASCADE;
TRUNCATE TABLE "Campaign" RESTART IDENTITY CASCADE;
TRUNCATE TABLE "Recipient" RESTART IDENTITY CASCADE;

COMMIT;

\echo 'Cleared all campaign + recipient data.'
