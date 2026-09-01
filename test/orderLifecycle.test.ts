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

import {
  applyStatus,
  buildOrderStaffControls,
  cancelOrder,
  claimOrder,
  parsePriceInput,
  setOrderPrice,
  submitOrder,
} from "../src/services/OrderService.js";

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
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
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

/** Concurrency token a price modal would carry (order.updatedAt at open time). */
const ORDER_UPDATED_AT = new Date("2026-09-01T00:00:00.000Z");

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
    await expect(setOrderPrice(1, 500, staff, ORDER_UPDATED_AT)).rejects.toMatchObject({
      code: "NOT_ASSIGNED",
      friendly: expect.stringContaining("Claim the order"),
    });
    expect(mocks.tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("sets price on STAFF_REVIEW and moves the order to QUOTED (updatedAt lock)", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ status: "STAFF_REVIEW", assignedStaffId: "staff-1", updatedAt: ORDER_UPDATED_AT }),
    );
    mocks.tx.order.updateMany.mockResolvedValue({ count: 1 });

    await setOrderPrice(1, 750, staff, ORDER_UPDATED_AT);

    expect(mocks.tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 1,
          status: "STAFF_REVIEW",
          updatedAt: ORDER_UPDATED_AT,
        }),
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

    await setOrderPrice(1, 900, staff, ORDER_UPDATED_AT);

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
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "STAFF_REVIEW", assignedStaffId: "staff-1" }));
    await expect(setOrderPrice(1, 500, customer, ORDER_UPDATED_AT)).rejects.toMatchObject({ code: "NOT_STAFF" });
  });

  it("blocks a different staff member from editing a claimed order (admin can)", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "QUOTED", assignedStaffId: "staff-2" }));
    await expect(setOrderPrice(1, 500, staff, ORDER_UPDATED_AT)).rejects.toMatchObject({ code: "NOT_ASSIGNED" });
    expect(mocks.tx.order.updateMany).not.toHaveBeenCalled();

    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "QUOTED", assignedStaffId: "staff-2" }));
    mocks.tx.order.updateMany.mockResolvedValue({ count: 1 });
    await expect(setOrderPrice(1, 500, admin, ORDER_UPDATED_AT)).resolves.toBeUndefined();
    expect(mocks.tx.order.updateMany).toHaveBeenCalled();
  });

  it("rejects invalid states", async () => {
    for (const status of ["DRAFT", "PAID", "COMPLETED"]) {
      mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status, assignedStaffId: "staff-1" }));
      await expect(setOrderPrice(1, 500, staff, ORDER_UPDATED_AT)).rejects.toMatchObject({ code: "BAD_TRANSITION" });
    }
  });

  it("stale/concurrent price edit — updatedAt mismatch (count 0) is rejected with no audit", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "QUOTED", assignedStaffId: "staff-1" }));
    mocks.tx.order.updateMany.mockResolvedValue({ count: 0 });
    await expect(setOrderPrice(1, 700, staff, ORDER_UPDATED_AT)).rejects.toMatchObject({
      code: "STALE_ORDER",
      friendly: expect.stringContaining("modified by another staff member"),
    });
    expect(mocks.tx.orderEvent.create).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("rejects malformed prices", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "STAFF_REVIEW", assignedStaffId: "staff-1" }));
    await expect(setOrderPrice(1, -5, staff, ORDER_UPDATED_AT)).rejects.toMatchObject({ code: "INVALID_PRICE" });
    await expect(setOrderPrice(1, Number.NaN, staff, ORDER_UPDATED_AT)).rejects.toMatchObject({ code: "INVALID_PRICE" });
  });

  it("locks on the MODAL-OPEN updatedAt token, not the freshly fetched row", async () => {
    // Staff B changed the price after Staff A opened the modal: the row's
    // current updatedAt differs from the token captured at open time.
    const tokenAtOpen = new Date("2026-09-01T00:00:00.000Z");
    const afterStaffB = new Date("2026-09-01T00:05:00.000Z");
    mocks.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ status: "QUOTED", assignedStaffId: "staff-1", updatedAt: afterStaffB }),
    );
    mocks.tx.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(setOrderPrice(1, 700, staff, tokenAtOpen)).rejects.toMatchObject({ code: "STALE_ORDER" });
    // The where clause must use the token from the modal, not the fresh row.
    expect(mocks.tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ updatedAt: tokenAtOpen }) }),
    );
    expect(mocks.tx.orderEvent.create).not.toHaveBeenCalled();
  });

  it("a fresh modal token succeeds even though the row was re-fetched", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ status: "QUOTED", assignedStaffId: "staff-1", updatedAt: ORDER_UPDATED_AT }),
    );
    mocks.tx.order.updateMany.mockResolvedValue({ count: 1 });

    await expect(setOrderPrice(1, 650, staff, ORDER_UPDATED_AT)).resolves.toBeUndefined();
    expect(mocks.tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 1, status: "QUOTED", updatedAt: ORDER_UPDATED_AT }),
        data: { price: 650, status: "QUOTED" },
      }),
    );
  });

  it("edits the price on AWAITING_PAYMENT without changing the status", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ status: "AWAITING_PAYMENT", assignedStaffId: "staff-1" }),
    );
    mocks.tx.order.updateMany.mockResolvedValue({ count: 1 });

    await setOrderPrice(1, 1200, staff, ORDER_UPDATED_AT);

    expect(mocks.tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { price: 1200, status: "AWAITING_PAYMENT" } }),
    );
    expect(mocks.tx.orderEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "PRICE_SET", fromStatus: "AWAITING_PAYMENT", toStatus: "AWAITING_PAYMENT" }),
      }),
    );
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
        where: expect.objectContaining({ id: 1, status: "DRAFT", updatedAt: expect.anything() }),
        data: expect.objectContaining({
          status: "SUBMITTED",
          number: "000002",
          eligibilitySnapshot: expect.objectContaining({ status: "ELIGIBLE" }),
        }),
      }),
    );
  });

  it("preserves full eligibility context in the final snapshot", async () => {
    const eligibleAt = new Date("2026-08-25T00:00:00.000Z");
    const membershipStartedAt = new Date("2026-06-01T00:00:00.000Z");
    mocks.prisma.order.findUnique.mockResolvedValue(draftOrder());
    mocks.getCommunityEligibility.mockResolvedValue({
      community: { id: 20, requiredDays: 7 },
      membership: { membershipStartedAt, membershipDateSource: "FIRST_SEEN" },
      status: "ELIGIBLE",
      eligibleAt,
      daysRemaining: 0,
    } as unknown as EligibilityEntry);
    mocks.tx.guildSettings.update.mockResolvedValue({ orderCounter: 5 });
    mocks.tx.order.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.order.findUniqueOrThrow.mockResolvedValue(makeOrder({ status: "SUBMITTED", number: "0005" }));

    await submitOrder(1, customer);

    const data = mocks.tx.order.updateMany.mock.calls[0]![0].data as { eligibilitySnapshot: Record<string, unknown> };
    expect(data.eligibilitySnapshot).toEqual({
      status: "ELIGIBLE",
      eligibleAt: eligibleAt.toISOString(),
      checkedAt: expect.any(String),
      communityId: 20,
      robloxUserId: "202",
      membershipStartedAt: membershipStartedAt.toISOString(),
      membershipDateSource: "FIRST_SEEN",
      requiredDays: 7,
    });
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

// ---------------------------------------------------------------------------
// Issue 2 — AWAITING_PAYMENT is reachable
// ---------------------------------------------------------------------------

describe("applyStatus — await payment flow", () => {
  it("moves QUOTED -> AWAITING_PAYMENT", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "QUOTED", assignedStaffId: "staff-1" }));
    mocks.tx.order.updateMany.mockResolvedValue({ count: 1 });

    await applyStatus(1, "AWAITING_PAYMENT", staff);

    expect(mocks.tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 1, status: "QUOTED", updatedAt: expect.anything() }),
        data: { status: "AWAITING_PAYMENT" },
      }),
    );
    expect(mocks.tx.orderEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "AWAITING_PAYMENT", fromStatus: "QUOTED" }) }),
    );
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "STATUS_AWAITING_PAYMENT" }));
  });

  it("moves AWAITING_PAYMENT -> PAID", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "AWAITING_PAYMENT", assignedStaffId: "staff-1" }));
    mocks.tx.order.updateMany.mockResolvedValue({ count: 1 });

    await applyStatus(1, "PAID", staff);

    expect(mocks.tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "PAID" } }),
    );
  });

  it("duplicate button press — count 0 rejected with no event/audit", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "AWAITING_PAYMENT", assignedStaffId: "staff-1" }));
    mocks.tx.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(applyStatus(1, "PAID", staff)).rejects.toMatchObject({ code: "STALE_ORDER" });
    expect(mocks.tx.orderEvent.create).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("blocks a non-assigned staff member; admin override works", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "AWAITING_PAYMENT", assignedStaffId: "staff-2" }));
    await expect(applyStatus(1, "PAID", staff)).rejects.toMatchObject({ code: "NOT_ASSIGNED" });

    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "AWAITING_PAYMENT", assignedStaffId: "staff-2" }));
    mocks.tx.order.updateMany.mockResolvedValue({ count: 1 });
    await expect(applyStatus(1, "PAID", admin)).resolves.toBeUndefined();
  });

  it("assigned staff member can act", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "PAID", assignedStaffId: "staff-1" }));
    mocks.tx.order.updateMany.mockResolvedValue({ count: 1 });
    await expect(applyStatus(1, "IN_PROGRESS", staff)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue 6 — claim ownership on cancel
// ---------------------------------------------------------------------------

describe("cancelOrder ownership", () => {
  it("blocks unassigned staff from cancelling someone else's order", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "STAFF_REVIEW", assignedStaffId: null }));
    await expect(cancelOrder("1", staff, "reason")).rejects.toMatchObject({ code: "NOT_ASSIGNED" });
    expect(mocks.tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("blocks a different staff member; admin override works", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "STAFF_REVIEW", assignedStaffId: "staff-2" }));
    await expect(cancelOrder("1", staff, "reason")).rejects.toMatchObject({ code: "NOT_ASSIGNED" });

    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "STAFF_REVIEW", assignedStaffId: "staff-2" }));
    mocks.tx.order.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.order.findUniqueOrThrow.mockResolvedValue(makeOrder({ status: "CANCELLED" }));
    await expect(cancelOrder("1", admin, "reason")).resolves.toBeUndefined();
  });

  it("customer can still cancel their own order", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "SUBMITTED", assignedStaffId: "staff-2" }));
    mocks.tx.order.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.order.findUniqueOrThrow.mockResolvedValue(makeOrder({ status: "CANCELLED" }));
    await expect(cancelOrder("1", customer, "changed my mind")).resolves.toBeUndefined();
    expect(mocks.tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "SUBMITTED", updatedAt: expect.anything() }) }),
    );
  });

  it("duplicate cancel — count 0 rejected", async () => {
    mocks.prisma.order.findUnique.mockResolvedValue(makeOrder({ status: "SUBMITTED" }));
    mocks.tx.order.updateMany.mockResolvedValue({ count: 0 });
    await expect(cancelOrder("1", customer, "reason")).rejects.toMatchObject({ code: "STALE_ORDER" });
  });
});

// ---------------------------------------------------------------------------
// Issue 3 — state-aware buttons
// ---------------------------------------------------------------------------

describe("buildOrderStaffControls", () => {
  function labelsFor(status: string, assignedStaffId: string | null = "staff-1"): string[] {
    const rows = buildOrderStaffControls(makeOrder({ status, assignedStaffId }));
    const labels: string[] = [];
    for (const row of rows) {
      for (const component of row.components) {
        const data = (component as unknown as { data: { label?: string; disabled?: boolean } }).data;
        if (data.label && !data.disabled) labels.push(data.label);
      }
    }
    return labels;
  }

  it("shows only valid actions per status", () => {
    expect(labelsFor("SUBMITTED", null)).toEqual(["Claim", "Cancel", "Admin Close"]);
    expect(labelsFor("STAFF_REVIEW")).toEqual(["Set Price", "Cancel", "Admin Close"]);
    expect(labelsFor("QUOTED")).toEqual(["Edit Price", "Await Payment", "Cancel", "Admin Close"]);
    expect(labelsFor("AWAITING_PAYMENT")).toEqual(["Edit Price", "Mark Paid", "Cancel", "Admin Close"]);
    expect(labelsFor("PAID")).toEqual(["Start", "Cancel", "Admin Close"]);
    expect(labelsFor("IN_PROGRESS")).toEqual(["Ready", "Cancel", "Admin Close"]);
    expect(labelsFor("READY")).toEqual(["Complete", "Cancel", "Admin Close"]);
    expect(labelsFor("COMPLETED")).toEqual(["Close"]);
    expect(labelsFor("CANCELLED")).toEqual(["Close"]);
    expect(labelsFor("REFUNDED")).toEqual(["Close"]);
  });
});

// ---------------------------------------------------------------------------
// Issue 5 — strict price parsing
// ---------------------------------------------------------------------------

describe("parsePriceInput", () => {
  it("accepts valid plain money values", () => {
    expect(parsePriceInput("500")).toBe(500);
    expect(parsePriceInput("500.00")).toBe(500);
    expect(parsePriceInput("0")).toBe(0);
    expect(parsePriceInput("0.50")).toBe(0.5);
    expect(parsePriceInput("1250.5")).toBe(1250.5);
    expect(parsePriceInput("  750  ")).toBe(750);
  });

  it("rejects invalid input", () => {
    for (const bad of ["abc", "500abc", "₱500", "..", "1.2.3", "-", "", "  ", "NaN", "Infinity", "1e3", "-5", "12,50", "0x10"]) {
      expect(() => parsePriceInput(bad)).toThrowError(AppError);
    }
    expect(() => parsePriceInput("abc")).toThrowError(/Invalid price/);
  });

  it("caps the price at the Decimal(10,2) column limit", () => {
    expect(parsePriceInput("99999999.99")).toBe(99_999_999.99);
    for (const tooBig of ["100000000", "100000000.00", "99999999999"]) {
      expect(() => parsePriceInput(tooBig)).toThrowError(/maximum/);
    }
  });
});
