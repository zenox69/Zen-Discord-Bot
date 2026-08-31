import type { GuildSettings } from "@prisma/client";
import { prisma } from "../database/prisma.js";

/**
 * Guild configuration service. Every guild has its own row; commands and
 * interactions always resolve the current guild's settings — no hard-coded
 * guild, channel, or role IDs anywhere in the codebase.
 */

export async function ensureGuild(guildId: string, guildName: string): Promise<GuildSettings> {
  await prisma.discordGuild.upsert({
    where: { id: guildId },
    update: { name: guildName },
    create: { id: guildId, name: guildName },
  });
  await prisma.guildSettings.upsert({
    where: { guildId },
    update: {},
    create: { guildId },
  });
  return prisma.guildSettings.findUniqueOrThrow({ where: { guildId } });
}

export async function findSettings(guildId: string): Promise<GuildSettings | null> {
  return prisma.guildSettings.findUnique({ where: { guildId } });
}

export type GuildSettingsPatch = Partial<
  Omit<GuildSettings, "guildId" | "createdAt" | "updatedAt">
>;

export async function updateSettings(guildId: string, data: GuildSettingsPatch): Promise<GuildSettings> {
  return prisma.guildSettings.update({ where: { guildId }, data });
}
