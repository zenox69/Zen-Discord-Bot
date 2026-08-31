import { OrderStatus } from "@prisma/client";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { CUSTOM_ID_PREFIX, cid } from "../config/constants.js";
import { prisma } from "../database/prisma.js";
import { findSettings } from "./GuildSettingsService.js";
import { roblox } from "./RobloxService.js";
import { baseEmbed, COLORS } from "../utils/embeds.js";
import { formatMoney, tDateTime } from "../utils/discordTime.js";

const OPEN_STATUSES: OrderStatus[] = [
  "DRAFT",
  "SUBMITTED",
  "STAFF_REVIEW",
  "QUOTED",
  "AWAITING_PAYMENT",
  "PAID",
  "IN_PROGRESS",
  "READY",
];

export async function buildCustomerProfile(guildId: string, discordUserId: string) {
  const [settings, account, customer, orders] = await Promise.all([
    findSettings(guildId),
    prisma.robloxAccount.findUnique({ where: { discordUserId } }),
    prisma.discordUser.findUnique({
      where: { guildId_discordUserId: { guildId, discordUserId } },
    }),
    prisma.order.findMany({
      where: { guildId, discordUserId, status: { not: "DRAFT" } },
      select: { status: true },
    }),
  ]);

  let eligibleCommunities = 0;
  if (account) {
    const memberships = await prisma.communityMembership.findMany({
      where: {
        robloxUserId: account.robloxUserId,
        isCurrentlyMember: true,
        community: { guildId, enabled: true },
      },
      include: { community: true },
    });
    const now = Date.now();
    eligibleCommunities = memberships.filter(
      (membership) =>
        membership.membershipStartedAt.getTime() +
          membership.community.requiredDays * 86_400_000 <=
        now,
    ).length;
  }

  const completed = orders.filter((order) => order.status === "COMPLETED").length;
  const cancelled = orders.filter((order) => order.status === "CANCELLED").length;
  const open = orders.filter((order) => OPEN_STATUSES.includes(order.status)).length;

  const embed = baseEmbed(COLORS.info, settings?.marketplaceName)
    .setTitle("👤 CUSTOMER PROFILE")
    .addFields(
      { name: "Discord User", value: `<@${discordUserId}>`, inline: true },
      {
        name: "Roblox Username",
        value: account ? `@${account.robloxUsername}` : "Not verified",
        inline: true,
      },
      { name: "Roblox ID", value: account?.robloxUserId ?? "—", inline: true },
      {
        name: "Verification Date",
        value: account ? tDateTime(account.verifiedAt) : "—",
        inline: true,
      },
      { name: "Completed Orders", value: String(completed), inline: true },
      { name: "Cancelled Orders", value: String(cancelled), inline: true },
      { name: "Open Orders", value: String(open), inline: true },
      { name: "Communities Eligible", value: String(eligibleCommunities), inline: true },
      { name: "Total Orders", value: String(orders.length), inline: true },
      { name: "Warnings", value: String(customer?.warnings ?? 0), inline: true },
      { name: "Staff Notes", value: customer?.notes?.slice(0, 1024) || "—", inline: false },
    )
    .setTimestamp();

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  const buttons: ButtonBuilder[] = [];
  if (account) {
    buttons.push(
      new ButtonBuilder()
        .setURL(roblox.profileUrl(account.robloxUserId))
        .setLabel("Roblox Profile")
        .setStyle(ButtonStyle.Link),
      new ButtonBuilder()
        .setCustomId(cid(CUSTOM_ID_PREFIX.eligible, "show", discordUserId))
        .setLabel("Eligibility")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId(cid(CUSTOM_ID_PREFIX.customer, "history", discordUserId, 1))
      .setLabel("Order History")
      .setStyle(ButtonStyle.Primary),
  );
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));

  return { embeds: [embed], components };
}

export async function buildOrderHistory(
  guildId: string,
  discordUserId: string,
  requestedPage: number,
) {
  const settings = await findSettings(guildId);
  const pageSize = 5;
  const count = await prisma.order.count({
    where: { guildId, discordUserId, status: { not: "DRAFT" } },
  });
  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const orders = await prisma.order.findMany({
    where: { guildId, discordUserId, status: { not: "DRAFT" } },
    include: { product: true, community: true },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
  });

  const embed = baseEmbed(COLORS.info, settings?.marketplaceName)
    .setTitle(`📦 ORDER HISTORY • ${page}/${totalPages}`)
    .setDescription(
      orders.length === 0
        ? "No submitted orders."
        : orders
            .map(
              (order) =>
                `**#${order.number} • ${order.product.name}**\n` +
                `${order.community?.name ?? "No community"} • ${order.status.replaceAll("_", " ")} • ` +
                `${formatMoney(Number(order.price), settings?.currencySymbol ?? "₱")} • ${tDateTime(order.createdAt)}`,
            )
            .join("\n\n"),
    );

  const components =
    totalPages > 1
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(
                cid(CUSTOM_ID_PREFIX.customer, "history", discordUserId, page - 1),
              )
              .setLabel("Previous")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(page === 1),
            new ButtonBuilder()
              .setCustomId(cid(CUSTOM_ID_PREFIX.customer, "history", discordUserId, page + 1))
              .setLabel("Next")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(page === totalPages),
          ),
        ]
      : [];

  return { embeds: [embed], components };
}
