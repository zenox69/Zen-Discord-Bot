import { AuditCategory, type GuildSettings, type Ticket } from "@prisma/client";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Guild,
  GuildMember,
  PermissionFlagsBits,
  type OverwriteResolvable,
} from "discord.js";
import { CUSTOM_ID_PREFIX, TICKET_DELETE_DELAY_MS, cid } from "../config/constants.js";
import { findSettings } from "./GuildSettingsService.js";
import { prisma } from "../database/prisma.js";
import { getBotClient } from "../utils/botClient.js";
import { isSendableChannel } from "../utils/channel.js";
import { baseEmbed, COLORS } from "../utils/embeds.js";
import { AppError } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import { isStaff } from "../utils/permissions.js";
import { slugify, zeroPad } from "../utils/text.js";
import { audit } from "./AuditService.js";

/**
 * TicketService — private order/support channels with strict permissions.
 * The database row is the source of truth; the Discord channel is a view.
 */

export type PanelKind = "order" | "support" | "all";

export async function publishTicketPanel(guildId: string, kind: PanelKind): Promise<string> {
  const settings = await findSettings(guildId);
  if (!settings) throw new AppError({ code: "NOT_CONFIGURED", friendly: "❌ This server is not set up yet — run `/setup`." });
  const panelChannelId = settings.orderPanelChannelId;
  if (!panelChannelId) {
    throw new AppError({
      code: "NO_PANEL_CHANNEL",
      friendly: "❌ No panel channel is configured. Set one with `/setup channel panel #channel`.",
    });
  }

  const client = getBotClient();
  const channel = await client.channels.fetch(panelChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText || !isSendableChannel(channel)) {
    throw new AppError({
      code: "NO_PANEL_CHANNEL",
      friendly: "❌ The configured panel channel no longer exists or is not a text channel.",
    });
  }

  const embed = baseEmbed(COLORS.info, settings.marketplaceName)
    .setTitle("🎫 MARKETPLACE SUPPORT")
    .setDescription("Need assistance or want to place an order?\nUse the buttons below.");

  const buttons: ButtonBuilder[] = [];
  if (kind === "order" || kind === "all") {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(cid(CUSTOM_ID_PREFIX.ticket, "create", "order"))
        .setLabel("Create Order")
        .setEmoji("🛒")
        .setStyle(ButtonStyle.Primary),
    );
  }
  if (kind === "support" || kind === "all") {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(cid(CUSTOM_ID_PREFIX.ticket, "create", "support"))
        .setLabel("General Support")
        .setEmoji("💬")
        .setStyle(ButtonStyle.Secondary),
    );
  }

  await channel.send({ embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] });
  log.info(`Ticket panel (${kind}) published in #${channel.name} (guild ${guildId})`);
  return channel.id;
}

export async function canCloseTicket(guildId: string, member: GuildMember, ticket: Ticket): Promise<boolean> {
  if (member.id === ticket.discordUserId) return true;
  const settings = await findSettings(guildId);
  return settings ? isStaff(member, settings) : false;
}

export async function createTicket(params: {
  guild: Guild;
  guildId: string;
  member: GuildMember;
  type: "ORDER" | "SUPPORT";
}): Promise<Ticket> {
  const { guild, guildId, member, type } = params;
  const settings: GuildSettings | null = await findSettings(guildId);
  if (!settings) throw new AppError({ code: "NOT_CONFIGURED", friendly: "❌ This server is not set up yet — run `/setup`." });
  if (!settings.ticketCategoryId) {
    throw new AppError({
      code: "NO_TICKET_CATEGORY",
      friendly: "❌ No ticket category is configured. An administrator must run `/setup channel tickets` first.",
    });
  }

  const existing = await prisma.ticket.findFirst({
    where: { guildId, discordUserId: member.id, status: "OPEN" },
  });
  if (existing && existing.type === type) {
    throw new AppError({
      code: "TICKET_ALREADY_OPEN",
      friendly: `You already have an open **${type === "ORDER" ? "order" : "support"}** ticket — \`${existing.channelName}\`. Close it first.`,
    });
  }

  // Atomic counter increment (safe under concurrent clicks).
  const incremented = await prisma.guildSettings.update({
    where: { guildId },
    data: { ticketCounter: { increment: 1 } },
  });
  const number = incremented.ticketCounter;
  const prefix = type === "ORDER" ? "order" : "support";
  const channelName = `${prefix}-${zeroPad(number, 6)}-${slugify(member.user.username)}`;

  const botId = getBotClient().user?.id;
  const staffAllow = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ManageChannels,
  ];
  const overwrites: OverwriteResolvable[] = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: member.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
  ];
  if (settings.staffRoleId) overwrites.push({ id: settings.staffRoleId, allow: staffAllow });
  if (settings.adminRoleId) overwrites.push({ id: settings.adminRoleId, allow: [...staffAllow, PermissionFlagsBits.ManageRoles] });
  if (botId) {
    overwrites.push({
      id: botId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageThreads,
      ],
    });
  }

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: settings.ticketCategoryId,
    permissionOverwrites: overwrites,
    reason: `Ticket ${channelName} for ${member.user.username}`,
  });

  const ticket = await prisma.ticket.create({
    data: {
      guildId,
      number,
      type,
      channelName,
      channelId: channel.id,
      discordUserId: member.id,
      categoryId: settings.ticketCategoryId,
    },
  });

  await prisma.ticketEvent.create({
    data: {
      ticketId: ticket.id,
      type: "OPENED",
      actorDiscordId: member.id,
      data: { channelName, type },
    },
  });
  await audit({
    category: AuditCategory.TICKET,
    action: "OPENED",
    guildId,
    actorDiscordId: member.id,
    targetDiscordId: member.id,
    details: { number, channelName, type },
  });

  const botName = getBotClient().user?.username ?? "this bot";
  const welcome =
    type === "ORDER"
      ? [
          `WELCOME TO **${settings.marketplaceName}**`,
          "",
          `<@${member.id}> Just fill out the **order form** below to get started.`,
          "If the order form doesn't show up or you need help,",
          "feel free to ping a staff member.",
        ].join("\n")
      : [
          `WELCOME TO **${settings.marketplaceName}** — **GENERAL SUPPORT**`,
          "",
          `<@${member.id}> Please describe your issue in this channel and a staff member will be with you shortly.`,
        ].join("\n");

  const closeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid(CUSTOM_ID_PREFIX.ticket, "close", ticket.id))
      .setLabel("Close")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(cid(CUSTOM_ID_PREFIX.ticket, "close-reason", ticket.id))
      .setLabel("Close With Reason")
      .setEmoji("📝")
      .setStyle(ButtonStyle.Secondary),
  );

  const sent = await channel.send({
    content: `${welcome}\n\nPowered by **${botName}**`,
    components: [closeRow],
  });

  await prisma.ticket.update({ where: { id: ticket.id }, data: { channelMessageId: sent.id } });
  return ticket;
}

export async function closeTicket(params: {
  guildId: string;
  ticketId: number;
  actorDiscordId: string;
  reason?: string | null;
}): Promise<void> {
  const { guildId, ticketId, actorDiscordId, reason } = params;
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, include: { order: true } });
  if (!ticket || ticket.guildId !== guildId) {
    throw new AppError({ code: "TICKET_NOT_FOUND", friendly: "❌ Ticket not found.", expected: false });
  }
  if (ticket.status === "CLOSED") {
    throw new AppError({ code: "TICKET_ALREADY_CLOSED", friendly: "❌ This ticket is already closed." });
  }

  const client = getBotClient();
  const guild = await client.guilds.fetch(guildId);
  const channel = ticket.channelId ? (await guild.channels.fetch(ticket.channelId).catch(() => null)) : null;

  await prisma.$transaction([
    prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
        closedByDiscordId: actorDiscordId,
        closeReason: reason ?? null,
      },
    }),
    // A ticket closed with an unsubmitted draft must not keep the draft row
    // around (it would leak a form state the user can no longer reach).
    prisma.order.deleteMany({ where: { ticketId: ticket.id, status: "DRAFT" } }),
    prisma.ticketEvent.create({
      data: {
        ticketId,
        type: "CLOSED",
        actorDiscordId,
        data: { reason: reason ?? null, number: ticket.number },
      },
    }),
  ]);

  if (ticket.order) {
    await prisma.orderEvent.create({
      data: {
        orderId: ticket.order.id,
        type: "TICKET_CLOSED",
        actorDiscordId,
        data: { reason: reason ?? null, number: ticket.number },
      },
    });
  }

  await audit({
    category: AuditCategory.TICKET,
    action: "CLOSED",
    guildId,
    actorDiscordId,
    targetDiscordId: ticket.discordUserId,
    details: {
      number: ticket.number,
      channelName: ticket.channelName,
      reason: reason ?? null,
      orderId: ticket.order?.id ?? null,
    },
  });

  if (channel && isSendableChannel(channel)) {
    await channel
      .send({
        content: `🔒 This ticket was closed by <@${actorDiscordId}>${reason ? ` — **${reason}**` : ""}. The channel will be deleted shortly.`,
      })
      .catch(() => undefined);
    setTimeout(() => {
      const deleteFn = (channel as { delete?: (r?: string) => Promise<unknown> }).delete;
      if (typeof deleteFn === "function") {
        void deleteFn.call(channel, "Ticket closed").catch((err) =>
          log.warn(`Could not delete ticket channel ${channel.id}: ${String(err)}`),
        );
      }
    }, TICKET_DELETE_DELAY_MS);
  }
}
