import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  GuildMember,
  type Guild,
} from "discord.js";
import {
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { AppError } from "../../utils/errors.js";
import type { MarketplaceCommand } from "../../handlers/commandHandler.js";
import { requireAdmin } from "../../utils/permissions.js";
import { findSettings } from "../../services/GuildSettingsService.js";

/**
 * Voice presence: park the bot in a voice channel — self-deafened and
 * self-muted — until told to leave. Presence only: the bot cannot and does
 * not listen to, record, or play anything (self-deaf also disables audio
 * receiving at the Discord gateway level).
 *
 * "Never leaves": the desired channel is remembered per guild and the
 * connection auto-rejoins if it drops. State is in-memory — a restart
 * (deploy) clears it, so run /voice join again after a deploy.
 */

const desiredVoiceChannels = new Map<string, string>();

function joinDesired(guild: Guild, channelId: string, client: Client): void {
  desiredVoiceChannels.set(guild.id, channelId);
  const connection = joinVoiceChannel({
    channelId,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: true,
  });

  // "Never leave unless told": if the connection drops (network blip, moved
  // channel, brief kick), try an in-place rejoin, then a full rejoin from
  // the remembered channel. /voice leave clears the desired state first.
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    if (desiredVoiceChannels.get(guild.id) !== channelId) return;
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      setTimeout(() => {
        if (desiredVoiceChannels.get(guild.id) !== channelId) return;
        joinDesired(guild, channelId, client);
      }, 5_000).unref();
    }
  });
}

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) throw new AppError({ code: "NO_GUILD", friendly: "❌ This can only be used in a server." });
  const member = interaction.member;
  if (!(member instanceof GuildMember)) {
    throw new AppError({ code: "NOT_A_MEMBER", friendly: "❌ This can only be used by server members." });
  }
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

    joinDesired(guild, channel.id, interaction.client);

    await interaction.reply({
      content: `🔇 Parked in **${channel.name}** — deafened and muted. I will stay here until \`/voice leave\`.`,
      ephemeral: true,
    });
    return;
  }

  // leave
  desiredVoiceChannels.delete(guild.id);
  const connection = getVoiceConnection(guild.id);
  if (!connection) {
    throw new AppError({ code: "NOT_IN_VOICE", friendly: "❌ I'm not in a voice channel here." });
  }
  connection.destroy();
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
