import { AuditCategory, LeavePolicy, MembershipDateSource } from "@prisma/client";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
} from "discord.js";
import { prisma } from "../database/prisma.js";
import { syncMemberships } from "../services/EligibilityService.js";
import { audit } from "../services/AuditService.js";
import { baseEmbed, COLORS } from "../utils/embeds.js";
import { log } from "../utils/logger.js";

const RETRY_AFTER_MS = 24 * 60 * 60_000;

export async function notifyNewlyEligible(client: Client): Promise<void> {
  const candidates = await prisma.communityMembership.findMany({
    where: {
      isCurrentlyMember: true,
      eligibilityNotificationSentAt: null,
      OR: [
        { eligibilityNotificationLastAttemptAt: null },
        {
          eligibilityNotificationLastAttemptAt: {
            lt: new Date(Date.now() - RETRY_AFTER_MS),
          },
        },
      ],
      community: { enabled: true },
    },
    include: { community: true },
  });

  let sent = 0;
  for (const candidate of candidates) {
    const community = candidate.community;
    const eligibleAt =
      candidate.membershipStartedAt.getTime() + community.requiredDays * 86_400_000;
    if (eligibleAt > Date.now()) continue;
    if (
      community.leavePolicy === LeavePolicy.STAFF_REVIEW &&
      candidate.membershipDateSource === MembershipDateSource.FIRST_SEEN &&
      candidate.rejoinedAt !== null
    ) {
      continue;
    }

    try {
      // A stale database row must not produce an eligibility notification.
      await syncMemberships(candidate.robloxUserId, community.guildId);
      const current = await prisma.communityMembership.findUnique({
        where: { id: candidate.id },
      });
      if (!current?.isCurrentlyMember || current.eligibilityNotificationSentAt) continue;

      const account = await prisma.robloxAccount.findUnique({
        where: { robloxUserId: candidate.robloxUserId },
      });
      if (!account) continue;
      const settings = await prisma.guildSettings.findUnique({
        where: { guildId: community.guildId },
      });
      if (!settings?.enabled) continue;

      const attemptedAt = new Date();
      await prisma.communityMembership.update({
        where: { id: candidate.id },
        data: { eligibilityNotificationLastAttemptAt: attemptedAt },
      });

      const user = await client.users.fetch(account.discordUserId);
      const embed = baseEmbed(COLORS.success, settings.marketplaceName)
        .setTitle("✅ YOU ARE NOW ELIGIBLE")
        .setDescription(
          `Your tracked membership in **${community.name}** now meets the ` +
            `${community.requiredDays}-day requirement.`,
        )
        .setTimestamp();
      const components = settings.orderPanelChannelId
        ? [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setLabel("Create Order")
                .setStyle(ButtonStyle.Link)
                .setURL(
                  `https://discord.com/channels/${community.guildId}/${settings.orderPanelChannelId}`,
                ),
            ),
          ]
        : [];
      await user.send({ embeds: [embed], components });
      await prisma.communityMembership.update({
        where: { id: candidate.id },
        data: { eligibilityNotificationSentAt: new Date() },
      });
      await audit({
        category: AuditCategory.ELIGIBILITY,
        action: "ELIGIBILITY_NOTIFICATION_SENT",
        guildId: community.guildId,
        targetDiscordId: account.discordUserId,
        details: { communityId: community.id, community: community.name },
      });
      sent += 1;
    } catch (error) {
      log.warn(`Eligibility notification failed for membership ${candidate.id}`, error);
      await audit({
        category: AuditCategory.SYSTEM,
        action: "ELIGIBILITY_NOTIFICATION_FAILED",
        guildId: community.guildId,
        details: { membershipId: candidate.id, error: String(error) },
      });
    }
  }
  log.info(`Eligibility notifier sent ${sent} notification(s).`);
}
