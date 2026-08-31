import { SlashCommandBuilder } from "@discordjs/builders";
import { GuildMember } from "discord.js";
import { prisma } from "../../database/prisma.js";
import { closeTicket, canCloseTicket, publishTicketPanel } from "../../services/TicketService.js";
import { baseEmbed, COLORS } from "../../utils/embeds.js";
import { AppError } from "../../utils/errors.js";
import { findSettings } from "../../services/GuildSettingsService.js";
import type { MarketplaceCommand } from "../../handlers/commandHandler.js";

export const ticketCommand: MarketplaceCommand = {
  requireAdmin: true,
  data: new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Ticket system management (admin)")
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("Publish the support/order panel to the panel channel"),
    )
    .addSubcommand((sub) => sub.setName("close").setDescription("Close the ticket in this channel")),
  execute: async (interaction) => {
    const guildId = interaction.guildId;
    if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This command requires a server." });
    const sub = interaction.options.getSubcommand();

    if (sub === "setup") {
      const channelId = await publishTicketPanel(guildId, "all");
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.success, (await findSettings(guildId))?.marketplaceName).setTitle(
            "✅ Ticket panel published",
          ).setDescription(`The panel is now live in the configured panel channel (\`${channelId}\`).`),
        ],
      });
      return;
    }

    // close (from inside a ticket channel)
    if (!interaction.channel || interaction.channel.partial) {
      throw new AppError({ code: "NO_CHANNEL", friendly: "❌ Run this inside a ticket channel." });
    }
    const channelId = interaction.channel.id;
    const ticket = await prisma.ticket.findUnique({ where: { channelId } });
    if (!ticket || ticket.guildId !== guildId) {
      throw new AppError({ code: "NO_TICKET_HERE", friendly: "❌ This channel is not a ticket." });
    }
    if (ticket.status === "CLOSED") {
      throw new AppError({ code: "TICKET_ALREADY_CLOSED", friendly: "❌ This ticket is already closed." });
    }
    const member = interaction.member as GuildMember;
    if (!(await canCloseTicket(guildId, member, ticket))) {
      throw new AppError({ code: "NOT_STAFF", friendly: "❌ Only the ticket owner or staff can close this ticket." });
    }
    await closeTicket({ guildId, ticketId: ticket.id, actorDiscordId: interaction.user.id, reason: "Closed via /ticket close" });
    await interaction.reply({
      embeds: [baseEmbed(COLORS.success).setTitle("✅ Ticket closed").setDescription("The channel will be deleted shortly.")],
    });
  },
};
