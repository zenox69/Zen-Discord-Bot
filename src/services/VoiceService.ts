import { type Client, type Guild, type VoiceBasedChannel } from "discord.js";
import {
  entersState,
  generateDependencyReport,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  type VoiceConnection,
} from "@discordjs/voice";
import { prisma } from "../database/prisma.js";
import { log } from "../utils/logger.js";
import { allowedGuildIds, isGuildAllowed } from "../config/guildAllowlist.js";

/**
 * Voice presence service. `/voice join` parks the bot in a voice channel —
 * self-deafened and self-muted, presence only (never listens, records, or
 * plays audio; self-deaf disables receiving at the gateway level).
 *
 * "Never leaves unless told":
 *  - The desired channel is PERSISTED in GuildSettings.voiceChannelId, so the
 *    bot rejoins after any restart/deploy (`rejoinPersisted` runs on ready).
 *  - If the live connection drops, the handler waits briefly for the library's
 *    own auto-reconnect, then destroys the wedged connection and joins fresh.
 *    Bounded retries prevent an infinite loop (e.g. missing Connect permission
 *    or a deleted channel), after which the persisted state is cleared.
 *  - `/voice leave` and a deleted parked channel clear the state.
 *  - During shutdown (`beginShutdown`) recovery stops WITHOUT clearing the
 *    persisted target, so the next container rejoins on startup — this avoids
 *    a deploy-overlap kick/rejoin ping-pong.
 */

const RECONNECT_WAIT_MS = 5_000;
const MAX_REJOIN_ATTEMPTS = 3;

export class VoiceService {
  /** Fast in-memory view of the desired channel per guild (seeded from DB). */
  private readonly desired = new Map<string, string>();
  /** Consecutive failed fresh-rejoin attempts per guild (reset on Ready). */
  private readonly failedRejoins = new Map<string, number>();
  /** Connections whose reconnect listeners are already attached. */
  private readonly armedConnections = new WeakSet<VoiceConnection>();
  /** Set when the process is shutting down — recovery stops, state is kept. */
  private shuttingDown = false;
  private dependencyReportLogged = false;

  /** Stop all recovery during shutdown without clearing the persisted target. */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  /** Print @discordjs/voice's dependency report once at boot (diagnostics). */
  logDependencyReport(): void {
    if (this.dependencyReportLogged) return;
    this.dependencyReportLogged = true;
    try {
      log.info(`@discordjs/voice dependency report:\n${generateDependencyReport()}`);
    } catch (err) {
      // Never block startup/jobs over a diagnostics report.
      log.warn("Failed to generate @discordjs/voice dependency report", err);
    }
  }

  isDesired(guildId: string, channelId: string): boolean {
    return this.desired.get(guildId) === channelId;
  }

  // ---------------------------------------------------------------- persistence

  async getPersistedTargets(): Promise<Array<{ guildId: string; channelId: string }>> {
    const rows = await prisma.guildSettings.findMany({
      where: { voiceChannelId: { not: null } },
      select: { guildId: true, voiceChannelId: true },
    });
    return rows.flatMap((row) =>
      row.voiceChannelId ? [{ guildId: row.guildId, channelId: row.voiceChannelId }] : [],
    );
  }

  /** Persist the parked target (requires an existing GuildSettings row — /setup). */
  async persistTarget(guildId: string, channelId: string): Promise<void> {
    await prisma.guildSettings.update({ where: { guildId }, data: { voiceChannelId: channelId } });
  }

  /** Clear the persisted target; updateMany never throws when the row is missing. */
  async clearTarget(guildId: string): Promise<void> {
    await prisma.guildSettings.updateMany({ where: { guildId }, data: { voiceChannelId: null } });
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Park the bot in a channel: remember + persist the target, join, and arm
   * the reconnect handlers. Rejoining is handled on every live drop; a fresh
   * connection is created after the old one is destroyed, re-arming handlers.
   */
  joinPresence(guild: Guild, channelId: string): VoiceConnection {
    this.desired.set(guild.id, channelId);
    const connection = joinVoiceChannel({
      channelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: true,
    });
    this.armConnection(guild, connection);
    return connection;
  }

  /**
   * Attach the reconnect listeners at most once per connection.
   * joinVoiceChannel() can return an existing connection, so a repeated
   * `/voice join` must not stack another pair of listeners. The channel id is
   * read at drop time (not closed over): joining a NEW channel while parked
   * moves the same connection, and recovery must target the current channel.
   */
  private armConnection(guild: Guild, connection: VoiceConnection): void {
    if (this.armedConnections.has(connection)) return;
    this.armedConnections.add(connection);
    // A successful reconnection means the state recovered — reset the counter.
    connection.on(VoiceConnectionStatus.Ready, () => this.failedRejoins.delete(guild.id));
    connection.on(VoiceConnectionStatus.Disconnected, (_oldState, newState) => {
      // Manual = destroyed by /voice leave (which clears state first).
      if (newState.reason === VoiceConnectionDisconnectReason.Manual) return;
      const current = this.desired.get(guild.id);
      if (!current) return;
      void this.handleDrop(guild, current, connection).catch((err) =>
        log.error(`Voice drop recovery failed in guild ${guild.id}`, err),
      );
    });
  }

  /** Leave the channel and clear all state. Returns false if not in voice. */
  async leavePresence(guildId: string): Promise<boolean> {
    this.desired.delete(guildId);
    this.failedRejoins.delete(guildId);
    const connection = getVoiceConnection(guildId);
    if (!connection) {
      await this.clearTarget(guildId);
      return false;
    }
    try {
      connection.destroy();
    } catch (err) {
      log.warn(`Voice connection already destroyed in guild ${guildId}`, err);
    }
    await this.clearTarget(guildId);
    return true;
  }

  /**
   * Startup recovery: rejoin every persisted target whose channel still
   * exists and is joinable. Skips (and clears) targets whose guild is gone,
   * not allowlisted, or whose channel vanished — no retry loops at boot.
   */
  async rejoinPersisted(client: Client): Promise<number> {
    const targets = await this.getPersistedTargets();
    let rejoined = 0;
    for (const { guildId, channelId } of targets) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        await this.clearTarget(guildId);
        log.warn(`Cleared persisted /voice target: bot is not in guild ${guildId}.`);
        continue;
      }
      if (allowedGuildIds.size > 0 && !isGuildAllowed(guildId)) {
        await this.clearTarget(guildId);
        log.warn(`Cleared persisted /voice target: guild ${guildId} is not allowlisted.`);
        continue;
      }
      const channel = guild.channels.cache.get(channelId);
      if (!channel || !channel.isVoiceBased()) {
        await this.clearTarget(guildId);
        log.warn(`Cleared persisted /voice target: channel ${channelId} no longer exists in guild ${guildId}.`);
        continue;
      }
      if (!canJoinChannel(guild, channel)) {
        await this.clearTarget(guildId);
        log.warn(`Cleared persisted /voice target: no Connect permission for channel ${channelId}.`);
        continue;
      }
      this.joinPresence(guild, channelId);
      rejoined += 1;
      log.info(`Rejoined persisted /voice channel ${channelId} in guild ${guildId}.`);
    }
    return rejoined;
  }

  /**
   * Drop recovery. Called on every non-manual Disconnected:
   *  1. Skip during shutdown and for channels that are no longer desired.
   *  2. Wait briefly for the library's own auto-reconnect (non-4014 drops).
   *  3. Re-check state, then destroy the wedged connection and join fresh —
   *     bounded, so persistent failures stop after N tries.
   */
  async handleDrop(guild: Guild, channelId: string, connection: VoiceConnection): Promise<void> {
    if (this.shuttingDown) return;
    if (!this.isDesired(guild.id, channelId)) return;

    const closeCode = (connection.state as { closeCode?: number }).closeCode;
    log.warn(`Voice connection dropped in guild ${guild.id} (close code ${closeCode ?? "n/a"}) — attempting rejoin.`);

    try {
      await entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_WAIT_MS);
      return; // Library auto-reconnected; Ready listener resets the counter.
    } catch {
      // No auto-reconnect (e.g. 4014 kick/move/delete) — recover manually.
    }

    // State may have changed while waiting (leave, shutdown, another recovery).
    if (this.shuttingDown || !this.isDesired(guild.id, channelId)) return;
    if (connection.state.status === VoiceConnectionStatus.Destroyed) return;

    try {
      connection.destroy();
    } catch (err) {
      log.warn(`Voice connection already destroyed in guild ${guild.id}`, err);
    }
    this.failedRejoins.set(guild.id, (this.failedRejoins.get(guild.id) ?? 0) + 1);

    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased() || !canJoinChannel(guild, channel)) {
      await this.clearState(guild.id, `Voice rejoin failed: channel ${channelId} is gone or not joinable — cleared /voice state.`);
      return;
    }
    if ((this.failedRejoins.get(guild.id) ?? 0) >= MAX_REJOIN_ATTEMPTS) {
      await this.clearState(guild.id, `Voice rejoin failed ${MAX_REJOIN_ATTEMPTS} times in guild ${guild.id} — cleared /voice state.`);
      return;
    }

    this.joinPresence(guild, channelId);
    log.info(`Rejoined voice channel ${channelId} in guild ${guild.id} after a drop.`);
  }

  /** The parked channel was deleted — clear the state so nothing rejoins it. */
  async onChannelDeleted(guildId: string, channelId: string): Promise<void> {
    if (!this.isDesired(guildId, channelId)) return;
    const connection = getVoiceConnection(guildId);
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
      try {
        connection.destroy();
      } catch (err) {
        log.warn(`Voice connection already destroyed in guild ${guildId}`, err);
      }
    }
    await this.clearState(guildId, `Parked voice channel ${channelId} was deleted — cleared /voice state.`);
  }

  private async clearState(guildId: string, reason: string): Promise<void> {
    this.desired.delete(guildId);
    this.failedRejoins.delete(guildId);
    await this.clearTarget(guildId);
    log.warn(reason);
  }
}

/** True when the cached bot member has Connect, or when it can't be determined. */
function canJoinChannel(guild: Guild, channel: VoiceBasedChannel): boolean {
  const me = guild.members.me;
  if (!me) return true;
  return channel.permissionsFor(me)?.has("Connect") ?? false;
}

export const voiceService = new VoiceService();
