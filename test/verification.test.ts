import { beforeEach, describe, expect, it, vi } from "vitest";
import { RobloxApiError } from "../src/utils/errors.js";
import type { InteractionContext } from "../src/handlers/interactionHandler.js";

const mocks = vi.hoisted(() => ({
  prisma: {
    robloxVerification: { findFirst: vi.fn(), delete: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    robloxAccount: { findUnique: vi.fn(), upsert: vi.fn() },
    $transaction: vi.fn(),
  },
  getProfile: vi.fn(),
  audit: vi.fn(),
  findSettings: vi.fn(async () => null),
  consume: vi.fn(() => ({ ok: true })),
}));

vi.mock("../src/database/prisma.js", () => ({ prisma: mocks.prisma }));
vi.mock("../src/services/RobloxService.js", () => ({
  roblox: {
    getProfile: mocks.getProfile,
    resolveUsername: vi.fn(),
    getAvatarHeadshotUrl: vi.fn(),
    profileUrl: (id: string) => `https://www.roblox.com/users/${id}/profile`,
  },
}));
vi.mock("../src/services/AuditService.js", () => ({ audit: mocks.audit }));
vi.mock("../src/services/GuildSettingsService.js", () => ({ findSettings: mocks.findSettings }));
vi.mock("../src/utils/rateLimiter.js", () => ({
  rateLimiter: { consume: mocks.consume },
  retryPhrase: (ms: number) => `Try again in ${Math.ceil(ms / 1000)}s`,
}));

import { VerificationService } from "../src/services/VerificationService.js";

function pendingVerification(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    guildId: "g-1",
    discordUserId: "u1",
    robloxUserId: "202",
    robloxUsername: "beta_user",
    code: "BW-TEST1",
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function profileWith(description: string) {
  return {
    id: "202",
    name: "beta_user",
    displayName: "Beta",
    description,
    created: new Date("2010-01-01"),
    isBanned: false,
    hasVerifiedBadge: false,
  };
}

function buttonCtx(userId = "u1"): InteractionContext {
  const interaction = {
    isButton: () => true,
    deferred: true,
    replied: false,
    guildId: "g-1",
    user: { id: userId },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
  };
  return { interaction, parts: [] } as unknown as InteractionContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.consume.mockReturnValue({ ok: true });
  mocks.findSettings.mockResolvedValue(null);
  mocks.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
    fn({ robloxAccount: { upsert: vi.fn() }, robloxVerification: { delete: vi.fn() } }),
  );
});

describe("VerificationService.check — cache freshness", () => {
  it("always fetches the profile with forceRefresh so a just-edited description is seen", async () => {
    mocks.prisma.robloxVerification.findFirst.mockResolvedValue(pendingVerification());
    mocks.getProfile.mockResolvedValue(profileWith("my bio BW-TEST1"));

    const ctx = buttonCtx();
    await VerificationService.check(ctx);

    expect(mocks.getProfile).toHaveBeenCalledWith("202", { forceRefresh: true });
    expect(mocks.prisma.$transaction).toHaveBeenCalled();
    const payload = (ctx.interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { embeds: unknown[] };
    expect(JSON.stringify(payload.embeds)).toContain("VERIFICATION SUCCESSFUL");
  });

  it("reports 'code not found' when the fresh description lacks the code", async () => {
    mocks.prisma.robloxVerification.findFirst.mockResolvedValue(pendingVerification());
    mocks.getProfile.mockResolvedValue(profileWith("no code here"));

    const ctx = buttonCtx();
    await VerificationService.check(ctx);

    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    const payload = (ctx.interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { embeds: unknown[] };
    expect(JSON.stringify(payload.embeds)).toContain("Code not found");
  });

  it("RoProxy failure propagates as RobloxApiError — never as a failed challenge", async () => {
    mocks.prisma.robloxVerification.findFirst.mockResolvedValue(pendingVerification());
    mocks.getProfile.mockRejectedValue(new RobloxApiError("network", "profile", "RoProxy down"));

    const ctx = buttonCtx();
    await expect(VerificationService.check(ctx)).rejects.toBeInstanceOf(RobloxApiError);
    expect(mocks.prisma.robloxVerification.delete).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("expired challenges are deleted and rejected before any profile fetch", async () => {
    mocks.prisma.robloxVerification.findFirst.mockResolvedValue(
      pendingVerification({ expiresAt: new Date(Date.now() - 1000) }),
    );

    await expect(VerificationService.check(buttonCtx())).rejects.toMatchObject({
      code: "VERIFICATION_EXPIRED",
    });
    expect(mocks.prisma.robloxVerification.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(mocks.getProfile).not.toHaveBeenCalled();
  });
});
