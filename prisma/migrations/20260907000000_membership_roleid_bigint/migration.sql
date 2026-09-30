-- Roblox roleset IDs now exceed the 32-bit INT range (observed: 12884901889).
-- Widen the membership roleId column to BIGINT; existing values are preserved.
ALTER TABLE "community_memberships" ALTER COLUMN "roleId" TYPE BIGINT;
