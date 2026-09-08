import { ActivityType, type Client } from "discord.js";
import { log } from "../utils/logger.js";
import { startJobs } from "../jobs/index.js";
import { allowedGuildIds, isGuildAllowed } from "../config/guildAllowlist.js";

export function onReady(client: Client): void {
  if (!client.user) return;
  client.user.setPresence({
    activities: [{ name: "Marketplace | /setup", type: ActivityType.Watching }],
    status: "online",
  });
  // Guild allowlist: proactively leave any server that is not listed when
  // GUILD_ID is configured (covers servers joined while the bot was offline).
  if (allowedGuildIds.size > 0) {
    for (const guild of client.guilds.cache.values()) {
      if (!isGuildAllowed(guild.id)) {
        log.warn(`Guild "${guild.name}" (${guild.id}) is not allowlisted — leaving.`);
        void guild
          .leave()
          .then(() => log.info(`Left non-allowlisted guild "${guild.name}" (${guild.id}).`))
          .catch((err) => log.error(`Failed to leave non-allowlisted guild ${guild.id}`, err));
      }
    }
  }
  startJobs(client);
  log.info(
    allowedGuildIds.size > 0
      ? `Logged in as ${client.user.tag} — allowlist active (${allowedGuildIds.size} guild(s)), serving ${client.guilds.cache.size}.`
      : `Logged in as ${client.user.tag} — serving ${client.guilds.cache.size} guild(s).`,
  );
}
