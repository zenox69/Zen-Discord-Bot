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
    audit: vi.fn(),
  };
});

vi.mock("../src/database/prisma.js", () => ({ prisma: mocks.prisma }));
vi.mock("../src/services/RobloxService.js", () => ({ roblox: { getGroupRoles: mocks.getGroupRoles } }));
vi.mock("../src/services/AuditService.js", () => ({ audit: mocks.audit }));

import { syncMemberships } from "../src/services/EligibilityService.js";

function makeCommunity(leavePolicy: string = "KEEP_ORIGINAL"): RobloxCommunity {
  return {
    id: 20,
    guildId: "g-1",
    robloxGroupId: "123",
    name: "Community A",
    requiredDays: 7,
    leavePolicy,
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

describe("syncMemberships", () => {
  it("creates a new membership with an honest FIRST_SEEN date", async () => {
    mocks.prisma.robloxCommunity.findMany.mockResolvedValue([makeCommunity()]);
    mocks.getGroupRoles.mockResolvedValue(rolePayload(true));
    mocks.prisma.communityMembership.findUnique.mockResolvedValue(null);

    await syncMemberships("202", "g-1");

    expect(mocks.prisma.communityMembership.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ membershipDateSource: "FIRST_SEEN", isCurrentlyMember: true }),
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MEMBERSHIP_DETECTED" }),
    );
  });

  it("does nothing for non-members without an existing row", async () => {
    mocks.prisma.robloxCommunity.findMany.mockResolvedValue([makeCommunity()]);
    mocks.getGroupRoles.mockResolvedValue(rolePayload(false));
    mocks.prisma.communityMembership.findUnique.mockResolvedValue(null);

    await syncMemberships("202", "g-1");

    expect(mocks.prisma.communityMembership.create).not.toHaveBeenCalled();
  });

  it("records MEMBERSHIP_LOST when a member leaves", async () => {
    mocks.prisma.robloxCommunity.findMany.mockResolvedValue([makeCommunity()]);
    mocks.getGroupRoles.mockResolvedValue(rolePayload(false));
    mocks.prisma.communityMembership.findUnique.mockResolvedValue(makeMembership());

    await syncMemberships("202", "g-1");

    expect(mocks.prisma.communityMembership.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: expect.objectContaining({ isCurrentlyMember: false }),
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MEMBERSHIP_LOST" }),
    );
  });

  it("refreshes role info on a no-change sync", async () => {
    mocks.prisma.robloxCommunity.findMany.mockResolvedValue([makeCommunity()]);
    mocks.getGroupRoles.mockResolvedValue(rolePayload(true));
    mocks.prisma.communityMembership.findUnique.mockResolvedValue(makeMembership());

    await syncMemberships("202", "g-1");

    expect(mocks.prisma.communityMembership.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: expect.objectContaining({ isCurrentlyMember: true, roleName: "Member" }),
    });
  });

  it("restarts the membership spell on rejoin under RESET_ON_LEAVE", async () => {
    mocks.prisma.robloxCommunity.findMany.mockResolvedValue([makeCommunity("RESET_ON_LEAVE")]);
    mocks.getGroupRoles.mockResolvedValue(rolePayload(true));
    mocks.prisma.communityMembership.findUnique.mockResolvedValue(
      makeMembership({ isCurrentlyMember: false, leftAt: new Date("2026-08-01T00:00:00.000Z") }),
    );

    await syncMemberships("202", "g-1");

    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MEMBERSHIP_RESTARTED" }),
    );
  });
});
