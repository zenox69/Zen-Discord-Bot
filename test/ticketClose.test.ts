import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuildMember as DjsGuildMember } from "discord.js";
import type { Order, Ticket } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  prisma: {
    order: { findFirst: vi.fn() },
  },
  findSettings: vi.fn(async () => null),
}));

vi.mock("../src/database/prisma.js", () => ({ prisma: mocks.prisma }));
vi.mock("../src/services/GuildSettingsService.js", () => ({ findSettings: mocks.findSettings }));

import { canCloseTicket, getOwnerCloseBlocker } from "../src/services/TicketService.js";
import { ACTIVE_ORDER_STATUSES } from "../src/services/orderTransitions.js";

function makeMember(id: string): DjsGuildMember {
  return { id } as unknown as DjsGuildMember;
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

  it("staff can always close (they cancel the order first if needed)", async () => {
    mocks.findSettings.mockResolvedValue({ staffRoleId: "staff-role" } as never);
    const member = {
      id: "staff-1",
      guild: { ownerId: "owner-1" },
      roles: { cache: Object.assign([{ id: "staff-role" }], { has: (id: string) => id === "staff-role" }) },
      permissions: { has: () => false },
    } as unknown as DjsGuildMember;
    const ticket = makeTicket();
    mocks.prisma.order.findFirst.mockResolvedValue(makeOrder("PAID"));
    expect(await canCloseTicket("g-1", member, ticket)).toBe(true);
  });
});

describe("getOwnerCloseBlocker", () => {
  it("explains the active-order blocker", async () => {
    mocks.prisma.order.findFirst.mockResolvedValue(makeOrder("IN_PROGRESS"));
    const blocker = await getOwnerCloseBlocker(makeTicket());
    expect(blocker).toContain("active order");
  });

  it("returns null when there is no blocker", async () => {
    mocks.prisma.order.findFirst.mockResolvedValue(makeOrder("CANCELLED"));
    expect(await getOwnerCloseBlocker(makeTicket())).toBeNull();
    mocks.prisma.order.findFirst.mockResolvedValue(null);
    expect(await getOwnerCloseBlocker(makeTicket())).toBeNull();
  });
});
