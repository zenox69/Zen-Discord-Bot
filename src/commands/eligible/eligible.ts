import { SlashCommandBuilder } from "@discordjs/builders";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type GuildMember,
} from "discord.js";
import { CUSTOM_ID_PREFIX, LIMITS, cid } from "../../config/constants.js";
import { prisma } from "../../database/prisma.js";
import { buildEligibilityView } from "../../services/EligibilityService.js";
import { findSettings } from "../../services/GuildSettingsService.js";
import { errorEmbed } from "../../utils/embeds.js";
import { AppError } from "../../utils/errors.js";
import { deferEphemeral, smartReply } from "../../utils/interactionReply.js";
import { rateLimiter, retryPhrase } from "../../utils/rateLimiter.js";
import { requireStaff } from "../../utils/permissions.js";
import type { MarketplaceCommand } from "../../handlers/commandHandler.js";

export const eligibleCommand: MarketplaceCommand = {
  data: new SlashCommandBuilder()
    .setName("eligible")
    .setDescription("Check Roblox community eligibility")
    .addUserOption((opt) => opt.setName("user").setDescription("Check another user (staff only)")),
  execute: async (interaction) => {
    const guildId = interaction.guildId;
    if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This command requires a server." });

    const rl = rateLimiter.consume(
      `eligible:${interaction.user.id}`,
      LIMITS.eligibleCommand.limit,
      LIMITS.eligibleCommand.windowMs,
    );
    if (!rl.ok) throw new AppError({ code: "RATE_LIMITED", friendly: retryPhrase(rl.retryAfterMs) });

    const targetUser = interaction.options.getUser("user") ?? interaction.user;
    const isSelf = targetUser.id === interaction.user.id;

    if (!isSelf) {
      const settings = await findSettings(guildId);
      if (settings) requireStaff(interaction.member as GuildMember, settings);
    }

    const account = await prisma.robloxAccount.findUnique({ where: { discordUserId: targetUser.id } });
    if (!account) {
      const settings = await findSettings(guildId);
      await interaction.reply({
        embeds: [
          errorEmbed(
            "❌ Roblox Account Not Verified",
            isSelf
              ? "You must verify your Roblox account before checking eligibility."
              : `${targetUser} has no verified Roblox account.`,
            settings?.marketplaceName,
          ),
        ],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(cid(CUSTOM_ID_PREFIX.verify, "start"))
              .setLabel("Verify Roblox Account")
              .setStyle(ButtonStyle.Primary),
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    const settings = await findSettings(guildId);
    // Live Roblox sync can exceed Discord's 3-second response window.
    await deferEphemeral(interaction);
    const view = await buildEligibilityView(
      account.robloxUserId,
      account.robloxDisplayName,
      account.robloxUsername,
      guildId,
      1,
      settings?.marketplaceName,
    );
    await smartReply(interaction, {
      embeds: view.embeds,
      components: view.components,
    });
  },
};
