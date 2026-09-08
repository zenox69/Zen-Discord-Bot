import type { Client, Interaction } from "discord.js";
import { allCommands } from "../commands/index.js";
import { runCommand } from "../handlers/commandHandler.js";
import { routeInteraction } from "../handlers/interactionHandler.js";
import { isGuildAllowed } from "../config/guildAllowlist.js";
import { log } from "../utils/logger.js";

const commandMap = new Map(allCommands.map((c) => [c.data.name, c]));

export async function onInteractionCreate(client: Client, interaction: Interaction): Promise<void> {
  try {
    // Guild allowlist: when GUILD_ID is set, interactions from any other
    // server (and DMs) are silently ignored — the bot never operates there.
    if (!isGuildAllowed(interaction.guildId ?? null)) {
      log.warn(
        `Blocked interaction from non-allowlisted guild ${interaction.guildId ?? "(DM)"} by ${interaction.user.id}`,
      );
      return;
    }
    if (interaction.isChatInputCommand()) {
      const command = commandMap.get(interaction.commandName);
      if (!command) {
        log.warn(`Unknown slash command /${interaction.commandName}`);
        return;
      }
      await runCommand(command, interaction);
      return;
    }
    if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
      await routeInteraction(interaction);
      return;
    }
  } catch (err) {
    // Defense in depth — command/interaction routing already reports errors.
    log.error("Unhandled interaction error", err);
  }
}
