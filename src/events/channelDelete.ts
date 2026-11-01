import { ChannelType, type Channel, type Client } from "discord.js";
import { prisma } from "../database/prisma.js";
import { log } from "../utils/logger.js";
import { voiceService } from "../services/VoiceService.js";

/**
 * If a ticket channel is deleted outside the bot (mod, prune, accidental),
 * close the ticket row so no open ticket ever references a dead channel.
 * Also clears a persisted /voice park if the parked channel was deleted.
 */
export function onChannelDelete(_client: Client, channel: Channel): void {
  // /voice parked channel deleted → stop trying to stay parked there.
  if (channel.isVoiceBased()) {
    void voiceService.onChannelDeleted(channel.guild.id, channel.id).catch((err) =>
      log.error(`Failed to clear voice state after channel deletion (${channel.id})`, err),
    );
  }

  if (channel.type !== ChannelType.GuildText || !channel.guild) return;
  const guildId = channel.guild.id;
  void (async () => {
    try {
      const ticket = await prisma.ticket.findUnique({
        where: { channelId: channel.id },
      });
      if (!ticket || ticket.guildId !== guildId || ticket.status === "CLOSED") return;
      await prisma.$transaction([
        prisma.ticket.update({
          where: { id: ticket.id },
          data: {
            status: "CLOSED",
            channelId: null,
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
