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
  isOAuthConfigured: vi.fn(() => true),
  buildAuthorizeUrl: vi.fn(() => "https://apis.roblox.com/oauth/v1/authorize?state=x"),
  syncMemberships: vi.fn(async () => undefined),
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
vi.mock("../src/services/RobloxOAuthService.js", () => ({
  isOAuthVerificationConfigured: mocks.isOAuthConfigured,
  buildAuthorizeUrl: mocks.buildAuthorizeUrl,
}));
vi.mock("../src/services/EligibilityService.js", () => ({ syncMemberships: mocks.syncMemberships }));
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
    showModal: vi.fn(async () => undefined),
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
    // Code method: eligibility tracking starts at the verification moment.
    expect(mocks.syncMemberships).toHaveBeenCalledWith("202", "g-1");
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

describe("openStartModal — OAuth-first verify menu", () => {
  it("offers the login-first menu when OAuth is configured", async () => {
    mocks.isOAuthConfigured.mockReturnValue(true);
    const ctx = buttonCtx();

    await VerificationService.openStartModal(ctx);

    const payload = (ctx.interaction.reply as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      ephemeral: boolean;
      components: { toJSON: () => unknown }[];
    };
    expect(payload.ephemeral).toBe(true);
    const json = JSON.stringify(payload.components.map((row) => row.toJSON()));
    expect(json).toContain("Log in with Roblox");
    expect(json).toContain("Use Verification Code");
    expect(json).toContain("verify:code");
    expect(mocks.buildAuthorizeUrl).toHaveBeenCalledWith("u1", "g-1");
    expect((ctx.interaction as unknown as { showModal: ReturnType<typeof vi.fn> }).showModal).not.toHaveBeenCalled();
  });

  it("falls back to the legacy code modal when OAuth is not configured", async () => {
    mocks.isOAuthConfigured.mockReturnValue(false);
    const ctx = buttonCtx();

    await VerificationService.openStartModal(ctx);

    expect((ctx.interaction as unknown as { showModal: ReturnType<typeof vi.fn> }).showModal).toHaveBeenCalled();
    expect(ctx.interaction.reply).not.toHaveBeenCalled();
  });

  it("the secondary code button opens the profile-code modal", async () => {
    mocks.isOAuthConfigured.mockReturnValue(true);
    const ctx = buttonCtx();

    await VerificationService.openCodeModal(ctx);

    expect((ctx.interaction as unknown as { showModal: ReturnType<typeof vi.fn> }).showModal).toHaveBeenCalled();
  });
});
