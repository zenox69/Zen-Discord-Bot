import type { Client, Guild } from "discord.js";
import { ensureGuild } from "../services/GuildSettingsService.js";
import { isGuildAllowed } from "../config/guildAllowlist.js";
import { log } from "../utils/logger.js";

export function onGuildCreate(_client: Client, guild: Guild): void {
  // Guild allowlist: if GUILD_ID is set and this server is not on it, leave
  // immediately instead of configuring anything.
  if (!isGuildAllowed(guild.id)) {
    log.warn(
      `Guild "${guild.name}" (${guild.id}) is not on the GUILD_ID allowlist — leaving.`,
    );
    void guild
      .leave()
      .then(() => log.info(`Left non-allowlisted guild "${guild.name}" (${guild.id}).`))
      .catch((err) => log.error(`Failed to leave non-allowlisted guild ${guild.id}`, err));
    return;
  }
  void ensureGuild(guild.id, guild.name)
    .then(() => log.info(`Joined guild "${guild.name}" (${guild.id}) — run /setup to configure.`))
    .catch((err) => log.error(`Failed to register guild ${guild.id}`, err));
}
