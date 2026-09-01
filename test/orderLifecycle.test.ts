import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuildMember } from "discord.js";
import type { GuildSettings } from "@prisma/client";
import { AppError, RobloxApiError } from "../src/utils/errors.js";
import type { EligibilityEntry } from "../src/services/EligibilityService.js";
import type { FormCtx, OrderWithRelations } from "../src/services/OrderService.js";

const mocks = vi.hoisted(() => {
  const tx = {
    guildSettings: { update: vi.fn() },
    order: { updateMany: vi.fn(), update: vi.fn(), findUniqueOrThrow: vi.fn() },
    orderEvent: { create: vi.fn() },
    staffAssignment: { updateMany: vi.fn(), create: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    order: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    orderEvent: { create: vi.fn() },
    staffAssignment: { updateMany: vi.fn(), create: vi.fn() },
    guildSettings: { update: vi.fn() },
  };
  return {
    tx,
    prisma,
    audit: vi.fn(),
    findSettings: vi.fn(async () => null),
    getCommunityEligibility: vi.fn(),
    getBotClient: vi.fn(() => ({ channels: { fetch: vi.fn(async () => null) } })),
    consume: vi.fn(() => ({ ok: true })),
  };
});

vi.mock("../src/database/prisma.js", () => ({ prisma: mocks.prisma }));
vi.mock("../src/services/AuditService.js", () => ({ audit: mocks.audit }));
vi.mock("../src/services/GuildSettingsService.js", () => ({ findSettings: mocks.findSettings }));
vi.mock("../src/services/EligibilityService.js", () => ({
  getCommunityEligibility: mocks.getCommunityEligibility,
  eligibilityStatusLabel: (status: string) => status,
}));
vi.mock("../src/utils/botClient.js", () => ({ getBotClient: mocks.getBotClient }));
vi.mock("../src/utils/rateLimiter.js", () => ({
  rateLimiter: { consume: mocks.consume },
  retryPhrase: (ms: number) => `Try again in ${Math.ceil(ms / 1000)}s`,
}));

import { claimOrder, setOrderPrice, submitOrder } from "../src/services/OrderService.js";

function makeOrder(overrides: Record<string, unknown> = {}): OrderWithRelations {
  return {
    id: 1,
    guildId: "g-1",
    discordUserId: "customer-1",
    robloxUserId: "202",
    robloxUsername: "beta_user",
    status: "SUBMITTED",
    number: "0001",
    price: { toString: () => "500" },
    quantity: 1,
    assignedStaffId: null,
    orderMessageId: null,
    ticket: { id: 5, channelId: "c-1" },
    product: { id: 10, name: "Boost", requiresEligibility: true, enabled: true, minQuantity: 1, maxQuantity: null },
    community: { id: 20, name: "Community A", enabled: true, requiredDays: 7 },
    eligibilitySnapshot: null,
    ...overrides,
  } as unknown as OrderWithRelations;
}

function makeCtx(actorId: string, roleIds: string[]): FormCtx {
  const cache = Object.assign(
    roleIds.map((id) => ({ id })),
    { has: (id: string) => roleIds.includes(id) },
  );
  const member = {
    id: actorId,
    guild: { ownerId: "owner-1" },
    roles: { cache },
    permissions: { has: () => false },
  } as unknown as GuildMember;
  return {
    guildId: "g-1",
    channelId: "c-1",
    actorId,
    member,
    settings: { adminRoleId: "admin-role", staffRoleId: "staff-role" } as unknown as GuildSettings,
  };
}

const staff = makeCtx("staff-1", ["staff-role"]);
const otherStaff = makeCtx("staff-2", ["staff-role"]);
const admin = makeCtx("admin-1", ["admin-role"]);
const customer = makeCtx("customer-1", []);

function eligibleEntry(): EligibilityEntry {
  return { community: {}, membership: null, status: "ELIGIBLE", eligibleAt: null, daysRemaining: null } as EligibilityEntry;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation((fn: (t: typeof mocks.tx) => Promise<unknown>) => fn(mocks.tx));
  mocks.consume.mockReturnValue({ ok: true });
  mocks.findSettings.mockResolvedValue(null);
  mocks.getBotClient.mockReturnValue({ channels: { fetch: vi.fn(async () => null) } });
  mocks.prisma.orderEvent.create.mockResolvedValue(undefined);
  mocks.prisma.order.update.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Issue 1 — claim
// ---------------------------------------------------------------------------

describe("claimOrder", () => {
  it("claims a SUBMITTED order: status becomes STAFF_REVIEW and staff becomes assigned", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "SUBMITTED" }));
    mocks.tx.order.updateMany.mockResolvedValue({ count: 1 });

    await claimOrder(1, staff);

    expect(mocks.tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1, status: "SUBMITTED", assignedStaffId: null },
        data: { assignedStaffId: "staff-1", status: "STAFF_REVIEW" },
      }),
    );
    expect(mocks.tx.staffAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { orderId: 1, staffDiscordId: "staff-1" } }),
    );
    expect(mocks.tx.orderEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "CLAIMED", fromStatus: "SUBMITTED", toStatus: "STAFF_REVIEW" }),
      }),
    );
  });

  it("rejects non-staff", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "SUBMITTED" }));
    await expect(claimOrder(1, customer)).rejects.toMatchObject({ code: "NOT_STAFF" });
    expect(mocks.tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("rejects another staff member when already claimed", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "STAFF_REVIEW", assignedStaffId: "staff-2" }));
    await expect(claimOrder(1, staff)).rejects.toMatchObject({ code: "ALREADY_CLAIMED" });
    expect(mocks.tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("allows an admin to reassign an already-claimed order", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "STAFF_REVIEW", assignedStaffId: "staff-2" }));
    mocks.tx.order.updateMany.mockResolvedValue({ count: 1 });

    await claimOrder(1, admin);

    expect(mocks.tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { assignedStaffId: "admin-1" } }),
    );
    expect(mocks.tx.staffAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: 1, staffDiscordId: "staff-2", unassignedAt: null } }),
    );
  });

  it("rejects a double-click claim by the same staff member", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "STAFF_REVIEW", assignedStaffId: "staff-1" }));
    await expect(claimOrder(1, staff)).rejects.toMatchObject({ code: "ALREADY_CLAIMED" });
    expect(mocks.tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("rejects claims in states that do not support it", async () => {
    for (const status of ["DRAFT", "PAID", "COMPLETED", "CANCELLED"]) {
      mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status }));
      await expect(claimOrder(1, staff)).rejects.toMatchObject({ code: "BAD_TRANSITION" });
    }
  });

  it("two simultaneous claims — the loser sees count 0 and is rejected", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "SUBMITTED" }));
    mocks.tx.order.updateMany.mockResolvedValue({ count: 0 });
    await expect(claimOrder(1, otherStaff)).rejects.toMatchObject({ code: "ALREADY_CLAIMED" });
    expect(mocks.tx.staffAssignment.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Issue 4 — set price
// ---------------------------------------------------------------------------

describe("setOrderPrice", () => {
  it("rejects pricing an unclaimed SUBMITTED order (claim first)", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "SUBMITTED" }));
    await expect(setOrderPrice(1, 500, staff)).rejects.toMatchObject({
      code: "BAD_TRANSITION",
      friendly: expect.stringContaining("Claim the order first"),
    });
    expect(mocks.tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("sets price on STAFF_REVIEW and moves the order to QUOTED", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "STAFF_REVIEW", assignedStaffId: "staff-1" }));
    mocks.tx.order.updateMany.mockResolvedValue({ count: 1 });

    await setOrderPrice(1, 750, staff);

    expect(mocks.tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1, status: "STAFF_REVIEW" },
        data: { price: 750, status: "QUOTED" },
      }),
    );
    // Assignment untouched — the claiming staff member stays assigned.
    expect(mocks.tx.order.updateMany.mock.calls[0]![0].data).not.toHaveProperty("assignedStaffId");
    expect(mocks.tx.orderEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "PRICE_SET", fromStatus: "STAFF_REVIEW", toStatus: "QUOTED" }),
      }),
    );
  });

  it("allows a QUOTED -> QUOTED price adjustment, recorded with old/new price", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "QUOTED", assignedStaffId: "staff-1" }));
    mocks.tx.order.updateMany.mockResolvedValue({ count: 1 });

    await setOrderPrice(1, 900, staff);

    expect(mocks.tx.orderEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "PRICE_SET",
          fromStatus: "QUOTED",
          toStatus: "QUOTED",
          data: { oldPrice: "500", newPrice: "900" },
        }),
      }),
    );
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "PRICE_CHANGED" }));
  });

  it("rejects non-staff", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "STAFF_REVIEW" }));
    await expect(setOrderPrice(1, 500, customer)).rejects.toMatchObject({ code: "NOT_STAFF" });
  });

  it("rejects invalid states", async () => {
    for (const status of ["DRAFT", "PAID", "COMPLETED"]) {
      mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status }));
      await expect(setOrderPrice(1, 500, staff)).rejects.toMatchObject({ code: "BAD_TRANSITION" });
    }
  });

  it("duplicate/concurrent price set — count 0 is rejected", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "STAFF_REVIEW" }));
    mocks.tx.order.updateMany.mockResolvedValue({ count: 0 });
    await expect(setOrderPrice(1, 500, staff)).rejects.toMatchObject({ code: "BAD_TRANSITION" });
    expect(mocks.tx.orderEvent.create).not.toHaveBeenCalled();
  });

  it("rejects malformed prices", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "STAFF_REVIEW" }));
    await expect(setOrderPrice(1, -5, staff)).rejects.toMatchObject({ code: "INVALID_PRICE" });
    await expect(setOrderPrice(1, Number.NaN, staff)).rejects.toMatchObject({ code: "INVALID_PRICE" });
  });
});

// ---------------------------------------------------------------------------
// Issue 3 — final eligibility revalidation at submit
// ---------------------------------------------------------------------------

describe("submitOrder", () => {
  function draftOrder(overrides: Record<string, unknown> = {}) {
    return makeOrder({ status: "DRAFT", number: null, ...overrides });
  }

  it("submits when still eligible and refreshes the snapshot with forceRefresh", async () => {
    const order = draftOrder();
    mocks.prisma.order.findUnique.mockResolvedValue(order);
    mocks.getCommunityEligibility.mockResolvedValue(eligibleEntry());
    mocks.tx.guildSettings.update.mockResolvedValue({ orderCounter: 2 });
    mocks.tx.order.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.order.findUniqueOrThrow.mockResolvedValue(makeOrder({ status: "SUBMITTED", number: "0002" }));

    const result = await submitOrder(1, customer);

    expect(result).toEqual({ ok: true });
    expect(mocks.getCommunityEligibility).toHaveBeenCalledWith("g-1", "202", 20, { forceRefresh: true });
    expect(mocks.tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1, status: "DRAFT" },
        data: expect.objectContaining({
          status: "SUBMITTED",
          number: "000002",
          eligibilitySnapshot: expect.objectContaining({ status: "ELIGIBLE" }),
        }),
      }),
    );
  });

  it("user became ineligible before submit — order is NOT submitted, draft kept", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(draftOrder());
    mocks.getCommunityEligibility.mockResolvedValue({
      community: {}, membership: null, status: "NOT_ELIGIBLE", eligibleAt: null, daysRemaining: 5,
    } as EligibilityEntry);

    const result = await submitOrder(1, customer);

    expect(result).toMatchObject({ ok: false, reason: "ELIGIBILITY_CHANGED", communityName: "Community A" });
    expect((result as { detail: string }).detail).toContain("5 days remaining");
    expect(mocks.tx.order.updateMany).not.toHaveBeenCalled();
    // Snapshot refreshed for audit, but the order stays DRAFT.
    expect(mocks.prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { eligibilitySnapshot: expect.objectContaining({ status: "NOT_ELIGIBLE" }) } }),
    );
  });

  it("user left the community before submit — not submitted", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(draftOrder());
    mocks.getCommunityEligibility.mockResolvedValue({
      community: {}, membership: null, status: "NOT_MEMBER", eligibleAt: null, daysRemaining: null,
    } as EligibilityEntry);

    const result = await submitOrder(1, customer);
    expect(result).toMatchObject({ ok: false, reason: "ELIGIBILITY_CHANGED", detail: "NOT_MEMBER" });
    expect(mocks.tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("product no longer enabled — rejected before any Roblox call, draft kept", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(
      draftOrder({ product: { id: 10, name: "Boost", requiresEligibility: true, enabled: false } }),
    );
    await expect(submitOrder(1, customer)).rejects.toMatchObject({ code: "PRODUCT_GONE" });
    expect(mocks.getCommunityEligibility).not.toHaveBeenCalled();
  });

  it("community no longer enabled — rejected, draft kept", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(
      draftOrder({ community: { id: 20, name: "Community A", enabled: false, requiredDays: 7 } }),
    );
    await expect(submitOrder(1, customer)).rejects.toMatchObject({ code: "COMMUNITY_GONE" });
    expect(mocks.getCommunityEligibility).not.toHaveBeenCalled();
  });

  it("RoProxy failure is NOT treated as ineligibility — safe retry error, draft kept", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(draftOrder());
    mocks.getCommunityEligibility.mockRejectedValue(new RobloxApiError("network", "groups", "RoProxy down"));

    await expect(submitOrder(1, customer)).rejects.toMatchObject({ code: "ROBLOX_UNAVAILABLE" });
    expect(mocks.tx.order.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.order.update).not.toHaveBeenCalled();
  });

  it("duplicate submit — conditional update sees count 0 and fails", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(draftOrder());
    mocks.getCommunityEligibility.mockResolvedValue(eligibleEntry());
    mocks.tx.guildSettings.update.mockResolvedValue({ orderCounter: 3 });
    mocks.tx.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(submitOrder(1, customer)).rejects.toMatchObject({ code: "NOT_DRAFT" });
    expect(mocks.tx.orderEvent.create).not.toHaveBeenCalled();
  });

  it("product without eligibility skips the revalidation", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(
      draftOrder({ product: { id: 10, name: "Instant", requiresEligibility: false, enabled: true } }),
    );
    mocks.tx.guildSettings.update.mockResolvedValue({ orderCounter: 4 });
    mocks.tx.order.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.order.findUniqueOrThrow.mockResolvedValue(makeOrder({ status: "SUBMITTED", number: "0004" }));

    const result = await submitOrder(1, customer);

    expect(result).toEqual({ ok: true });
    expect(mocks.getCommunityEligibility).not.toHaveBeenCalled();
    expect(mocks.tx.order.updateMany.mock.calls[0]![0].data).not.toHaveProperty("eligibilitySnapshot");
  });

  it("staff cannot submit someone else's draft", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(draftOrder());
    await expect(submitOrder(1, staff)).rejects.toBeInstanceOf(AppError);
    expect(mocks.getCommunityEligibility).not.toHaveBeenCalled();
  });
});
