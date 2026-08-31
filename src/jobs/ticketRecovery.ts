import { AuditCategory } from "@prisma/client";
import type { Client } from "discord.js";
import { TICKET_DELETE_DELAY_MS } from "../config/constants.js";
import { prisma } from "../database/prisma.js";
import { audit } from "../services/AuditService.js";
import { log } from "../utils/logger.js";

export async function recoverTicketChannels(client: Client): Promise<void> {
  const tickets = await prisma.ticket.findMany({ where: { channelId: { not: null } } });
  for (const ticket of tickets) {
    const guild = await client.guilds.fetch(ticket.guildId).catch(() => null);
    const channel =
      guild && ticket.channelId
        ? await guild.channels.fetch(ticket.channelId).catch(() => null)
        : null;

    if (ticket.status === "CLOSED") {
      const deleteAt = (ticket.closedAt?.getTime() ?? ticket.updatedAt.getTime()) + TICKET_DELETE_DELAY_MS;
      if (deleteAt > Date.now()) continue;
      if (channel) await channel.delete("Closed ticket cleanup").catch(() => undefined);
      await prisma.ticket.update({ where: { id: ticket.id }, data: { channelId: null } });
      continue;
    }

    if (!channel) {
      const now = new Date();
      await prisma.$transaction([
        prisma.ticket.update({
          where: { id: ticket.id },
          data: {
            status: "CLOSED",
            channelId: null,
            closedAt: now,
            closeReason: "Channel missing during startup recovery",
          },
        }),
        prisma.ticketEvent.create({
          data: {
            ticketId: ticket.id,
            type: "RECOVERED_MISSING_CHANNEL",
            actorDiscordId: "system",
            data: { channelName: ticket.channelName },
          },
        }),
      ]);
      await audit({
        category: AuditCategory.TICKET,
        action: "MISSING_CHANNEL_RECOVERED",
        guildId: ticket.guildId,
        targetDiscordId: ticket.discordUserId,
        details: { ticketId: ticket.id, channelName: ticket.channelName },
      });
      log.warn(`Closed stale ticket ${ticket.id}: Discord channel no longer exists.`);
    }
  }
}
