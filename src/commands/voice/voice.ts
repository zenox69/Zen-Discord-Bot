import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { AppError } from "../../utils/errors.js";
import type { MarketplaceCommand } from "../../handlers/commandHandler.js";
import { getInteractionMember, requireAdmin } from "../../utils/permissions.js";
import { findSettings } from "../../services/GuildSettingsService.js";
import { voiceService } from "../../services/VoiceService.js";

/**
 * Voice presence: park the bot in a voice channel — self-deafened and
 * self-muted — until told to leave. Presence only: the bot cannot and does
 * not listen to, record, or play anything (self-deaf also disables audio
 * receiving at the Discord gateway level).
 *
 * "Never leaves": the desired channel is persisted and the connection
 * auto-rejoins if it drops, including after a restart/deploy.
 */

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) throw new AppError({ code: "NO_GUILD", friendly: "❌ This can only be used in a server." });
  const member = await getInteractionMember(interaction);
  const settings = await findSettings(guild.id);
  if (!settings) {
    throw new AppError({ code: "NOT_CONFIGURED", friendly: "❌ This server is not set up yet — run `/setup`." });
  }
  requireAdmin(member, settings);

  const sub = interaction.options.getSubcommand();

  if (sub === "join") {
    const explicitId = interaction.options.getChannel("channel")?.id ?? null;
    const channel = explicitId ? guild.channels.cache.get(explicitId) : (member.voice.channel ?? null);
    if (!channel || !channel.isVoiceBased()) {
      throw new AppError({
        code: "NO_VOICE_CHANNEL",
        friendly: "❌ Join a voice channel first, or pass the channel option.",
      });
    }
    const perms = channel.permissionsFor(guild.members.me!);
    if (!perms?.has("Connect")) {
      throw new AppError({
        code: "NO_VOICE_PERMS",
        friendly: "❌ I need the **Connect** permission in that voice channel.",
      });
    }

    await voiceService.persistTarget(guild.id, channel.id);
    voiceService.joinPresence(guild, channel.id);

    await interaction.reply({
      content: `🔇 Parked in **${channel.name}** — deafened and muted. I will stay here until \`/voice leave\`, even across restarts.`,
      ephemeral: true,
    });
    return;
  }

  // leave
  const hadConnection = await voiceService.leavePresence(guild.id);
  if (!hadConnection) {
    throw new AppError({ code: "NOT_IN_VOICE", friendly: "❌ I'm not in a voice channel here." });
  }
  await interaction.reply({ content: "👋 Left the voice channel.", ephemeral: true });
}

export const voiceCommand: MarketplaceCommand = {
  data: new SlashCommandBuilder()
    .setName("voice")
    .setDescription("Voice presence: park the bot in a voice channel (deafened & muted)")
    .addSubcommand((sub) =>
      sub
        .setName("join")
        .setDescription("Join a voice channel — stays until /voice leave")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Voice channel (defaults to the one you're in)")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) => sub.setName("leave").setDescription("Leave the voice channel")),
  execute,
};
