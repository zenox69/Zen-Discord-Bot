import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuildMember as DjsGuildMember } from "discord.js";
import type { Order, Ticket } from "@prisma/client";

const mocks = vi.hoisted(() => {
  const tx = {
    ticket: { update: vi.fn() },
    order: { deleteMany: vi.fn(), findUnique: vi.fn() },
    ticketEvent: { create: vi.fn() },
    orderEvent: { create: vi.fn() },
  };
  return {
    tx,
    prisma: {
      order: { findFirst: vi.fn() },
      ticket: { findUnique: vi.fn() },
      $transaction: vi.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    },
    findSettings: vi.fn(async () => null),
    fetchMember: vi.fn(),
    audit: vi.fn(),
  };
});

vi.mock("../src/database/prisma.js", () => ({ prisma: mocks.prisma }));
vi.mock("../src/services/GuildSettingsService.js", () => ({ findSettings: mocks.findSettings }));
vi.mock("../src/services/AuditService.js", () => ({ audit: mocks.audit }));
vi.mock("../src/utils/botClient.js", () => ({
  getBotClient: () => ({
    guilds: {
      fetch: async () => ({
        members: { fetch: mocks.fetchMember },
        channels: { fetch: vi.fn(async () => null) },
      }),
    },
  }),
}));

import { canCloseTicket, closeTicket, getActiveOrderCloseBlocker } from "../src/services/TicketService.js";
import { ACTIVE_ORDER_STATUSES } from "../src/services/orderTransitions.js";

function makeMember(id: string, roleIds: string[] = [], administrator = false): DjsGuildMember {
  return {
    id,
    guild: { ownerId: "owner-1" },
    roles: { cache: Object.assign(roleIds.map((roleId) => ({ id: roleId })), { has: (roleId: string) => roleIds.includes(roleId) }) },
    permissions: { has: () => administrator },
  } as unknown as DjsGuildMember;
}

function makeTicket(): Ticket {
  return {
    id: 5,
    guildId: "g-1",
    discordUserId: "customer-1",
    status: "OPEN",
    channelId: "c-1",
  } as unknown as Ticket;
}

function makeOrder(status: Order["status"]): Order {
  return { id: 1, ticketId: 5, status } as unknown as Order;
}

const activeStatuses = ["SUBMITTED", "STAFF_REVIEW", "QUOTED", "AWAITING_PAYMENT", "PAID", "IN_PROGRESS", "READY"] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findSettings.mockResolvedValue(null);
});

describe("ACTIVE_ORDER_STATUSES", () => {
  it("covers exactly the post-submit, pre-terminal statuses", () => {
    expect([...ACTIVE_ORDER_STATUSES].sort()).toEqual([...activeStatuses].sort());
  });
});

describe("canCloseTicket — active order protection", () => {
  it("blocks the ticket owner while the order is active", async () => {
    for (const status of activeStatuses) {
      const ticket = makeTicket();
      mocks.prisma.order.findFirst.mockResolvedValue(makeOrder(status));
      expect(await canCloseTicket("g-1", makeMember("customer-1"), ticket), status).toBe(false);
    }
  });

  it("allows the ticket owner when the order is DRAFT, terminal, or absent", async () => {
    for (const status of ["DRAFT", "COMPLETED", "CANCELLED", "REFUNDED"] as const) {
      const ticket = makeTicket();
      mocks.prisma.order.findFirst.mockResolvedValue(makeOrder(status));
      expect(await canCloseTicket("g-1", makeMember("customer-1"), ticket), status).toBe(true);
    }
    const ticket = makeTicket();
    mocks.prisma.order.findFirst.mockResolvedValue(null);
    expect(await canCloseTicket("g-1", makeMember("customer-1"), ticket)).toBe(true);
  });

  it("uses the order included on the ticket when present (no extra query)", async () => {
    const ticket = makeTicket() as Ticket & { order?: Order | null };
    ticket.order = makeOrder("PAID");
    expect(await canCloseTicket("g-1", makeMember("customer-1"), ticket)).toBe(false);
    expect(mocks.prisma.order.findFirst).not.toHaveBeenCalled();
  });

  it("blocks normal staff on active orders but allows an administrator override", async () => {
    mocks.findSettings.mockResolvedValue({ staffRoleId: "staff-role", adminRoleId: "admin-role" } as never);
    const ticket = makeTicket();
    mocks.prisma.order.findFirst.mockResolvedValue(makeOrder("PAID"));
    expect(await canCloseTicket("g-1", makeMember("staff-1", ["staff-role"]), ticket)).toBe(false);
    expect(await canCloseTicket("g-1", makeMember("admin-1", ["admin-role"]), ticket)).toBe(true);
    expect(await canCloseTicket("g-1", makeMember("native-admin", [], true), ticket)).toBe(true);
  });
});

describe("getActiveOrderCloseBlocker", () => {
  it("explains the active-order blocker", async () => {
    mocks.prisma.order.findFirst.mockResolvedValue(makeOrder("IN_PROGRESS"));
    const blocker = await getActiveOrderCloseBlocker(makeTicket());
    expect(blocker).toContain("active order");
    expect(blocker).toContain("administrator");
  });

  it("returns null when there is no blocker", async () => {
    mocks.prisma.order.findFirst.mockResolvedValue(makeOrder("CANCELLED"));
    expect(await getActiveOrderCloseBlocker(makeTicket())).toBeNull();
    mocks.prisma.order.findFirst.mockResolvedValue(null);
    expect(await getActiveOrderCloseBlocker(makeTicket())).toBeNull();
  });
});

describe("closeTicket — authoritative active-order guard", () => {
  it("blocks normal staff before the close transaction runs", async () => {
    const ticket = makeTicket() as Ticket & { order: Order };
    ticket.order = makeOrder("IN_PROGRESS");
    mocks.prisma.ticket.findUnique.mockResolvedValue(ticket);
    mocks.findSettings.mockResolvedValue({ staffRoleId: "staff-role", adminRoleId: "admin-role" } as never);
    mocks.fetchMember.mockResolvedValue(makeMember("staff-1", ["staff-role"]));

    await expect(closeTicket({ guildId: "g-1", ticketId: 5, actorDiscordId: "staff-1" })).rejects.toMatchObject({
      code: "ORDER_ACTIVE",
    });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("closeTicket — order event foreign-key safety", () => {
  beforeEach(() => {
    mocks.prisma.ticket.findUnique.mockResolvedValue(makeTicket());
    mocks.findSettings.mockResolvedValue({ staffRoleId: "staff-role", adminRoleId: "admin-role" } as never);
    // Admin force-close path; also valid for plain DRAFT/terminal closes.
    mocks.fetchMember.mockResolvedValue(makeMember("admin-1", ["admin-role"]));
    mocks.tx.ticket.update.mockResolvedValue(undefined);
    mocks.tx.order.deleteMany.mockResolvedValue({ count: 1 });
    mocks.tx.ticketEvent.create.mockResolvedValue(undefined);
    mocks.tx.orderEvent.create.mockResolvedValue(undefined);
  });

  it("does NOT write TICKET_CLOSED for a deleted DRAFT order (FK safety)", async () => {
    // DRAFT was snapshotted, then deleted inside the transaction.
    mocks.prisma.ticket.findUnique.mockResolvedValue(
      Object.assign(makeTicket(), { order: makeOrder("DRAFT") }),
    );
    mocks.tx.order.findUnique.mockResolvedValue(null); // deleted by deleteMany

    await closeTicket({ guildId: "g-1", ticketId: 5, actorDiscordId: "admin-1", reason: "cleanup" });

    expect(mocks.tx.orderEvent.create).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ orderId: null }) }),
    );
  });

  it("writes TICKET_CLOSED only for an order that survived the close", async () => {
    mocks.prisma.ticket.findUnique.mockResolvedValue(
      Object.assign(makeTicket(), { order: makeOrder("CANCELLED") }),
    );
    mocks.tx.order.findUnique.mockResolvedValue({ id: 1 });

    await closeTicket({ guildId: "g-1", ticketId: 5, actorDiscordId: "admin-1" });

    expect(mocks.tx.orderEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ orderId: 1, type: "TICKET_CLOSED" }) }),
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ orderId: 1 }) }),
    );
  });
});
