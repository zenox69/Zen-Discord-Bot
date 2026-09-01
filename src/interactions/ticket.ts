import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GuildMember,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { CUSTOM_ID_PREFIX, LIMITS, cid } from "../config/constants.js";
import { prisma } from "../database/prisma.js";
import { closeTicket, createTicket, canCloseTicket, getOwnerCloseBlocker } from "../services/TicketService.js";
import { startOrderForm } from "../services/OrderService.js";
import { getBotClient } from "../utils/botClient.js";
import { isSendableChannel } from "../utils/channel.js";
import { AppError } from "../utils/errors.js";
import { rateLimiter, retryPhrase } from "../utils/rateLimiter.js";
import type { InteractionContext } from "../handlers/interactionHandler.js";

/**
 * Ticket panel + close-flow interactions.
 * customIds:
 *   ticket:create:{order|support}
 *   ticket:close:{ticketId}            -> confirmation
 *   ticket:close-confirm:{ticketId}    -> performs close
 *   ticket:cancel-close:{ticketId}     -> cancels confirmation
 *   ticket:close-reason:{ticketId}     -> opens modal
 *   ticket:close-reason (modal)        -> performs close with reason
 */

async function requireMember(ctx: InteractionContext): Promise<GuildMember> {
  const member = ctx.interaction.member;
  if (!member || !(member instanceof GuildMember)) {
    throw new AppError({ code: "NOT_A_MEMBER", friendly: "❌ This can only be used by server members." });
  }
  return member;
}

/**
 * Owner gate with a clear reason: an ACTIVE order in the ticket blocks
 * closure (the customer must cancel the order first). Staff are unaffected.
 */
async function assertOwnerCanClose(guildId: string, member: GuildMember, ticketId: number): Promise<void> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, include: { order: true } });
  if (!ticket || ticket.guildId !== guildId || ticket.status !== "OPEN") {
    throw new AppError({ code: "TICKET_NOT_OPEN", friendly: "❌ This ticket no longer exists or is already closed." });
  }
  if (!(await canCloseTicket(guildId, member, ticket))) {
    if (member.id === ticket.discordUserId) {
      const blocker = await getOwnerCloseBlocker(ticket);
      throw new AppError({ code: "ORDER_ACTIVE", friendly: blocker ?? "❌ You cannot close this ticket right now." });
    }
    throw new AppError({ code: "NOT_STAFF", friendly: "❌ Only the ticket owner or staff can close this ticket." });
  }
}

export async function createTicketFromPanel(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isButton()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const guildId = interaction.guildId;
  if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This can only be used in a server." });

  const type = ctx.parts[0] === "order" ? "ORDER" : "SUPPORT";

  const rl = rateLimiter.consume(
    `ticket:create:${interaction.user.id}`,
    LIMITS.ticketCreate.limit,
    LIMITS.ticketCreate.windowMs,
  );
  if (!rl.ok) throw new AppError({ code: "RATE_LIMITED", friendly: retryPhrase(rl.retryAfterMs) });

  const member = await requireMember(ctx);
  const ticket = await createTicket({
    guild: interaction.guild!,
    guildId,
    member,
    type,
  });

  if (type === "ORDER" && ticket.channelId) {
    const channel = await getBotClient().channels.fetch(ticket.channelId).catch(() => null);
    if (!channel || !isSendableChannel(channel)) {
      throw new AppError({
        code: "ORDER_CHANNEL_UNAVAILABLE",
        friendly: "⚠️ The order ticket was created, but its form could not be posted. Please ask staff for help.",
      });
    }
    await startOrderForm(channel, ticket);
  }

  await interaction.reply({
    content: `✅ Your ticket is ready: **${ticket.channelName}**`,
    ephemeral: true,
  });
}

export async function confirmClose(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isButton()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const guildId = interaction.guildId;
  if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This can only be used in a server." });

  const ticketId = Number(ctx.parts[0]);
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    throw new AppError({ code: "BAD_TARGET", friendly: "❌ Invalid ticket in this interaction." });
  }
  const member = await requireMember(ctx);
  await assertOwnerCanClose(guildId, member, ticketId);

  await interaction.reply({
    content: "Are you sure you want to close this ticket? The channel will be deleted shortly after.",
    ephemeral: true,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(cid(CUSTOM_ID_PREFIX.ticket, "close-confirm", ticketId))
          .setLabel("Yes, Close")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(cid(CUSTOM_ID_PREFIX.ticket, "cancel-close", ticketId))
          .setLabel("No, Keep Open")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

export async function performClose(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isButton()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const guildId = interaction.guildId;
  if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This can only be used in a server." });

  const member = await requireMember(ctx);
  const ticketId = Number(ctx.parts[0]);
  await assertOwnerCanClose(guildId, member, ticketId);

  await closeTicket({ guildId, ticketId, actorDiscordId: interaction.user.id });
  await interaction.update({ content: "✅ Ticket closed.", components: [] });
}

export async function cancelClose(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isButton()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  await interaction.update({ content: "✅ Ticket left open.", components: [] });
}

export async function openCloseReasonModal(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isButton()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const guildId = interaction.guildId;
  if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This can only be used in a server." });
  const ticketId = Number(ctx.parts[0]);
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    throw new AppError({ code: "BAD_TARGET", friendly: "❌ Invalid ticket in this interaction." });
  }
  const member = await requireMember(ctx);
  await assertOwnerCanClose(guildId, member, ticketId);
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(cid(CUSTOM_ID_PREFIX.ticket, "close-reason"))
      .setTitle("Close Ticket")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("reason")
            .setLabel("Reason for closing")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(200)
            .setRequired(true),
        ),
      ),
  );
}

export async function submitCloseReason(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isModalSubmit()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const guildId = interaction.guildId;
  if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This can only be used in a server." });

  const reason = (interaction.fields.getTextInputValue("reason") ?? "").trim().slice(0, 200);

  // The modal does not carry the ticket id (never put state in client data we
  // can't verify) — close the ticket bound to this channel.
  const channel = interaction.channel;
  if (!channel || channel.partial) {
    throw new AppError({ code: "NO_CHANNEL", friendly: "❌ Channel context lost. Use the close button instead." });
  }
  const ticket = await prisma.ticket.findUnique({ where: { channelId: channel.id } });
  if (!ticket || ticket.guildId !== guildId || ticket.status !== "OPEN") {
    throw new AppError({ code: "TICKET_NOT_OPEN", friendly: "❌ This ticket no longer exists or is already closed." });
  }
  await assertOwnerCanClose(guildId, await requireMember(ctx), ticket.id);

  await closeTicket({ guildId, ticketId: ticket.id, actorDiscordId: interaction.user.id, reason });
  await interaction.reply({ content: `✅ Ticket closed — **${reason}**`, ephemeral: true });
}
