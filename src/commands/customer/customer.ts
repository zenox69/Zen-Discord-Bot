import { SlashCommandBuilder } from "@discordjs/builders";
import { AppError } from "../../utils/errors.js";
import { buildCustomerProfile } from "../../services/CustomerService.js";
import type { MarketplaceCommand } from "../../handlers/commandHandler.js";

export const customerCommand: MarketplaceCommand = {
  requireStaff: true,
  data: new SlashCommandBuilder()
    .setName("customer")
    .setDescription("Staff customer tools")
    .addSubcommand((sub) =>
      sub
        .setName("profile")
        .setDescription("View a customer profile")
        .addUserOption((option) =>
          option.setName("user").setDescription("Customer (defaults to you)"),
        ),
    ),
  execute: async (interaction) => {
    const guildId = interaction.guildId;
    if (!guildId) {
      throw new AppError({ code: "NO_GUILD", friendly: "❌ This command requires a server." });
    }
    const target = interaction.options.getUser("user") ?? interaction.user;
    const view = await buildCustomerProfile(guildId, target.id);
    await interaction.reply({ ...view, ephemeral: true });
  },
};
