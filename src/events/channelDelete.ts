import { ChannelType, type Channel, type Client } from "discord.js";
import { prisma } from "../database/prisma.js";
import { log } from "../utils/logger.js";

/**
 * If a ticket channel is deleted outside the bot (mod, prune, accidental),
 * close the ticket row so no open ticket ever references a dead channel.
 */
export function onChannelDelete(_client: Client, channel: Channel): void {
  if (channel.type !== ChannelType.GuildText || !channel.guild) return;
  const guildId = channel.guild.id;
  void (async () => {
    try {
      const ticket = await prisma.ticket.findUnique({
        where: { guildId_channelName: { guildId, channelName: channel.name } },
      });
      if (!ticket || ticket.status === "CLOSED") return;
      await prisma.$transaction([
        prisma.ticket.update({
          where: { id: ticket.id },
          data: {
            status: "CLOSED",
            closedAt: new Date(),
            closeReason: "Channel was deleted outside the bot",
            closedByDiscordId: null,
          },
        }),
        prisma.ticketEvent.create({
          data: {
            ticketId: ticket.id,
            type: "DELETED",
            actorDiscordId: "system",
            data: { channelName: channel.name },
          },
        }),
      ]);
      log.info(`Ticket #${ticket.number} (${channel.name}) closed: channel was deleted externally.`);
    } catch (err) {
      log.error("channelDelete ticket cleanup failed", err);
    }
  })();
}
