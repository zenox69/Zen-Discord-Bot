import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommunityMembership, RobloxCommunity } from "@prisma/client";

const mocks = vi.hoisted(() => {
  const prisma = {
    robloxCommunity: { findMany: vi.fn() },
    communityMembership: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  };
  return {
    prisma,
    // Loose on purpose — every test installs its own resolved values.
    getGroupRoles: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    getGroupMembership: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    audit: vi.fn(),
  };
});

vi.mock("../src/database/prisma.js", () => ({ prisma: mocks.prisma }));
vi.mock("../src/services/RobloxService.js", () => ({ roblox: { getGroupRoles: mocks.getGroupRoles } }));
vi.mock("../src/services/RobloxCloudService.js", () => ({ robloxCloud: { getGroupMembership: mocks.getGroupMembership } }));
vi.mock("../src/services/AuditService.js", () => ({ audit: mocks.audit }));

import { syncMemberships } from "../src/services/EligibilityService.js";

function makeCommunity(): RobloxCommunity {
  return {
    id: 20,
    guildId: "g-1",
    robloxGroupId: "123",
    name: "Community A",
    requiredDays: 7,
    leavePolicy: "KEEP_ORIGINAL",
    enabled: true,
  } as unknown as RobloxCommunity;
}

function makeMembership(overrides: Partial<CommunityMembership> = {}): CommunityMembership {
  return {
    id: 50,
    robloxUserId: "202",
    communityId: 20,
    isCurrentlyMember: true,
    membershipFirstSeenAt: new Date("2026-09-01T00:00:00.000Z"),
    membershipStartedAt: new Date("2026-09-01T00:00:00.000Z"),
    membershipDateSource: "FIRST_SEEN",
    ...overrides,
  } as unknown as CommunityMembership;
}

function rolePayload(member: boolean) {
  return member ? [{ groupId: "123", groupName: "A", roleId: 2, roleName: "Member", rank: 1 }] : [];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.communityMembership.update.mockResolvedValue(undefined);
  mocks.prisma.communityMembership.create.mockResolvedValue(undefined);
  mocks.audit.mockResolvedValue(undefined);
});

describe("syncMemberships — official join dates", () => {
  it("creates a new membership with OFFICIAL_API source when the cloud date exists", async () => {
    mocks.prisma.robloxCommunity.findMany.mockResolvedValue([makeCommunity()]);
    mocks.getGroupRoles.mockResolvedValue(rolePayload(true));
    mocks.prisma.communityMembership.findUnique.mockResolvedValue(null);
    mocks.getGroupMembership.mockResolvedValue({ createTime: new Date("2026-08-01T00:00:00.000Z") });

    await syncMemberships("202", "g-1");

    expect(mocks.prisma.communityMembership.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        membershipStartedAt: new Date("2026-08-01T00:00:00.000Z"),
        membershipDateSource: "OFFICIAL_API",
      }),
    });
  });

  it("falls back to FIRST_SEEN when the cloud lookup fails", async () => {
    mocks.prisma.robloxCommunity.findMany.mockResolvedValue([makeCommunity()]);
    mocks.getGroupRoles.mockResolvedValue(rolePayload(true));
    mocks.prisma.communityMembership.findUnique.mockResolvedValue(null);
    mocks.getGroupMembership.mockRejectedValue(new Error("cloud down"));

    await syncMemberships("202", "g-1");

    expect(mocks.prisma.communityMembership.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ membershipDateSource: "FIRST_SEEN" }),
    });
  });

  it("upgrades an existing FIRST_SEEN membership to the older OFFICIAL_API date", async () => {
    mocks.prisma.robloxCommunity.findMany.mockResolvedValue([makeCommunity()]);
    mocks.getGroupRoles.mockResolvedValue(rolePayload(true));
    const existing = makeMembership(); // FIRST_SEEN today
    mocks.prisma.communityMembership.findUnique.mockResolvedValue(existing);
    mocks.getGroupMembership.mockResolvedValue({ createTime: new Date("2026-06-15T00:00:00.000Z") });

    await syncMemberships("202", "g-1");

    expect(mocks.prisma.communityMembership.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: expect.objectContaining({
        membershipStartedAt: new Date("2026-06-15T00:00:00.000Z"),
        membershipDateSource: "OFFICIAL_API",
      }),
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MEMBERSHIP_DATE_UPGRADED" }),
    );
  });

  it("never downgrades STAFF_VERIFIED dates", async () => {
    mocks.prisma.robloxCommunity.findMany.mockResolvedValue([makeCommunity()]);
    mocks.getGroupRoles.mockResolvedValue(rolePayload(true));
    const existing = makeMembership({
      membershipStartedAt: new Date("2026-05-01T00:00:00.000Z"),
      membershipDateSource: "STAFF_VERIFIED",
    });
    mocks.prisma.communityMembership.findUnique.mockResolvedValue(existing);

    await syncMemberships("202", "g-1");

    expect(mocks.getGroupMembership).not.toHaveBeenCalled();
    const upgradeUpdates = mocks.prisma.communityMembership.update.mock.calls.filter(
      (c) => (c[0] as { data: Record<string, unknown> }).data.membershipDateSource !== undefined,
    );
    expect(upgradeUpdates).toHaveLength(0);
  });

  it("does not re-query the cloud for rows already OFFICIAL_API", async () => {
    mocks.prisma.robloxCommunity.findMany.mockResolvedValue([makeCommunity()]);
    mocks.getGroupRoles.mockResolvedValue(rolePayload(true));
    const existing = makeMembership({
      membershipStartedAt: new Date("2026-06-15T00:00:00.000Z"),
      membershipDateSource: "OFFICIAL_API",
    });
    mocks.prisma.communityMembership.findUnique.mockResolvedValue(existing);

    await syncMemberships("202", "g-1");

    expect(mocks.getGroupMembership).not.toHaveBeenCalled();
  });

  it("keeps the FIRST_SEEN row when the official date is not older", async () => {
    mocks.prisma.robloxCommunity.findMany.mockResolvedValue([makeCommunity()]);
    mocks.getGroupRoles.mockResolvedValue(rolePayload(true));
    const existing = makeMembership(); // startedAt == today (just seen)
    mocks.prisma.communityMembership.findUnique.mockResolvedValue(existing);
    mocks.getGroupMembership.mockResolvedValue({ createTime: new Date("2026-09-01T12:00:00.000Z") }); // later

    await syncMemberships("202", "g-1");

    const upgradeUpdates = mocks.prisma.communityMembership.update.mock.calls.filter(
      (c) => (c[0] as { data: Record<string, unknown> }).data.membershipDateSource !== undefined,
    );
    expect(upgradeUpdates).toHaveLength(0);
  });
});
