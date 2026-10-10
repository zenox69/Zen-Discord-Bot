import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(), updateMany: vi.fn(), event: vi.fn(), audit: vi.fn(), fetchGuild: vi.fn(), fetchChannel: vi.fn(), deleteChannel: vi.fn(),
}));
vi.mock("../src/config/guildAllowlist.js", () => ({ isGuildAllowed: () => true }));
vi.mock("../src/database/prisma.js", () => ({ prisma: {
  ticket: { findMany: mocks.findMany, updateMany: mocks.updateMany },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ ticket: { updateMany: mocks.updateMany }, ticketEvent: { create: mocks.event } }),
} }));
vi.mock("../src/services/AuditService.js", () => ({ audit: mocks.audit }));
import { recoverTicketChannels } from "../src/jobs/ticketRecovery.js";
const client = { guilds: { fetch: mocks.fetchGuild } } as unknown as Client;
const ticket = { id: 5, guildId: "g1", channelId: "c1", channelName: "ticket", status: "OPEN", updatedAt: new Date(0), closedAt: new Date(0) };
beforeEach(() => {
  vi.resetAllMocks(); mocks.findMany.mockResolvedValue([ticket]);
  mocks.fetchGuild.mockResolvedValue({ channels: { fetch: mocks.fetchChannel } });
  mocks.fetchChannel.mockResolvedValue({ delete: mocks.deleteChannel });
  mocks.updateMany.mockResolvedValue({ count: 1 });
});
describe("ticket recovery", () => {
  it.each([403, 429, 500])("does not close or detach a channel on API failure %s", async (code) => {
    mocks.fetchChannel.mockRejectedValue({ code }); await recoverTicketChannels(client);
    expect(mocks.updateMany).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
  });
  it("does not close tickets when the guild fetch fails", async () => {
    mocks.fetchGuild.mockRejectedValue(new Error("timeout")); await recoverTicketChannels(client);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
  it("only closes confirmed missing channels and writes one event", async () => {
    mocks.fetchChannel.mockRejectedValue({ code: 10003 }); await recoverTicketChannels(client);
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: "OPEN", channelId: "c1" }), data: expect.objectContaining({ status: "CLOSED" }) }));
    expect(mocks.event).toHaveBeenCalledTimes(1);
  });
  it("keeps failed channel deletion recoverable and continues the next ticket", async () => {
    mocks.findMany.mockResolvedValue([{ ...ticket, status: "CLOSED" }, { ...ticket, id: 6, status: "CLOSED", channelId: "c2" }]);
    mocks.deleteChannel.mockRejectedValueOnce(new Error("403")).mockResolvedValueOnce(undefined);
    await recoverTicketChannels(client);
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany.mock.calls[0]![0].where.id).toBe(6);
  });
  it("does not write a duplicate recovery event after a concurrent close", async () => {
    mocks.fetchChannel.mockResolvedValue(null); mocks.updateMany.mockResolvedValue({ count: 0 });
    await recoverTicketChannels(client); expect(mocks.event).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
});
