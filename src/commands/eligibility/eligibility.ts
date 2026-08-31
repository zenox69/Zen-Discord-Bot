import { SlashCommandBuilder } from "@discordjs/builders";
import { AuditCategory } from "@prisma/client";
import { audit } from "../../services/AuditService.js";
import {
  getCommunityEligibility,
  syncMemberships,
} from "../../services/EligibilityService.js";
import { findCommunityByName } from "../../services/CommunityService.js";
import { prisma } from "../../database/prisma.js";
import { findSettings } from "../../services/GuildSettingsService.js";
import { baseEmbed, COLORS } from "../../utils/embeds.js";
import { tDate } from "../../utils/discordTime.js";
import { AppError } from "../../utils/errors.js";
import { deferEphemeral, smartReply } from "../../utils/interactionReply.js";
import { parseDateLenient, sanitizeInput } from "../../utils/text.js";
import type { MarketplaceCommand } from "../../handlers/commandHandler.js";

export const eligibilityCommand: MarketplaceCommand = {
  requireStaff: true,
  data: new SlashCommandBuilder()
    .setName("eligibility")
    .setDescription("Eligibility management (staff)")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Set a staff-verified membership start date")
        .addUserOption((o) => o.setName("user").setDescription("Discord user").setRequired(true))
        .addStringOption((o) => o.setName("community").setDescription("Community name").setRequired(true))
        .addStringOption((o) => o.setName("started-at").setDescription("Membership start date (YYYY-MM-DD)").setRequired(true))
        .addStringOption((o) => o.setName("reason").setDescription("Why this date is verified").setRequired(true)),
    ),
  execute: async (interaction) => {
    const guildId = interaction.guildId;
    if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This command requires a server." });

    const target = interaction.options.getUser("user");
    if (!target) throw new AppError({ code: "MISSING_USER", friendly: "❌ Please provide a user." });
    const communityRaw = interaction.options.getString("community") ?? "";
    const startedRaw = interaction.options.getString("started-at") ?? "";
    const reason = sanitizeInput(interaction.options.getString("reason") ?? "", 300);
    if (reason.length < 3) {
      throw new AppError({ code: "INVALID_REASON", friendly: "❌ A reason (at least 3 characters) is required." });
    }

    const account = await prisma.robloxAccount.findUnique({ where: { discordUserId: target.id } });
    if (!account) {
      throw new AppError({ code: "NOT_VERIFIED", friendly: `❌ ${target} has no verified Roblox account.` });
    }

    const startedAt = parseDateLenient(startedRaw);
    if (!startedAt) {
      throw new AppError({ code: "INVALID_DATE", friendly: "❌ Could not parse that date — use **YYYY-MM-DD**." });
    }
    if (startedAt.getTime() > Date.now()) {
      throw new AppError({ code: "FUTURE_DATE", friendly: "❌ The start date cannot be in the future." });
    }

    const community = await findCommunityByName(guildId, communityRaw);

    // Live membership reconcile + final eligibility check can exceed the
    // 3-second interaction window.
    await deferEphemeral(interaction);
    await syncMemberships(account.robloxUserId, guildId);
    const membership = await prisma.communityMembership.findUnique({
      where: {
        robloxUserId_communityId: { robloxUserId: account.robloxUserId, communityId: community.id },
      },
    });
    if (!membership) {
      throw new AppError({
        code: "NO_MEMBERSHIP",
        friendly: `❌ That user has no tracked membership in **${community.name}** (they must be a member first).`,
      });
    }

    const previousStartedAt = membership.membershipStartedAt;
    await prisma.$transaction(async (tx) => {
      await tx.communityMembership.update({
        where: { id: membership.id },
        data: {
          membershipStartedAt: startedAt,
          membershipDateSource: "STAFF_VERIFIED",
          eligibilityNotificationSentAt: null,
          eligibilityNotificationLastAttemptAt: null,
        },
      });
      await tx.eligibilityOverride.create({
        data: {
          membershipId: membership.id,
          startedAt,
          previousStartedAt,
          reason,
          setByDiscordId: interaction.user.id,
        },
      });
    });

    await audit({
      category: AuditCategory.ELIGIBILITY,
      action: "OVERRIDE_SET",
      guildId,
      actorDiscordId: interaction.user.id,
      targetDiscordId: target.id,
      details: {
        community: community.name,
        robloxUserId: account.robloxUserId,
        startedAt: startedAt.toISOString(),
        previousStartedAt: previousStartedAt.toISOString(),
        reason,
      },
    });

    const entry = await getCommunityEligibility(guildId, account.robloxUserId, community.id);
    const settings = await findSettings(guildId);
    const lines = [
      `**Community:** ${community.name}`,
      `**New start date:** ${tDate(startedAt)} (staff verified)`,
      `**Reason:** ${reason}`,
      "",
    ];
    if (entry) {
      if (entry.status === "ELIGIBLE") lines.push(`✅ Now **eligible** since ${tDate(entry.eligibleAt!)}.`);
      else if (entry.status === "NOT_ELIGIBLE")
        lines.push(`❌ Not eligible until ${tDate(entry.eligibleAt!)} (${entry.daysRemaining} days remaining).`);
      else lines.push(`Status: **${entry.status}**`);
    }
    await smartReply(interaction, {
      embeds: [
        baseEmbed(COLORS.success)
          .setTitle("✅ Membership date verified")
          .setDescription(lines.join("\n"))
          .setFooter({ text: `${settings?.marketplaceName ?? "Marketplace"} • Order System` }),
      ],
    });
  },
};
