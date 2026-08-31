import { AuditCategory, type GuildSettings, Prisma } from "@prisma/client";
import { EmbedBuilder } from "discord.js";
import { prisma } from "../database/prisma.js";
import { getBotClient } from "../utils/botClient.js";
import { COLORS } from "../utils/embeds.js";
import { log } from "../utils/logger.js";

/**
 * AuditService — every important action writes a durable AuditLog row AND,
 * when the guild has configured a log channel for the category, a Discord
 * message. Channel delivery is best-effort; the DB row is authoritative.
 */

export interface AuditEntry {
  category: AuditCategory;
  action: string;
  guildId?: string | null;
  actorDiscordId?: string | null;
  targetDiscordId?: string | null;
  details?: Record<string, unknown>;
}

const CHANNEL_BY_CATEGORY: Record<AuditCategory, (s: GuildSettings) => string | null> = {
  [AuditCategory.VERIFICATION]: (s) => s.verificationLogChannelId,
  [AuditCategory.TICKET]: (s) => s.ticketLogChannelId,
  [AuditCategory.ORDER]: (s) => s.orderLogChannelId,
  [AuditCategory.ELIGIBILITY]: (s) => s.eligibilityLogChannelId,
  [AuditCategory.COMMUNITY]: (s) => s.errorLogChannelId,
  [AuditCategory.PRODUCT]: (s) => s.errorLogChannelId,
  [AuditCategory.SYSTEM]: (s) => s.errorLogChannelId,
};

function humanize(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        guildId: entry.guildId ?? null,
        category: entry.category,
        action: entry.action,
        actorDiscordId: entry.actorDiscordId ?? null,
        targetDiscordId: entry.targetDiscordId ?? null,
        details: (entry.details ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    log.error("Failed to write audit log row", err);
    return;
  }

  if (!entry.guildId) return;
  try {
    const settings = await prisma.guildSettings.findUnique({ where: { guildId: entry.guildId } });
    if (!settings) return;
    const channelId = CHANNEL_BY_CATEGORY[entry.category](settings);
    if (!channelId) return;

    const client = getBotClient();
    const channel = (await client.channels.fetch(channelId).catch(() => null)) as
      | { send?: (opts: { embeds: EmbedBuilder[] }) => Promise<unknown> }
      | null;
    if (!channel || typeof channel.send !== "function") return;

    const detailLines = Object.entries(entry.details ?? {})
      .slice(0, 8)
      .map(([key, value]) => `**${humanize(key)}:** ${String(value)}`);

    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setAuthor({ name: `${entry.category} • ${entry.action}` })
      .addFields(
        { name: "Actor", value: entry.actorDiscordId ? `<@${entry.actorDiscordId}>` : "system", inline: true },
        { name: "Target", value: entry.targetDiscordId ? `<@${entry.targetDiscordId}>` : "—", inline: true },
      )
      .setTimestamp();
    if (detailLines.length > 0) {
      embed.addFields({ name: "Details", value: detailLines.join("\n").slice(0, 1024) });
    }
    await channel.send({ embeds: [embed] });
  } catch (err) {
    log.warn("Failed to post audit channel message", err);
  }
}
