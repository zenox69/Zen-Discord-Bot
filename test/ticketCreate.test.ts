import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Guild, GuildMember } from "discord.js";
const mocks = vi.hoisted(() => ({ settings: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), createChannel: vi.fn(), deleteChannel: vi.fn(), send: vi.fn(), event: vi.fn(), audit: vi.fn() }));
vi.mock("../src/services/GuildSettingsService.js", () => ({ findSettings: mocks.settings }));
vi.mock("../src/services/AuditService.js", () => ({ audit: mocks.audit }));
vi.mock("../src/utils/botClient.js", () => ({ getBotClient: () => ({ user: { id: "bot", username: "Zen" } }) }));
vi.mock("../src/database/prisma.js", () => ({ prisma: { ticket: { findFirst: mocks.findFirst, create: mocks.create, update: mocks.update }, guildSettings: { update: async () => ({ ticketCounter: 1 }) }, ticketEvent: { create: mocks.event } } }));
import { createTicket } from "../src/services/TicketService.js";
const guild = { roles: { everyone: { id: "g1" } }, channels: { create: mocks.createChannel } } as unknown as Guild;
const member = { id: "u1", user: { username: "customer" } } as GuildMember;
const params = { guild, guildId: "g1", member, type: "ORDER" as const };
beforeEach(() => {
  vi.resetAllMocks(); mocks.settings.mockResolvedValue({ ticketCategoryId: "category", enabled: true });
  mocks.findFirst.mockResolvedValue(null); mocks.create.mockResolvedValue({ id: 1, channelId: "c1" });
  mocks.createChannel.mockResolvedValue({ id: "c1", delete: mocks.deleteChannel, send: mocks.send }); mocks.send.mockResolvedValue({ id: "msg" });
  mocks.deleteChannel.mockResolvedValue(undefined);
});
describe("ticket creation", () => {
  it("prevents repeated concurrent clicks from creating two channels", async () => {
    const first = createTicket(params);
    await expect(createTicket(params)).rejects.toMatchObject({ code: "WORKFLOW_BUSY" });
    await first; expect(mocks.createChannel).toHaveBeenCalledTimes(1); expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it("searches for duplicate tickets by type as well as user and guild", async () => {
    mocks.findFirst.mockResolvedValue({ type: "ORDER", channelName: "existing" });
    await expect(createTicket(params)).rejects.toMatchObject({ code: "TICKET_ALREADY_OPEN" });
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { guildId: "g1", discordUserId: "u1", type: "ORDER", status: "OPEN" } }); expect(mocks.createChannel).not.toHaveBeenCalled();
  });
  it("compensates new channel creation on DB failure and releases the guard", async () => {
    mocks.create.mockRejectedValueOnce(new Error("DB failed"));
    await expect(createTicket(params)).rejects.toThrow("DB failed"); expect(mocks.deleteChannel).toHaveBeenCalledTimes(1);
    await expect(createTicket(params)).resolves.toMatchObject({ id: 1 });
  });
});
