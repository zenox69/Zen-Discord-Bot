import { registerSlashCommands } from "../src/utils/registerCommands.js";

/**
 * Deploys all slash commands to Discord (manual trigger).
 *  - With GUILD_ID set (comma-separated allowlist): instant registration to
 *    EVERY listed guild.
 *  - Without GUILD_ID: global registration (may take up to ~1 hour).
 * The same logic also runs automatically at bot startup for allowlisted
 * guilds (see src/events/ready.ts).
 *
 * Usage: npm run deploy-commands
 */
async function main(): Promise<void> {
  const count = await registerSlashCommands();
  console.log(`✅ Done — ${count} command registration(s).`);
}

main().catch((err) => {
  console.error("❌ Failed to deploy slash commands:", err);
  process.exit(1);
});