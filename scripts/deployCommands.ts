import { REST, Routes } from "discord.js";
import { env } from "../src/config/env.js";
import { parseGuildAllowlist } from "../src/config/guildAllowlist.js";
import { allCommands } from "../src/commands/index.js";

/**
 * Deploys all slash commands to Discord.
 *  - With GUILD_ID set (comma-separated allowlist): instant registration to
 *    EVERY listed guild.
 *  - Without GUILD_ID: global registration (may take up to ~1 hour).
 *
 * Usage: npm run deploy-commands
 */
async function main(): Promise<void> {
  const body = allCommands.map((c) => c.data.toJSON());
  const rest = new REST().setToken(env.DISCORD_TOKEN);

  const guildIds = [...parseGuildAllowlist(env.GUILD_ID)];
  if (guildIds.length > 0) {
    let total = 0;
    for (const guildId of guildIds) {
      const data = (await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, guildId), {
        body,
      })) as Array<{ name: string }>;
      total += data.length;
      console.log(`✅ Registered ${data.length} slash command(s) to guild ${guildId}`);
    }
    console.log(`Done — ${total} registration(s) across ${guildIds.length} guild(s):`);
    for (const cmd of body) console.log(`   • /${cmd.name}`);
    return;
  }

  const data = (await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), {
    body,
  })) as Array<{ name: string }>;
  console.log(`✅ Registered ${data.length} slash command(s) globally:`);
  for (const cmd of data) console.log(`   • /${cmd.name}`);
}

main().catch((err) => {
  console.error("❌ Failed to deploy slash commands:", err);
  process.exit(1);
});
