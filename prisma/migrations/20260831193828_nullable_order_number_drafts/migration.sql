-- AlterTable
ALTER TABLE "orders" ALTER COLUMN "number" DROP NOT NULL;

-- DataFix: DRAFT rows historically stored an empty-string number; move them
-- to NULL so the (guildId, number) unique allows multiple drafts.
UPDATE "orders" SET "number" = NULL WHERE "status" = 'DRAFT';
