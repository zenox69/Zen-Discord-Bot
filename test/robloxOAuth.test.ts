import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthorizeUrl,
  consumeOAuthState,
  handleRobloxOAuthCallback,
} from "../src/services/RobloxOAuthService.js";

const mocks = vi.hoisted(() => ({
  prisma: {
    robloxAccount: { findUnique: vi.fn(), create: vi.fn() },
    robloxVerification: { deleteMany: vi.fn() },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  },
  audit: vi.fn(),
}));

vi.mock("../src/database/prisma.js", () => ({ prisma: mocks.prisma }));
vi.mock("../src/services/AuditService.js", () => ({ audit: mocks.audit }));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pendingFor(discordUserId = "u1", guildId: string | null = "g-1"): string {
  const url = buildAuthorizeUrl(discordUserId, guildId);
  return new URL(url).searchParams.get("state")!;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.prisma.$transaction.mockImplementation(async (ops: unknown[]) => ops);
  mocks.prisma.robloxAccount.findUnique.mockResolvedValue(null);
});

function stubRobloxIdentity(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/oauth/v1/token")) return jsonResponse(200, { access_token: "AT" });
      if (url.includes("/oauth/v1/userinfo")) return jsonResponse(200, { sub: "202" });
      if (url.includes("/users/")) {
        return jsonResponse(200, {
          id: 202,
          name: "beta_user",
          displayName: "Beta",
          created: "2010-01-01T00:00:00.000Z",
          isBanned: false,
        });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OAuth state handling", () => {
  it("builds an authorize URL with PKCE and the registered callback", () => {
    const url = new URL(buildAuthorizeUrl("u1", "g-1"));
    expect(url.origin + url.pathname).toBe("https://apis.roblox.com/oauth/v1/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://bot.example.com/oauth/roblox/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("state is single-use — the second consume returns null", () => {
    const state = pendingFor("u1", null);
    const first = consumeOAuthState(state);
    expect(first).toMatchObject({ discordUserId: "u1", guildId: null });
    expect(consumeOAuthState(state)).toBeNull();
  });

  it("unknown states are rejected", () => {
    expect(consumeOAuthState("not-a-state")).toBeNull();
  });
});

describe("handleRobloxOAuthCallback", () => {
  it("rejects callbacks without code/state", async () => {
    const result = await handleRobloxOAuthCallback({});
    expect(result.status).toBe(400);
    expect(result.html).toContain("Invalid request");
  });

  it("rejects unknown or reused states", async () => {
    const state = pendingFor("u1", null);
    await handleRobloxOAuthCallback({ code: "c1", state }); // consumes it
    const second = await handleRobloxOAuthCallback({ code: "c2", state });
    expect(second.status).toBe(400);
    expect(second.html).toContain("expired");
  });

  it("reports Roblox-side errors safely", async () => {
    const state = pendingFor("u1", null);
    const result = await handleRobloxOAuthCallback({ error: "access_denied", state });
    expect(result.status).toBe(400);
    expect(result.html).toContain("cancelled");
  });

  it("links the account end-to-end and returns a success page", async () => {
    const state = pendingFor("u1", "g-1");
    stubRobloxIdentity();

    const result = await handleRobloxOAuthCallback({ code: "good-code", state });
    expect(result.status).toBe(200);
    expect(result.html).toContain("verified");
    expect(result.html).toContain("@beta_user");
    expect(result.html).not.toContain("AT");
    expect(result.html).not.toContain("secret-456");
    expect(mocks.prisma.robloxAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ discordUserId: "u1", robloxUserId: "202" }),
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "OAUTH_LINKED", guildId: "g-1" }),
    );
  });

  it("refuses to relink an already-verified Discord account", async () => {
    stubRobloxIdentity();
    const state = pendingFor("u1", null);
    mocks.prisma.robloxAccount.findUnique.mockResolvedValueOnce({
      discordUserId: "u1",
      robloxUsername: "old_user",
    });
    const result = await handleRobloxOAuthCallback({ code: "code", state });
    expect(result.status).toBe(409);
    expect(result.html).toContain("Already verified");
    expect(mocks.prisma.robloxAccount.create).not.toHaveBeenCalled();
  });

  it("refuses a Roblox account already linked to someone else", async () => {
    stubRobloxIdentity();
    const state = pendingFor("u1", null);
    mocks.prisma.robloxAccount.findUnique
      .mockResolvedValueOnce(null) // no discord-side link
      .mockResolvedValueOnce({ discordUserId: "someone-else", robloxUserId: "202" }); // roblox taken

    const result = await handleRobloxOAuthCallback({ code: "code", state });
    expect(result.status).toBe(409);
    expect(result.html).toContain("already linked");
    expect(mocks.prisma.robloxAccount.create).not.toHaveBeenCalled();
  });

  it("token-exchange failure becomes a 502 page with no details leaked", async () => {
    const state = pendingFor("u1", null);
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(500, { message: "nope" })));
    const result = await handleRobloxOAuthCallback({ code: "code", state });
    expect(result.status).toBe(502);
    expect(result.html).toContain("unavailable");
    expect(result.html).not.toContain("nope");
  });
});
