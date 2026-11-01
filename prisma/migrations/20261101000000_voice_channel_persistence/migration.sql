-- Persist the /voice join target so the bot can rejoin after restarts/deploys
-- and recover the channel after connection drops. Additive, nullable, no data touched.
ALTER TABLE "guild_settings" ADD COLUMN "voiceChannelId" TEXT;
