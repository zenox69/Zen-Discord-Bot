import { EmbedBuilder } from "discord.js";

/**
 * Consistent embed design system.
 * Colors: green = success/eligible, red = error/not-eligible/cancelled,
 * yellow = pending, blue = info/active.
 */
export const COLORS = {
  success: 0x2fcb6e,
  error: 0xed4245,
  warning: 0xf0b132,
  info: 0x3498db,
  brand: 0x5865f2,
} as const;

export type EmbedColor = (typeof COLORS)[keyof typeof COLORS];

export function baseEmbed(color: EmbedColor, marketplaceName?: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(color);
  if (marketplaceName) {
    embed.setFooter({ text: `${marketplaceName} • Order System` });
  }
  return embed;
}

export function successEmbed(title: string, description?: string, marketplaceName?: string) {
  return baseEmbed(COLORS.success, marketplaceName).setTitle(title).setDescription(description ?? null);
}

export function errorEmbed(title: string, description?: string, marketplaceName?: string) {
  return baseEmbed(COLORS.error, marketplaceName).setTitle(title).setDescription(description ?? null);
}

export function warnEmbed(title: string, description?: string, marketplaceName?: string) {
  return baseEmbed(COLORS.warning, marketplaceName).setTitle(title).setDescription(description ?? null);
}

export function infoEmbed(title: string, description?: string, marketplaceName?: string) {
  return baseEmbed(COLORS.info, marketplaceName).setTitle(title).setDescription(description ?? null);
}

export function setPager(embed: EmbedBuilder, page: number, total: number): EmbedBuilder {
  const existing = embed.data.footer?.text ?? "";
  const footer = existing ? `${existing} • ` : "";
  return embed.setFooter({ text: `${footer}Page ${page} / ${total}` });
}

/** Clamp a string to Discord field/description limits. */
export function trunc(text: string, max = 1024): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
