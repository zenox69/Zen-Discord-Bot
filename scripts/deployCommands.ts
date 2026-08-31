import { REST, Routes } from "discord.js";
import { env } from "../src/config/env.js";
import { allCommands } from "../src/commands/index.js";

/**
 * Deploys all slash commands to Discord.
 *  - With GUILD_ID set: instant, guild-scoped registration (development).
 *  - Without GUILD_ID: global registration (may take up to ~1 hour).
 *
 * Usage: npm run deploy-commands
 */
async function main(): Promise<void> {
  const body = allCommands.map((c) => c.data.toJSON());
  const rest = new REST().setToken(env.DISCORD_TOKEN);

  const route = env.GUILD_ID
    ? Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.GUILD_ID)
    : Routes.applicationCommands(env.DISCORD_CLIENT_ID);

  const data = (await rest.put(route, { body })) as Array<{ name: string }>;
  console.log(
    `✅ Registered ${data.length} slash command(s) ${
      env.GUILD_ID ? `to guild ${env.GUILD_ID}` : "globally"
    }:`,
  );
  for (const cmd of data) console.log(`   • /${cmd.name}`);
}

main().catch((err) => {
  console.error("❌ Failed to deploy slash commands:", err);
  process.exit(1);
});
