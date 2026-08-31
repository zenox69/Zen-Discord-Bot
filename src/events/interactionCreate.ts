import type { Client, Interaction } from "discord.js";
import { allCommands } from "../commands/index.js";
import { runCommand } from "../handlers/commandHandler.js";
import { routeInteraction } from "../handlers/interactionHandler.js";
import { log } from "../utils/logger.js";

const commandMap = new Map(allCommands.map((c) => [c.data.name, c]));

export async function onInteractionCreate(client: Client, interaction: Interaction): Promise<void> {
  try {
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
