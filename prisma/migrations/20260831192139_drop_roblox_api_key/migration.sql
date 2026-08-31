/*
  Warnings:

  - You are about to drop the column `robloxApiKeyCreatedAt` on the `roblox_accounts` table. All the data in the column will be lost.
  - You are about to drop the column `robloxApiKeyEncrypted` on the `roblox_accounts` table. All the data in the column will be lost.
  - You are about to drop the column `robloxApiKeyValidatedAt` on the `roblox_accounts` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "roblox_accounts" DROP COLUMN "robloxApiKeyCreatedAt",
DROP COLUMN "robloxApiKeyEncrypted",
DROP COLUMN "robloxApiKeyValidatedAt";
