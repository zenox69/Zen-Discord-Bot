-- AlterTable
ALTER TABLE "roblox_accounts" ADD COLUMN     "robloxApiKeyCreatedAt" TIMESTAMP(3),
ADD COLUMN     "robloxApiKeyEncrypted" TEXT,
ADD COLUMN     "robloxApiKeyValidatedAt" TIMESTAMP(3);
