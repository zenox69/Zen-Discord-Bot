import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client, Guild } from "discord.js";
import type { VoiceConnection } from "@discordjs/voice";

const mocks = vi.hoisted(() => ({
  prisma: {
    guildSettings: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
  entersState: vi.fn(),
  getVoiceConnection: vi.fn(),
  joinVoiceChannel: vi.fn(),
  generateDependencyReport: vi.fn(() => "dependency report"),
  VoiceConnectionStatus: {
    Ready: "ready",
    Disconnected: "disconnected",
    Connecting: "connecting",
    Signalling: "signalling",
    Destroyed: "destroyed",
  },
  VoiceConnectionDisconnectReason: { Manual: 3, WebSocketClose: 0, AdapterUnavailable: 1 },
  allowedGuildIds: new Set<string>(),
  isGuildAllowed: vi.fn(() => true),
}));

vi.mock("../src/database/prisma.js", () => ({ prisma: mocks.prisma }));
vi.mock("@discordjs/voice", () => ({
  entersState: mocks.entersState,
  getVoiceConnection: mocks.getVoiceConnection,
  joinVoiceChannel: mocks.joinVoiceChannel,
  generateDependencyReport: mocks.generateDependencyReport,
  VoiceConnectionStatus: mocks.VoiceConnectionStatus,
  VoiceConnectionDisconnectReason: mocks.VoiceConnectionDisconnectReason,
}));
vi.mock("../src/config/guildAllowlist.js", () => ({
  allowedGuildIds: mocks.allowedGuildIds,
  isGuildAllowed: mocks.isGuildAllowed,
}));

import { VoiceService } from "../src/services/VoiceService.js";

class FakeConnection extends EventEmitter {
  destroyed = false;
  state: { status: string; closeCode?: number } = { status: "disconnected", closeCode: 4014 };
  destroy(): void {
    this.destroyed = true;
  }
}

function makeChannel(id = "c-1", connect = true) {
  return {
    id,
    name: id,
    isVoiceBased: () => true,
    permissionsFor: vi.fn(() => ({ has: (perm: string) => connect && perm === "Connect" })),
  };
}

function makeGuild(id = "g-1", channels = new Map<string, unknown>()): Guild {
  return {
    id,
    voiceAdapterCreator: {},
    channels: { cache: channels },
    members: { me: { id: "bot" } },
  } as unknown as Guild;
}

function makeClient(guilds = new Map<string, unknown>()): Client {
  return { guilds: { cache: guilds } } as unknown as Client;
}

function lastConnection(): FakeConnection {
  const results = mocks.joinVoiceChannel.mock.results;
  return results[results.length - 1]!.value as FakeConnection;
}

const clearCall = { where: { guildId: "g-1" }, data: { voiceChannelId: null } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.allowedGuildIds.clear();
  mocks.isGuildAllowed.mockReturnValue(true);
  mocks.entersState.mockRejectedValue(new Error("timeout"));
  mocks.getVoiceConnection.mockReturnValue(null);
  mocks.joinVoiceChannel.mockImplementation(() => new FakeConnection());
});

describe("VoiceService — persistence", () => {
  it("maps persisted rows, dropping null channel ids", async () => {
    mocks.prisma.guildSettings.findMany.mockResolvedValue([
      { guildId: "g-1", voiceChannelId: "c-1" },
      { guildId: "g-2", voiceChannelId: null },
    ]);
    const svc = new VoiceService();
    await expect(svc.getPersistedTargets()).resolves.toEqual([{ guildId: "g-1", channelId: "c-1" }]);
  });

  it("persists the target via update and clears it via updateMany", async () => {
    const svc = new VoiceService();
    await svc.persistTarget("g-1", "c-1");
    expect(mocks.prisma.guildSettings.update).toHaveBeenCalledWith({
      where: { guildId: "g-1" },
      data: { voiceChannelId: "c-1" },
    });
    await svc.clearTarget("g-1");
    expect(mocks.prisma.guildSettings.updateMany).toHaveBeenCalledWith(clearCall);
  });
});

describe("VoiceService — join / leave", () => {
  it("joins self-deafened and self-muted and remembers the target", () => {
    const svc = new VoiceService();
    const guild = makeGuild();
    const conn = svc.joinPresence(guild, "c-1");
    expect(mocks.joinVoiceChannel).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "c-1", guildId: "g-1", selfDeaf: true, selfMute: true }),
    );
    expect(conn).toBeInstanceOf(FakeConnection);
    expect(svc.isDesired("g-1", "c-1")).toBe(true);
  });

  it("leave destroys the connection and clears the persisted state", async () => {
    const svc = new VoiceService();
    const guild = makeGuild();
    svc.joinPresence(guild, "c-1");
    const conn = lastConnection();
    mocks.getVoiceConnection.mockReturnValue(conn);
    await expect(svc.leavePresence("g-1")).resolves.toBe(true);
    expect(conn.destroyed).toBe(true);
    expect(svc.isDesired("g-1", "c-1")).toBe(false);
    expect(mocks.prisma.guildSettings.updateMany).toHaveBeenCalledWith(clearCall);
  });

  it("leave reports not-in-voice but still clears state", async () => {
    const svc = new VoiceService();
    await expect(svc.leavePresence("g-1")).resolves.toBe(false);
    expect(mocks.prisma.guildSettings.updateMany).toHaveBeenCalledWith(clearCall);
  });

  it("arms reconnect listeners only once per connection", () => {
    const shared = new FakeConnection();
    mocks.joinVoiceChannel.mockReturnValue(shared);
    const svc = new VoiceService();
    const guild = makeGuild("g-1", new Map([["c-1", makeChannel("c-1")]]));
    svc.joinPresence(guild, "c-1");
    svc.joinPresence(guild, "c-1");
    expect(shared.listenerCount("disconnected")).toBe(1);
    expect(shared.listenerCount("ready")).toBe(1);
  });

  it("recovery retargets the CURRENT desired channel when the connection moves", async () => {
    const shared = new FakeConnection();
    mocks.joinVoiceChannel.mockReturnValue(shared);
    const svc = new VoiceService();
    const guild = makeGuild("g-1", new Map([
      ["c-1", makeChannel("c-1")],
      ["c-2", makeChannel("c-2")],
    ]));
    svc.joinPresence(guild, "c-1");
    svc.joinPresence(guild, "c-2"); // same connection moved to a new channel
    expect(svc.isDesired("g-1", "c-2")).toBe(true);

    shared.emit("disconnected", {}, { reason: 0, closeCode: 4014 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Fresh rejoin must target the new channel, not the frozen first one.
    expect(shared.destroyed).toBe(true);
    expect(mocks.joinVoiceChannel).toHaveBeenCalledTimes(3); // join c-1, move to c-2, rejoin c-2
    expect(mocks.joinVoiceChannel).toHaveBeenLastCalledWith(expect.objectContaining({ channelId: "c-2" }));
  });
});

describe("VoiceService — drop recovery", () => {
  it("ignores a drop for a channel that is no longer desired", async () => {
    const svc = new VoiceService();
    const conn = new FakeConnection();
    await svc.handleDrop(makeGuild(), "c-1", conn as unknown as VoiceConnection);
    expect(conn.destroyed).toBe(false);
    expect(mocks.joinVoiceChannel).not.toHaveBeenCalled();
  });

  it("lets the library auto-reconnect instead of forcing a fresh join", async () => {
    mocks.entersState.mockResolvedValue(undefined);
    const svc = new VoiceService();
    const guild = makeGuild();
    svc.joinPresence(guild, "c-1");
    const conn = lastConnection();
    await svc.handleDrop(guild, "c-1", conn as unknown as VoiceConnection);
    expect(conn.destroyed).toBe(false);
    expect(mocks.joinVoiceChannel).toHaveBeenCalledTimes(1);
  });

  it("destroys the wedged connection and joins fresh when auto-reconnect times out", async () => {
    const svc = new VoiceService();
    const guild = makeGuild("g-1", new Map([["c-1", makeChannel("c-1")]]));
    svc.joinPresence(guild, "c-1");
    const first = lastConnection();
    await svc.handleDrop(guild, "c-1", first as unknown as VoiceConnection);
    expect(first.destroyed).toBe(true);
    expect(mocks.joinVoiceChannel).toHaveBeenCalledTimes(2);
  });

  it("does not throw or rejoin when the connection was already destroyed during the wait", async () => {
    const svc = new VoiceService();
    const guild = makeGuild();
    svc.joinPresence(guild, "c-1");
    const conn = lastConnection();
    conn.state.status = "destroyed";
    await expect(svc.handleDrop(guild, "c-1", conn as unknown as VoiceConnection)).resolves.toBeUndefined();
    expect(mocks.joinVoiceChannel).toHaveBeenCalledTimes(1);
  });

  it("shutdown stops recovery without clearing the persisted target", async () => {
    const svc = new VoiceService();
    svc.beginShutdown();
    const guild = makeGuild();
    svc.joinPresence(guild, "c-1");
    const conn = lastConnection();
    await svc.handleDrop(guild, "c-1", conn as unknown as VoiceConnection);
    expect(conn.destroyed).toBe(false);
    expect(mocks.joinVoiceChannel).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.guildSettings.updateMany).not.toHaveBeenCalled();
    expect(svc.isDesired("g-1", "c-1")).toBe(true);
  });

  it("clears state when the parked channel is gone", async () => {
    const svc = new VoiceService();
    const guild = makeGuild("g-1", new Map());
    svc.joinPresence(guild, "c-1");
    const conn = lastConnection();
    await svc.handleDrop(guild, "c-1", conn as unknown as VoiceConnection);
    expect(mocks.joinVoiceChannel).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.guildSettings.updateMany).toHaveBeenCalledWith(clearCall);
  });

  it("clears state when the bot lacks Connect permission to rejoin", async () => {
    const svc = new VoiceService();
    const guild = makeGuild("g-1", new Map([["c-1", makeChannel("c-1", false)]]));
    svc.joinPresence(guild, "c-1");
    const conn = lastConnection();
    await svc.handleDrop(guild, "c-1", conn as unknown as VoiceConnection);
    expect(mocks.joinVoiceChannel).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.guildSettings.updateMany).toHaveBeenCalledWith(clearCall);
  });

  it("stops retrying after MAX_REJOIN_ATTEMPTS and clears state", async () => {
    const svc = new VoiceService();
    const guild = makeGuild("g-1", new Map([["c-1", makeChannel("c-1")]]));
    svc.joinPresence(guild, "c-1");
    for (let i = 0; i < 3; i++) {
      await svc.handleDrop(guild, "c-1", new FakeConnection() as unknown as VoiceConnection);
    }
    // initial join + 2 successful rejoins, then the third failure clears state
    expect(mocks.joinVoiceChannel).toHaveBeenCalledTimes(3);
    expect(mocks.prisma.guildSettings.updateMany).toHaveBeenCalledWith(clearCall);
  });
});

describe("VoiceService — channel deletion", () => {
  it("clears state and destroys the connection when the parked channel is deleted", async () => {
    const svc = new VoiceService();
    const guild = makeGuild();
    svc.joinPresence(guild, "c-1");
    const conn = lastConnection();
    mocks.getVoiceConnection.mockReturnValue(conn);
    await svc.onChannelDeleted("g-1", "c-1");
    expect(conn.destroyed).toBe(true);
    expect(svc.isDesired("g-1", "c-1")).toBe(false);
    expect(mocks.prisma.guildSettings.updateMany).toHaveBeenCalledWith(clearCall);
  });

  it("ignores deletion of a channel it is not parked in", async () => {
    const svc = new VoiceService();
    await svc.onChannelDeleted("g-1", "c-other");
    expect(mocks.getVoiceConnection).not.toHaveBeenCalled();
    expect(mocks.prisma.guildSettings.updateMany).not.toHaveBeenCalled();
  });
});

describe("VoiceService — startup rejoin", () => {
  it("rejoins persisted targets whose channel exists and is joinable", async () => {
    mocks.prisma.guildSettings.findMany.mockResolvedValue([{ guildId: "g-1", voiceChannelId: "c-1" }]);
    const guild = makeGuild("g-1", new Map([["c-1", makeChannel("c-1")]]));
    const svc = new VoiceService();
    const count = await svc.rejoinPersisted(makeClient(new Map([["g-1", guild]])));
    expect(count).toBe(1);
    expect(mocks.joinVoiceChannel).toHaveBeenCalledWith(expect.objectContaining({ channelId: "c-1", guildId: "g-1" }));
    expect(svc.isDesired("g-1", "c-1")).toBe(true);
  });

  it("clears a persisted target whose guild is not present", async () => {
    mocks.prisma.guildSettings.findMany.mockResolvedValue([{ guildId: "g-1", voiceChannelId: "c-1" }]);
    const svc = new VoiceService();
    await expect(svc.rejoinPersisted(makeClient(new Map()))).resolves.toBe(0);
    expect(mocks.joinVoiceChannel).not.toHaveBeenCalled();
    expect(mocks.prisma.guildSettings.updateMany).toHaveBeenCalledWith(clearCall);
  });

  it("clears a persisted target whose channel is gone", async () => {
    mocks.prisma.guildSettings.findMany.mockResolvedValue([{ guildId: "g-1", voiceChannelId: "c-1" }]);
    const svc = new VoiceService();
    const guild = makeGuild("g-1", new Map());
    await svc.rejoinPersisted(makeClient(new Map([["g-1", guild]])));
    expect(mocks.joinVoiceChannel).not.toHaveBeenCalled();
    expect(mocks.prisma.guildSettings.updateMany).toHaveBeenCalledWith(clearCall);
  });

  it("clears a persisted target when the bot lacks Connect permission", async () => {
    mocks.prisma.guildSettings.findMany.mockResolvedValue([{ guildId: "g-1", voiceChannelId: "c-1" }]);
    const guild = makeGuild("g-1", new Map([["c-1", makeChannel("c-1", false)]]));
    const svc = new VoiceService();
    await svc.rejoinPersisted(makeClient(new Map([["g-1", guild]])));
    expect(mocks.joinVoiceChannel).not.toHaveBeenCalled();
    expect(mocks.prisma.guildSettings.updateMany).toHaveBeenCalledWith(clearCall);
  });

  it("clears a persisted target in a non-allowlisted guild", async () => {
    mocks.allowedGuildIds.add("g-1");
    mocks.isGuildAllowed.mockReturnValue(false);
    mocks.prisma.guildSettings.findMany.mockResolvedValue([{ guildId: "g-1", voiceChannelId: "c-1" }]);
    const guild = makeGuild("g-1", new Map([["c-1", makeChannel("c-1")]]));
    const svc = new VoiceService();
    await svc.rejoinPersisted(makeClient(new Map([["g-1", guild]])));
    expect(mocks.joinVoiceChannel).not.toHaveBeenCalled();
    expect(mocks.prisma.guildSettings.updateMany).toHaveBeenCalledWith(clearCall);
  });
});

describe("VoiceService — diagnostics", () => {
  it("logs the dependency report only once", () => {
    const svc = new VoiceService();
    svc.logDependencyReport();
    svc.logDependencyReport();
    expect(mocks.generateDependencyReport).toHaveBeenCalledTimes(1);
  });

  it("a failing dependency report is non-fatal", () => {
    mocks.generateDependencyReport.mockImplementation(() => {
      throw new Error("boom");
    });
    const svc = new VoiceService();
    expect(() => svc.logDependencyReport()).not.toThrow();
  });
});
