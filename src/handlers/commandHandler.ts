import {
  type SlashCommandBuilder,
  type SlashCommandOptionsOnlyBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from "@discordjs/builders";
import { ChatInputCommandInteraction, PermissionFlagsBits, type GuildMember } from "discord.js";
import { findSettings } from "../services/GuildSettingsService.js";
import { AppError } from "../utils/errors.js";
import { handleFatal } from "../utils/errorBoundary.js";
import { log } from "../utils/logger.js";
import { requireAdmin, requireStaff } from "../utils/permissions.js";

/**
 * Slash-command builder type. @discordjs/builders narrows the builder after
 * each mutation, so commands may end up as any of the three variants.
 */
export type CommandBuilder =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

export interface MarketplaceCommand {
  data: CommandBuilder;
  /** Administrator only. */
  requireAdmin?: boolean;
  /** Staff or administrator. */
  requireStaff?: boolean;
  /** Set false only for /setup, which must work before the guild is configured. */
  requireConfigured?: boolean;
  /** Administrative recovery commands such as /setup can run while disabled. */
  allowWhenDisabled?: boolean;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export async function runCommand(
  command: MarketplaceCommand,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  // EVERY throw below — including permission/configuration checks — must
  // become a friendly reply, or Discord shows "The application did not respond".
  await handleFatal(async () => {
    if (!interaction.inGuild() || !interaction.guild) {
      throw new AppError({
        code: "DM_NOT_ALLOWED",
        friendly: "❌ This command can only be used inside a Discord server.",
      });
    }

    const guild = interaction.guild;
    // GUILD_CREATE does not carry owner_id, so owner checks would silently
    // fail until the guild is fetched from the REST API once per process.
    if (!guild.ownerId) await guild.fetch().catch(() => undefined);
    const settings = await findSettings(guild.id);

    if (command.requireConfigured !== false && !settings) {
      throw new AppError({
        code: "NOT_CONFIGURED",
        friendly: "❌ This server is not set up yet.\nAn administrator needs to run `/setup` first.",
      });
    }
    if (settings && !settings.enabled && !command.allowWhenDisabled) {
      throw new AppError({
        code: "MARKETPLACE_DISABLED",
        friendly: "❌ The marketplace is currently disabled on this server.",
      });
    }
    const member = interaction.member as GuildMember;
    if (settings) {
      if (command.requireAdmin) {
        requireAdmin(member, settings);
      } else if (command.requireStaff) {
        requireStaff(member, settings);
      }
    } else if (command.requireAdmin) {
      // Bootstrap security: before an admin role is configured, only the guild
      // owner or a native Discord Administrator may initialize the bot.
      const canBootstrap =
        guild.ownerId === interaction.user.id ||
        member.permissions.has(PermissionFlagsBits.Administrator);
      if (!canBootstrap) {
        throw new AppError({
          code: "NOT_BOOTSTRAP_ADMIN",
          friendly: "❌ Only the server owner or a Discord Administrator can run the initial setup.",
        });
      }
    }

    log.debug(`Command /${interaction.commandName} by ${interaction.user.tag} in ${guild.name}`);
    await command.execute(interaction);
  }, { interaction, guildId: interaction.guildId ?? undefined });
}
