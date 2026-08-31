import { SlashCommandBuilder } from "@discordjs/builders";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { CUSTOM_ID_PREFIX, LIMITS, cid } from "../../config/constants.js";
import { prisma } from "../../database/prisma.js";
import { roblox } from "../../services/RobloxService.js";
import { VerificationService } from "../../services/VerificationService.js";
import { findSettings } from "../../services/GuildSettingsService.js";
import { successEmbed } from "../../utils/embeds.js";
import { AppError } from "../../utils/errors.js";
import { deferEphemeral, smartReply } from "../../utils/interactionReply.js";
import { daysSince, tDate } from "../../utils/discordTime.js";
import { rateLimiter, retryPhrase } from "../../utils/rateLimiter.js";
import { requireStaff } from "../../utils/permissions.js";
import type { MarketplaceCommand } from "../../handlers/commandHandler.js";

async function profile(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This command requires a server." });

  const rl = rateLimiter.consume(
    `profile:${interaction.user.id}`,
    LIMITS.profileCommand.limit,
    LIMITS.profileCommand.windowMs,
  );
  if (!rl.ok) throw new AppError({ code: "RATE_LIMITED", friendly: retryPhrase(rl.retryAfterMs) });

  const targetUser = interaction.options.getUser("user") ?? interaction.user;

  const account = await prisma.robloxAccount.findUnique({ where: { discordUserId: targetUser.id } });
  if (!account) {
    throw new AppError({
      code: "NOT_VERIFIED",
      friendly: `❌ ${targetUser.id === interaction.user.id ? "You" : targetUser} has no verified Roblox account${
        targetUser.id === interaction.user.id ? " — start with `/verify roblox`" : ""
      }.`,
    });
  }

  // Live Roblox fetches can exceed Discord's 3-second response window.
  await deferEphemeral(interaction);
  const profile = await roblox.getProfile(account.robloxUserId);
  if (!profile) {
    throw new AppError({
      code: "ROBLOX_GONE",
      friendly: "❌ That Roblox account no longer appears to exist.",
    });
  }

  // Avatar is decorative — never let it break the profile view.
  const avatarUrl = await roblox.getAvatarHeadshotUrl(account.robloxUserId).catch(() => null);

  const trackedCount = await prisma.communityMembership.count({
    where: {
      robloxUserId: account.robloxUserId,
      community: { guildId, enabled: true },
    },
  });

  const settings = await findSettings(guildId);
  const embed = successEmbed(
    "👤 ROBLOX PROFILE",
    [`**${profile.displayName}**`, `@${profile.name}`].join("\n"),
    settings?.marketplaceName,
  );
  embed
    .addFields(
      { name: "Display Name", value: profile.displayName, inline: true },
      { name: "Roblox ID", value: account.robloxUserId, inline: true },
      { name: "Account Created", value: tDate(profile.created), inline: true },
      { name: "Account Age", value: `${daysSince(profile.created).toLocaleString("en-US")} days`, inline: true },
      { name: "Verified Discord", value: `<@${account.discordUserId}>`, inline: true },
      { name: "Community Memberships", value: `${trackedCount} tracked communities`, inline: true },
    )
    .setTimestamp();
  if (avatarUrl) embed.setThumbnail(avatarUrl);

  await smartReply(interaction, {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setURL(roblox.profileUrl(account.robloxUserId))
          .setLabel("View Roblox Profile")
          .setStyle(ButtonStyle.Link),
        new ButtonBuilder()
          .setCustomId(cid(CUSTOM_ID_PREFIX.eligible, "show", targetUser.id))
          .setLabel("Check Eligibility")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

export const robloxCommand: MarketplaceCommand = {
  data: new SlashCommandBuilder()
    .setName("roblox")
    .setDescription("Roblox account tools")
    .addSubcommand((sub) =>
      sub
        .setName("profile")
        .setDescription("Show a verified Roblox profile")
        .addUserOption((opt) =>
          opt.setName("user").setDescription("Discord user to look up (defaults to you)"),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("unlink")
        .setDescription("Unlink a user's Roblox account (staff)")
        .addUserOption((opt) => opt.setName("user").setDescription("User to unlink").setRequired(true)),
    ),
  execute: async (interaction) => {
    const sub = interaction.options.getSubcommand();
    if (sub === "unlink") {
      // Staff-only branch: checked here because /roblox profile is public.
      const guildId = interaction.guildId;
      if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This command requires a server." });
      const settings = await findSettings(guildId);
      if (settings) requireStaff(interaction.member as GuildMember, settings);
      return VerificationService.unlinkTarget(interaction);
    }
    return profile(interaction);
  },
};
