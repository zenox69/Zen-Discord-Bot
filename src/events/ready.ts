import { ActivityType, type Client } from "discord.js";
import { log } from "../utils/logger.js";
import { startJobs } from "../jobs/index.js";
import { allowedGuildIds, isGuildAllowed } from "../config/guildAllowlist.js";
import { registerSlashCommands } from "../utils/registerCommands.js";
import { voiceService } from "../services/VoiceService.js";

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
    // Auto-register slash commands to every allowlisted guild so a freshly
    // added guild gets them immediately on the next deploy. Errors are
    // non-fatal — the bot still comes online.
    void registerSlashCommands().catch((err) => log.error("Failed to auto-register slash commands", err));
  }
  // Voice: rejoin any channel the bot was parked in before the restart.
  // Non-fatal — the bot still comes online even if a rejoin is impossible
  // (the service clears stale targets itself).
  voiceService.logDependencyReport();
  void voiceService.rejoinPersisted(client).catch((err) => log.error("Failed to rejoin persisted voice channels", err));
  startJobs(client);
  log.info(
    allowedGuildIds.size > 0
      ? `Logged in as ${client.user.tag} — allowlist active (${allowedGuildIds.size} guild(s)), serving ${client.guilds.cache.size}.`
      : `Logged in as ${client.user.tag} — serving ${client.guilds.cache.size} guild(s).`,
  );
}
