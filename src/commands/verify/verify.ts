import { SlashCommandBuilder } from "@discordjs/builders";
import { VerificationService } from "../../services/VerificationService.js";
import type { MarketplaceCommand } from "../../handlers/commandHandler.js";

export const verifyCommand: MarketplaceCommand = {
  data: new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Link and manage your Roblox account")
    .addSubcommand((sub) =>
      sub
        .setName("roblox")
        .setDescription("Start Roblox account verification")
        .addStringOption((opt) =>
          opt.setName("username").setDescription("Your Roblox username").setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName("status").setDescription("Show your verification status"))
    .addSubcommand((sub) => sub.setName("unlink").setDescription("Unlink your verified Roblox account")),
  execute: (interaction) => {
    const sub = interaction.options.getSubcommand();
    switch (sub) {
      case "roblox":
        return VerificationService.start(interaction, interaction.options.getString("username") ?? "");
      case "status":
        return VerificationService.status(interaction);
      case "unlink":
        return VerificationService.unlinkSelf(interaction);
      default:
        return Promise.resolve();
    }
  },
};
