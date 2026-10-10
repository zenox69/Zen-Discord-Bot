import { AuditCategory } from "@prisma/client";
import type { Client } from "discord.js";
import { TICKET_DELETE_DELAY_MS } from "../config/constants.js";
import { prisma } from "../database/prisma.js";
import { audit } from "../services/AuditService.js";
import { log } from "../utils/logger.js";
import { withWorkflowLock } from "../utils/workflowLock.js";
import { isGuildAllowed } from "../config/guildAllowlist.js";

export async function recoverTicketChannels(client: Client): Promise<void> {
  const tickets = await prisma.ticket.findMany({ where: { channelId: { not: null } } });
  for (const ticket of tickets) {
    if (!isGuildAllowed(ticket.guildId)) continue;
    if (ticket.status === "CLOSED" && (ticket.closedAt?.getTime() ?? ticket.updatedAt.getTime()) + TICKET_DELETE_DELAY_MS > Date.now()) continue;
    try {
    await withWorkflowLock(`ticket:${ticket.id}`, async () => {
    const guild = await client.guilds.fetch(ticket.guildId);
    const channel =
      guild && ticket.channelId
        ? await guild.channels.fetch(ticket.channelId, { force: true }).catch((error: unknown) => {
            if (error && typeof error === "object" && "code" in error && error.code === 10003) return null;
            throw error;
          })
        : null;

    if (ticket.status === "CLOSED") {
      const deleteAt = (ticket.closedAt?.getTime() ?? ticket.updatedAt.getTime()) + TICKET_DELETE_DELAY_MS;
      if (deleteAt > Date.now()) return;
      if (channel) await channel.delete("Closed ticket cleanup");
      await prisma.ticket.updateMany({ where: { id: ticket.id, status: "CLOSED", channelId: ticket.channelId }, data: { channelId: null } });
      return;
    }

    if (!channel) {
      const now = new Date();
      const closed = await prisma.$transaction(async (tx) => {
        const result = await tx.ticket.updateMany({
          where: { id: ticket.id, status: "OPEN", channelId: ticket.channelId, updatedAt: ticket.updatedAt },
          data: {
            status: "CLOSED",
            channelId: null,
            closedAt: now,
            closeReason: "Channel confirmed missing during recovery",
          },
        });
        if (result.count === 0) return false;
        await tx.ticketEvent.create({
          data: {
            ticketId: ticket.id,
            type: "RECOVERED_MISSING_CHANNEL",
            actorDiscordId: "system",
            data: { channelName: ticket.channelName },
          },
        });
        return true;
      });
      if (!closed) return;
      await audit({
        category: AuditCategory.TICKET,
        action: "MISSING_CHANNEL_RECOVERED",
        guildId: ticket.guildId,
        targetDiscordId: ticket.discordUserId,
        details: { ticketId: ticket.id, channelName: ticket.channelName },
      });
      log.warn(`Closed stale ticket ${ticket.id}: Discord channel no longer exists.`);
    }
    });
    } catch (error) {
      log.warn("Ticket recovery deferred; channel reference retained for retry", { ticketId: ticket.id }, error);
    }
  }
}
