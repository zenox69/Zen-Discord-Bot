import type { Client, Guild } from "discord.js";
import { ensureGuild } from "../services/GuildSettingsService.js";
import { log } from "../utils/logger.js";

export function onGuildCreate(_client: Client, guild: Guild): void {
  void ensureGuild(guild.id, guild.name)
    .then(() => log.info(`Joined guild "${guild.name}" (${guild.id}) — run /setup to configure.`))
    .catch((err) => log.error(`Failed to register guild ${guild.id}`, err));
}
