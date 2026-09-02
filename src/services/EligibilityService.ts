import { AuditCategory, type CommunityMembership, type RobloxCommunity } from "@prisma/client";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  GuildMember,
  type ButtonInteraction,
} from "discord.js";
import { CUSTOM_ID_PREFIX, ELIGIBILITY_PAGE_SIZE, LIMITS, cid } from "../config/constants.js";
import { prisma } from "../database/prisma.js";
import { roblox } from "./RobloxService.js";
import { audit } from "./AuditService.js";
import { AppError } from "../utils/errors.js";
import { addDays, tDate } from "../utils/discordTime.js";
import { isStaff } from "../utils/permissions.js";
import { rateLimiter, retryPhrase } from "../utils/rateLimiter.js";
import { deferEphemeral, smartReply } from "../utils/interactionReply.js";
import { trunc } from "../utils/embeds.js";
import type { GroupRole } from "../types/roblox.js";
import type { InteractionContext } from "../handlers/interactionHandler.js";
import { findSettings } from "./GuildSettingsService.js";

/**
 * EligibilityService — the heart of the marketplace.
 *
 * Honesty rules (critical):
 *  - We NEVER fabricate a Roblox join date. membershipStartedAt is either the
 *    first time the bot observed the membership (FIRST_SEEN), a staff-verified
 *    date, or an imported/official date — and the UI labels it accordingly.
 *  - A RoProxy failure throws RobloxApiError and is rendered as
 *    "services unavailable" — it is never rendered as "not a member".
 */

export type EligibilityStatus =
  | "ELIGIBLE"
  | "NOT_ELIGIBLE"
  | "NOT_MEMBER"
  | "KEPT_DATE"
  | "STAFF_REVIEW";

export interface EligibilityEntry {
  community: RobloxCommunity;
  membership: CommunityMembership | null;
  status: EligibilityStatus;
  eligibleAt: Date | null;
  daysRemaining: number | null;
}

export interface EligibilityReport {
  entries: EligibilityEntry[];
  total: number;
  avatarUrl: string | null;
}

const STATUS_ICON: Record<EligibilityStatus, string> = {
  ELIGIBLE: "✅",
  NOT_ELIGIBLE: "❌",
  NOT_MEMBER: "🚫",
  KEPT_DATE: "⚠️",
  STAFF_REVIEW: "⚠️",
};

const STATUS_LABEL: Record<EligibilityStatus, string> = {
  ELIGIBLE: "Eligible",
  NOT_ELIGIBLE: "Not eligible",
  NOT_MEMBER: "Not a member",
  KEPT_DATE: "No longer a member",
  STAFF_REVIEW: "Membership date unavailable",
};

const STATUS_ORDER: Record<EligibilityStatus, number> = {
  ELIGIBLE: 0,
  NOT_ELIGIBLE: 1,
  STAFF_REVIEW: 2,
  KEPT_DATE: 3,
  NOT_MEMBER: 4,
};

// ---------------------------------------------------------------------------
// Membership synchronization (one live RoProxy call, compared to all communities)
// ---------------------------------------------------------------------------

/**
 * Fetch the user's CURRENT Roblox group memberships once and reconcile them
 * with the stored CommunityMembership rows for every community this guild
 * tracks (enabled or not, so history survives toggling).
 *
 * Join dates come from FIRST_SEEN here; OFFICIAL_API dates are captured at
 * OAuth link time (see RobloxOAuthService), where the user's own access
 * token authorizes the read. This sync never fabricates dates.
 *
 * Throws RobloxApiError on RoProxy failure — callers must surface that as
 * "services unavailable", never as "not a member".
 * { forceRefresh: true } bypasses the membership cache (final order submit).
 */
export async function syncMemberships(
  robloxUserId: string,
  guildId: string,
  opts?: { forceRefresh?: boolean },
): Promise<void> {
  const [communities, roles] = await Promise.all([
    prisma.robloxCommunity.findMany({ where: { guildId } }),
    roblox.getGroupRoles(robloxUserId, opts),
  ]);
  if (communities.length === 0) return;

  const roleByGroup = new Map<string, GroupRole>(roles.map((r) => [r.groupId, r]));
  const now = new Date();

  for (const community of communities) {
    const role = roleByGroup.get(community.robloxGroupId) ?? null;
    const isCurrentlyMember = role !== null;
    const key = { robloxUserId_communityId: { robloxUserId, communityId: community.id } };

    const existing = await prisma.communityMembership.findUnique({ where: key });

    if (!existing) {
      if (isCurrentlyMember) {
        await prisma.communityMembership.create({
          data: {
            robloxUserId,
            communityId: community.id,
            isCurrentlyMember: true,
            membershipFirstSeenAt: now,
            membershipStartedAt: now,
            membershipDateSource: "FIRST_SEEN",
            roleId: role?.roleId ?? null,
            roleName: role?.roleName ?? null,
            rank: role?.rank ?? null,
            lastMembershipCheckAt: now,
            membershipSeenAt: now,
          },
        });
        await audit({
          category: AuditCategory.ELIGIBILITY,
          action: "MEMBERSHIP_DETECTED",
          guildId,
          details: { robloxUserId, community: community.name, membershipStartedAt: now.toISOString() },
        });
      }
      continue;
    }

    const wasMember = existing.isCurrentlyMember;

    if (isCurrentlyMember && !wasMember) {
      // Rejoined.
      const policy = community.leavePolicy;
      const data: {
        isCurrentlyMember: boolean;
        rejoinedAt: Date;
        leftAt: null;
        lastMembershipCheckAt: Date;
        membershipSeenAt: Date;
        roleId: number | null;
        roleName: string | null;
        rank: number | null;
        membershipStartedAt?: Date;
        membershipDateSource?: "FIRST_SEEN";
        eligibilityNotificationSentAt?: null;
        eligibilityNotificationLastAttemptAt?: null;
      } = {
        isCurrentlyMember: true,
        rejoinedAt: now,
        leftAt: null,
        lastMembershipCheckAt: now,
        membershipSeenAt: now,
        roleId: role?.roleId ?? null,
        roleName: role?.roleName ?? null,
        rank: role?.rank ?? null,
        eligibilityNotificationSentAt: null,
        eligibilityNotificationLastAttemptAt: null,
      };
      let action = "MEMBERSHIP_REJOINED";
      if (policy === "RESET_ON_LEAVE") {
        data.membershipStartedAt = now;
        data.membershipDateSource = "FIRST_SEEN";
        action = "MEMBERSHIP_RESTARTED";
      } else if (policy === "STAFF_REVIEW") {
        data.membershipStartedAt = now;
        data.membershipDateSource = "FIRST_SEEN";
        action = "MEMBERSHIP_REVIEW_REQUIRED";
      }
      await prisma.communityMembership.update({ where: { id: existing.id }, data });
      await audit({
        category: AuditCategory.ELIGIBILITY,
        action,
        guildId,
        details: {
          robloxUserId,
          community: community.name,
          policy,
          leftAt: existing.leftAt?.toISOString() ?? null,
          restarted: action === "MEMBERSHIP_RESTARTED",
        },
      });
      continue;
    }

    if (!isCurrentlyMember && wasMember) {
      // Left the community.
      await prisma.communityMembership.update({
        where: { id: existing.id },
        data: {
          isCurrentlyMember: false,
          leftAt: now,
          lastMembershipCheckAt: now,
          roleId: null,
          roleName: null,
          rank: null,
        },
      });
      await audit({
        category: AuditCategory.ELIGIBILITY,
        action: "MEMBERSHIP_LOST",
        guildId,
        details: { robloxUserId, community: community.name, leftAt: now.toISOString(), policy: community.leavePolicy },
      });
      continue;
    }

    // No membership change — refresh check timestamp and (if member) role info.
    await prisma.communityMembership.update({
      where: { id: existing.id },
      data: {
        isCurrentlyMember,
        lastMembershipCheckAt: now,
        ...(isCurrentlyMember
          ? {
              membershipSeenAt: now,
              roleId: role?.roleId ?? null,
              roleName: role?.roleName ?? null,
              rank: role?.rank ?? null,
            }
          : {}),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Eligibility calculation
// ---------------------------------------------------------------------------

function computeEntry(
  community: RobloxCommunity,
  membership: CommunityMembership | null,
  now: Date,
): EligibilityEntry {
  if (!membership) {
    return { community, membership: null, status: "NOT_MEMBER", eligibleAt: null, daysRemaining: null };
  }

  const policy = community.leavePolicy;

  if (!membership.isCurrentlyMember) {
    if (policy === "KEEP_ORIGINAL") {
      // Original date retained: still compute, but flag it.
      const eligibleAt = addDays(membership.membershipStartedAt, community.requiredDays);
      const daysRemaining = Math.ceil((eligibleAt.getTime() - now.getTime()) / 86_400_000);
      return {
        community,
        membership,
        status: "KEPT_DATE",
        eligibleAt,
        daysRemaining: daysRemaining <= 0 ? 0 : daysRemaining,
      };
    }
    // RESET_ON_LEAVE / STAFF_REVIEW: leaving invalidates eligibility.
    return { community, membership, status: "NOT_MEMBER", eligibleAt: null, daysRemaining: null };
  }

  // Currently a member.
  if (policy === "STAFF_REVIEW" && membership.membershipDateSource === "FIRST_SEEN" && membership.rejoinedAt !== null) {
    return { community, membership, status: "STAFF_REVIEW", eligibleAt: null, daysRemaining: null };
  }

  const eligibleAt = addDays(membership.membershipStartedAt, community.requiredDays);
  const daysRemaining = Math.ceil((eligibleAt.getTime() - now.getTime()) / 86_400_000);
  return {
    community,
    membership,
    status: daysRemaining <= 0 ? "ELIGIBLE" : "NOT_ELIGIBLE",
    eligibleAt,
    daysRemaining: daysRemaining <= 0 ? 0 : daysRemaining,
  };
}

/**
 * Live eligibility report: syncs memberships first (throws RobloxApiError on
 * RoProxy failure), then computes every community's status.
 * { forceRefresh: true } forces a live RoProxy membership sync.
 */
export async function getEligibility(
  robloxUserId: string,
  guildId: string,
  opts?: { forceRefresh?: boolean },
): Promise<EligibilityReport> {
  await syncMemberships(robloxUserId, guildId, opts);

  const [communities, memberships] = await Promise.all([
    prisma.robloxCommunity.findMany({ where: { guildId, enabled: true } }),
    prisma.communityMembership.findMany({ where: { robloxUserId } }),
  ]);
  const membershipByCommunity = new Map(memberships.map((m) => [m.communityId, m]));

  const entries = communities
    .map((community) => computeEntry(community, membershipByCommunity.get(community.id) ?? null, new Date()))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);

  const avatarUrl = await roblox.getAvatarHeadshotUrl(robloxUserId).catch(() => null);
  return { entries, total: entries.length, avatarUrl };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function sourceNote(m: CommunityMembership): string {
  switch (m.membershipDateSource) {
    case "STAFF_VERIFIED":
      return " (staff verified)";
    case "OFFICIAL_API":
      return " (official API)";
    case "IMPORTED":
      return " (imported)";
    default:
      return " (first seen)";
  }
}

function entryName(entry: EligibilityEntry): string {
  const emoji = entry.community.emoji ? `${entry.community.emoji} ` : "";
  return `${STATUS_ICON[entry.status]} ${STATUS_LABEL[entry.status]} — ${emoji}${entry.community.name}`;
}

function entryValue(entry: EligibilityEntry): string {
  const m = entry.membership;
  const invite = entry.community.inviteUrl ? `\n[Join this community](${entry.community.inviteUrl})` : "";

  switch (entry.status) {
    case "ELIGIBLE":
      return [
        `Eligible since ${tDate(entry.eligibleAt!)}`,
        m ? `Tracked membership since: ${tDate(m.membershipStartedAt)}${sourceNote(m)}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    case "NOT_ELIGIBLE":
      return [
        `Will be eligible ${tDate(entry.eligibleAt!)}`,
        `${entry.daysRemaining} days remaining`,
        m ? `Tracked membership since: ${tDate(m.membershipStartedAt)}${sourceNote(m)}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    case "KEPT_DATE": {
      const lines = [
        entry.daysRemaining !== null && entry.daysRemaining > 0
          ? `Would be eligible ${tDate(entry.eligibleAt!)} (${entry.daysRemaining} days remaining)`
          : `Original requirement completed ${tDate(entry.eligibleAt!)}`,
        "No longer a member — original membership date kept by policy.",
      ];
      if (m) lines.push(`Membership started: ${tDate(m.membershipStartedAt)}${sourceNote(m)}`);
      return lines.join("\n");
    }
    case "STAFF_REVIEW":
      return [
        "Staff must verify your membership start date before eligibility can begin.",
        "An administrator can set it with `/eligibility set`.",
      ].join("\n");
    case "NOT_MEMBER":
    default:
      return `Join this community before eligibility can begin.${invite}`;
  }
}

export interface EligibilityView {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
  page: number;
  total: number;
}

export async function buildEligibilityView(
  robloxUserId: string,
  displayName: string,
  robloxUsername: string,
  guildId: string,
  page: number,
  marketplaceName?: string,
): Promise<EligibilityView> {
  const report = await getEligibility(robloxUserId, guildId);
  const totalPages = Math.max(1, Math.ceil(report.entries.length / ELIGIBILITY_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const slice = report.entries.slice((safePage - 1) * ELIGIBILITY_PAGE_SIZE, safePage * ELIGIBILITY_PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`${displayName} (@${robloxUsername})`)
    .setDescription(slice.length === 0 ? "No communities are configured for this server." : null);

  for (const entry of slice) {
    embed.addFields({ name: trunc(entryName(entry), 256), value: trunc(entryValue(entry), 1024) || "—" });
  }
  embed.addFields({ name: "Roblox ID", value: robloxUserId, inline: false });

  if (marketplaceName) embed.setFooter({ text: marketplaceName });
  if (report.avatarUrl) embed.setThumbnail(report.avatarUrl);
  if (totalPages > 1) embed.setFooter({ text: `${marketplaceName ? `${marketplaceName} • ` : ""}Page ${safePage} / ${totalPages}` });

  const refresh = new ButtonBuilder()
    .setCustomId(cid(CUSTOM_ID_PREFIX.eligible, "refresh", robloxUserId, safePage))
    .setLabel("Refresh Eligibility")
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("🔄");

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setURL(roblox.profileUrl(robloxUserId))
      .setLabel("View Roblox Profile")
      .setStyle(ButtonStyle.Link),
    refresh,
  );

  const components = [row1];
  if (totalPages > 1) {
    const prev = new ButtonBuilder()
      .setCustomId(cid(CUSTOM_ID_PREFIX.eligible, "page", robloxUserId, safePage - 1))
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage <= 1);
    const next = new ButtonBuilder()
      .setCustomId(cid(CUSTOM_ID_PREFIX.eligible, "page", robloxUserId, safePage + 1))
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= totalPages);
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        prev,
        new ButtonBuilder().setCustomId(`eligible:static:${robloxUserId}:${safePage}`).setLabel(`${safePage} / ${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
        next,
      ),
    );
  }

  return { embeds: [embed], components, page: safePage, total: totalPages };
}

// ---------------------------------------------------------------------------
// Interaction entry points (buttons)
// ---------------------------------------------------------------------------

async function resolveTarget(interaction: ButtonInteraction, targetUserId: string | undefined, guildId: string) {
  if (!targetUserId || !/^\d{17,20}$/.test(targetUserId)) {
    throw new AppError({ code: "BAD_TARGET", friendly: "❌ Invalid target in this interaction." });
  }
  const isSelf = targetUserId === interaction.user.id;
  if (!isSelf) {
    const settings = await findSettings(guildId);
    if (settings) {
      const member = interaction.member;
      if (member instanceof GuildMember) {
        if (!isStaff(member, settings)) {
          throw new AppError({ code: "NOT_STAFF", friendly: "❌ Only staff can view other users' eligibility." });
        }
      }
    }
  }
  const account = await prisma.robloxAccount.findUnique({ where: { discordUserId: targetUserId } });
  if (!account) {
    throw new AppError({
      code: "NOT_VERIFIED",
      friendly: isSelf
        ? "❌ You must verify your Roblox account first.\nRun `/verify roblox username:YourName`."
        : "❌ That user has no verified Roblox account.",
    });
  }
  return { isSelf, account };
}

/** `eligible:show:{discordUserId}` — from the /roblox profile embed. */
export async function showEligibility(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isButton()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const guildId = interaction.guildId;
  if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This can only be used in a server." });

  const { account } = await resolveTarget(interaction, ctx.parts[0], guildId);
  const settings = await findSettings(guildId);
  await deferEphemeral(interaction);
  const view = await buildEligibilityView(
    account.robloxUserId,
    account.robloxDisplayName,
    account.robloxUsername,
    guildId,
    1,
    settings?.marketplaceName,
  );
  await smartReply(interaction, { embeds: view.embeds, components: view.components });
}

/** `eligible:refresh:{robloxUserId}:{page}` — edits the message in place. */
export async function refreshEligibility(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isButton()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const guildId = interaction.guildId;
  if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This can only be used in a server." });

  const rl = rateLimiter.consume(
    `eligible:refresh:${interaction.user.id}`,
    LIMITS.eligibleRefresh.limit,
    LIMITS.eligibleRefresh.windowMs,
  );
  if (!rl.ok) throw new AppError({ code: "RATE_LIMITED", friendly: retryPhrase(rl.retryAfterMs) });

  const robloxUserId = ctx.parts[0];
  const page = Number(ctx.parts[1] ?? 1);
  const account = robloxUserId ? await prisma.robloxAccount.findUnique({ where: { robloxUserId } }) : null;
  if (!account) throw new AppError({ code: "STALE", friendly: "❌ This account is no longer linked. Run `/eligible` again." });

  // Owners and staff only.
  const targetDiscordId = account.discordUserId;
  const isSelf = targetDiscordId === interaction.user.id;
  if (!isSelf) {
    const settings = await findSettings(guildId);
    const member = interaction.member;
    if (settings && member instanceof GuildMember) {
      if (!isStaff(member, settings)) {
        throw new AppError({ code: "NOT_STAFF", friendly: "❌ Only staff can refresh other users' eligibility." });
      }
    }
  }

  const settings = await findSettings(guildId);
  await deferEphemeral(interaction);
  const view = await buildEligibilityView(
    account.robloxUserId,
    account.robloxDisplayName,
    account.robloxUsername,
    guildId,
    Number.isFinite(page) ? page : 1,
    settings?.marketplaceName,
  );
  await smartReply(interaction, { embeds: view.embeds, components: view.components });
}

/** `eligible:page:{robloxUserId}:{page}` — pagination, also edits in place. */
export async function pageEligibility(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isButton()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const guildId = interaction.guildId;
  if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This can only be used in a server." });

  const robloxUserId = ctx.parts[0];
  const page = Number(ctx.parts[1] ?? 1);
  const account = robloxUserId ? await prisma.robloxAccount.findUnique({ where: { robloxUserId } }) : null;
  if (!account) throw new AppError({ code: "STALE", friendly: "❌ This account is no longer linked. Run `/eligible` again." });

  const isSelf = account.discordUserId === interaction.user.id;
  if (!isSelf) {
    const settings = await findSettings(guildId);
    const member = interaction.member;
    if (settings && member instanceof GuildMember) {
      if (!isStaff(member, settings)) {
        throw new AppError({ code: "NOT_STAFF", friendly: "❌ Only staff can view other users' eligibility." });
      }
    }
  }

  const settings = await findSettings(guildId);
  await deferEphemeral(interaction);
  const view = await buildEligibilityView(
    account.robloxUserId,
    account.robloxDisplayName,
    account.robloxUsername,
    guildId,
    Number.isFinite(page) ? page : 1,
    settings?.marketplaceName,
  );
  await smartReply(interaction, { embeds: view.embeds, components: view.components });
}

/** Convenience for the order flow and jobs. */
export async function getCommunityEligibility(
  guildId: string,
  robloxUserId: string,
  communityId: number,
  opts?: { forceRefresh?: boolean },
): Promise<EligibilityEntry | null> {
  const report = await getEligibility(robloxUserId, guildId, opts);
  return report.entries.find((e) => e.community.id === communityId) ?? null;
}

/** Human label for an eligibility status (used by the order flow). */
export function eligibilityStatusLabel(status: EligibilityStatus): string {
  return STATUS_LABEL[status];
}
