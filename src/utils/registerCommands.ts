import { REST, Routes } from "discord.js";
import { env } from "../config/env.js";
import { parseGuildAllowlist } from "../config/guildAllowlist.js";
import { allCommands } from "../commands/index.js";
import { log } from "./logger.js";

/**
 * Registers all slash commands to Discord.
 *  - GUILD_ID set (allowlist): registers to EVERY allowlisted guild (instant).
 *  - GUILD_ID unset: global registration (slow, up to ~1h to propagate) — used
 *    by the manual script; the bot itself skips auto-registration in this mode.
 *
 * Called automatically at startup (onReady) so allowlisted guilds always have
 * the current commands after any deploy, and by scripts/deployCommands.ts.
 * Returns the number of command registrations written.
 */
export async function registerSlashCommands(): Promise<number> {
  const body = allCommands.map((c) => c.data.toJSON());
  const rest = new REST().setToken(env.DISCORD_TOKEN);
  const guildIds = [...parseGuildAllowlist(env.GUILD_ID)];

  if (guildIds.length === 0) {
    const data = (await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), {
      body,
    })) as Array<{ name: string }>;
    log.info(`Registered ${data.length} slash command(s) globally`);
    return data.length;
  }

  let count = 0;
  for (const guildId of guildIds) {
    const data = (await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, guildId), {
      body,
    })) as Array<{ name: string }>;
    count += data.length;
    log.info(`Registered ${data.length} slash command(s) to guild ${guildId}`);
  }
  return count;
}