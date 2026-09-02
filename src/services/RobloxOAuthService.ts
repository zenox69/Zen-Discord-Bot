import { AuditCategory } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { prisma } from "../database/prisma.js";
import { roblox } from "./RobloxService.js";
import { getUserGroupMembership } from "./RobloxCloudService.js";
import { audit } from "./AuditService.js";
import { RobloxApiError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

/**
 * RobloxOAuthService — "Login with Roblox" account linking via the Open
 * Cloud OAuth 2.0 authorization-code flow with PKCE.
 *
 * Flow: /verify oauth → link button (authorize URL with a single-use state)
 * → user logs in on roblox.com → Roblox redirects to the public callback
 * ({PUBLIC_BASE_URL}/oauth/roblox/callback) → the health server's handler
 * below validates the state, exchanges the code, reads the userinfo
 * identity, and links the Roblox account — no profile code required.
 *
 * Security:
 *  - state is random, single-use, 15-minute TTL, bound to the Discord user
 *  - PKCE S256; client secret never leaves the server
 *  - access/refresh tokens are used once for identity and NEVER persisted
 *    or logged
 *  - all HTML output is escaped; pages contain no secrets
 */

const OAUTH_BASE = "https://apis.roblox.com/oauth";
export const OAUTH_CALLBACK_PATH = "/oauth/roblox/callback";
const STATE_TTL_MS = 15 * 60 * 1000;

export function isOAuthVerificationConfigured(): boolean {
  return Boolean(env.ROBLOX_OAUTH_CLIENT_ID && env.ROBLOX_OAUTH_CLIENT_SECRET && env.PUBLIC_BASE_URL);
}

/**
 * Roblox compares redirect_uri character-for-character with the registered
 * URLs — a trailing slash in PUBLIC_BASE_URL would silently produce
 * "https://domain//oauth/roblox/callback" and fail authorization.
 */
function callbackUrl(): string {
  const base = (env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  return `${base}${OAUTH_CALLBACK_PATH}`;
}

// ---------------------------------------------------------------------------
// In-memory pending-state store (single replica by design)
// ---------------------------------------------------------------------------

interface PendingOAuth {
  discordUserId: string;
  guildId: string | null;
  codeVerifier: string;
  expiresAt: number;
}

const pendingStates = new Map<string, PendingOAuth>();

function pruneExpiredStates(): void {
  const now = Date.now();
  for (const [key, entry] of pendingStates) {
    if (entry.expiresAt < now) pendingStates.delete(key);
  }
}

/** Create the authorize URL for this Discord user. Never throws. */
export function buildAuthorizeUrl(discordUserId: string, guildId: string | null): string {
  pruneExpiredStates();
  const state = randomBytes(24).toString("hex");
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  pendingStates.set(state, { discordUserId, guildId, codeVerifier, expiresAt: Date.now() + STATE_TTL_MS });

  const params = new URLSearchParams({
    client_id: env.ROBLOX_OAUTH_CLIENT_ID ?? "",
    redirect_uri: callbackUrl(),
    scope: "openid profile",
    response_type: "code",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${OAUTH_BASE}/v1/authorize?${params}`;
}

/** Single-use: the second consume attempt with the same state returns null. */
export function consumeOAuthState(state: string): PendingOAuth | null {
  const entry = pendingStates.get(state);
  if (!entry) return null;
  pendingStates.delete(state);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

// ---------------------------------------------------------------------------
// Token exchange + identity (direct to apis.roblox.com — never via RoProxy;
// the client secret must not touch third-party mirrors)
// ---------------------------------------------------------------------------

async function exchangeCodeForToken(code: string, codeVerifier: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.ROBLOX_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${OAUTH_BASE}/v1/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        client_id: env.ROBLOX_OAUTH_CLIENT_ID ?? "",
        client_secret: env.ROBLOX_OAUTH_CLIENT_SECRET ?? "",
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new RobloxApiError("http", "oauth/token", `HTTP ${res.status}`, res.status);
    }
    const json = (await res.json()) as { access_token?: unknown };
    if (typeof json.access_token !== "string" || json.access_token.length === 0) {
      throw new RobloxApiError("invalid", "oauth/token", "Token response had no access_token");
    }
    return json.access_token;
  } catch (err) {
    if (err instanceof RobloxApiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new RobloxApiError("timeout", "oauth/token", "Timed out exchanging the authorization code");
    }
    throw new RobloxApiError("network", "oauth/token", err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOAuthUserInfo(accessToken: string): Promise<{ sub: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.ROBLOX_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${OAUTH_BASE}/v1/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new RobloxApiError("http", "oauth/userinfo", `HTTP ${res.status}`, res.status);
    }
    const json = (await res.json()) as { sub?: unknown };
    if (typeof json.sub !== "string" || !/^\d+$/.test(json.sub)) {
      throw new RobloxApiError("invalid", "oauth/userinfo", "Userinfo response had no valid sub");
    }
    return { sub: json.sub };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Callback
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Record the OFFICIAL join date (membership createTime) for every tracked
 * community the freshly linked user belongs to. Uses the user's own access
 * token; never writes a date we could not verify, and never fails the link.
 */
async function captureOfficialJoinDates(
  accessToken: string,
  robloxUserId: string,
  guildId: string | null,
): Promise<void> {
  if (!guildId) return;
  const communities = await prisma.robloxCommunity.findMany({ where: { guildId, enabled: true } });
  for (const community of communities) {
    const membership = await getUserGroupMembership(accessToken, community.robloxGroupId, robloxUserId).catch(
      () => null,
    );
    if (!membership?.createTime) continue;

    const existing = await prisma.communityMembership.findUnique({
      where: { robloxUserId_communityId: { robloxUserId, communityId: community.id } },
    });
    if (!existing) {
      // Not yet in the sync table — record the official spell so eligibility
      // is correct from the first sync.
      await prisma.communityMembership.create({
        data: {
          robloxUserId,
          communityId: community.id,
          isCurrentlyMember: true,
          membershipFirstSeenAt: new Date(),
          membershipStartedAt: membership.createTime,
          membershipDateSource: "OFFICIAL_API",
          lastMembershipCheckAt: new Date(),
        },
      });
      await audit({
        category: AuditCategory.ELIGIBILITY,
        action: "MEMBERSHIP_DETECTED",
        guildId,
        details: {
          robloxUserId,
          community: community.name,
          membershipStartedAt: membership.createTime.toISOString(),
          source: "OFFICIAL_API",
        },
      });
      continue;
    }
    // Only ever replace an approximation with the official truth, and only
    // when it is older (createTime precedes any first-seen date).
    if (existing.membershipDateSource === "FIRST_SEEN" && membership.createTime < existing.membershipStartedAt) {
      await prisma.communityMembership.update({
        where: { id: existing.id },
        data: { membershipStartedAt: membership.createTime, membershipDateSource: "OFFICIAL_API" },
      });
      await audit({
        category: AuditCategory.ELIGIBILITY,
        action: "MEMBERSHIP_DATE_UPGRADED",
        guildId,
        details: {
          robloxUserId,
          community: community.name,
          membershipStartedAt: membership.createTime.toISOString(),
          source: "OFFICIAL_API",
        },
      });
    }
  }
}

function page(title: string, bodyHtml: string, status: number): { status: number; html: string } {
  const html = [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `<title>${escapeHtml(title)}</title>`,
    "<style>body{font-family:system-ui,sans-serif;background:#111418;color:#e8eaed;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}",
    "main{background:#1c2128;border-radius:12px;padding:32px;max-width:420px;text-align:center}h1{font-size:1.2rem}p{line-height:1.5}</style>",
    `</head><body><main><h1>${escapeHtml(title)}</h1>${bodyHtml}<p style="opacity:.6;margin-top:24px">You can close this window and return to Discord.</p></main></body></html>`,
  ].join("");
  return { status, html };
}

/**
 * Handle the OAuth redirect from Roblox. Pure input → page result: the
 * health route simply writes the returned HTML. Never throws; all failures
 * become user-safe HTML pages (details go to the log only).
 */
export async function handleRobloxOAuthCallback(query: {
  code?: string;
  state?: string;
  error?: string;
}): Promise<{ status: number; html: string }> {
  if (query.error) {
    log.warn(`Roblox OAuth callback reported error: ${query.error}`);
    return page("Verification cancelled", "<p>Roblox reported that the login was cancelled or failed. Run <code>/verify oauth</code> again.</p>", 400);
  }
  if (!query.code || !query.state) {
    return page("Invalid request", "<p>This callback URL must be opened through the Discord verification button.</p>", 400);
  }

  const pending = consumeOAuthState(query.state);
  if (!pending) {
    return page("Link expired", "<p>This verification link has expired or was already used. Run <code>/verify oauth</code> again.</p>", 400);
  }

  try {
    const accessToken = await exchangeCodeForToken(query.code, pending.codeVerifier);
    const userInfo = await fetchOAuthUserInfo(accessToken);

    // Identity from the token + public profile for ban/username truth.
    const profile = await roblox.getProfile(userInfo.sub, { forceRefresh: true });
    if (!profile) {
      return page("Account unavailable", "<p>That Roblox account no longer exists. Contact a staff member.</p>", 400);
    }
    if (profile.isBanned) {
      return page("Account banned", "<p>That Roblox account is banned and cannot be linked.</p>", 403);
    }

    const existingForDiscord = await prisma.robloxAccount.findUnique({
      where: { discordUserId: pending.discordUserId },
    });
    if (existingForDiscord) {
      return page(
        "Already verified",
        `<p>This Discord account is already verified as <strong>@${escapeHtml(existingForDiscord.robloxUsername)}</strong>. Use <code>/verify unlink</code> first to switch accounts.</p>`,
        409,
      );
    }
    const takenByOther = await prisma.robloxAccount.findUnique({ where: { robloxUserId: profile.id } });
    if (takenByOther) {
      return page("Account already linked", "<p>That Roblox account is already linked to a different Discord account.</p>", 409);
    }

    const verifiedAt = new Date();
    await prisma.$transaction([
      prisma.robloxAccount.create({
        data: {
          discordUserId: pending.discordUserId,
          robloxUserId: profile.id,
          robloxUsername: profile.name,
          robloxDisplayName: profile.displayName,
          verifiedAt,
          linkedByDiscordId: pending.discordUserId,
        },
      }),
      prisma.robloxVerification.deleteMany({ where: { discordUserId: pending.discordUserId } }),
    ]);

    // Capture OFFICIAL join dates while we still hold the user's token: the
    // Open Cloud group-membership createTime is the real join date for every
    // tracked community they belong to. Failures degrade silently — the
    // FIRST_SEEN sync remains the honest fallback.
    await captureOfficialJoinDates(accessToken, profile.id, pending.guildId).catch((err) =>
      log.warn(`Official join-date capture skipped after OAuth link: ${String(err)}`),
    );

    await audit({
      category: AuditCategory.VERIFICATION,
      action: "OAUTH_LINKED",
      guildId: pending.guildId ?? undefined,
      actorDiscordId: pending.discordUserId,
      targetDiscordId: pending.discordUserId,
      details: { robloxUserId: profile.id, robloxUsername: profile.name },
    });

    return page(
      "Roblox account verified",
      `<p><strong>${escapeHtml(profile.displayName)}</strong> (@${escapeHtml(profile.name)}) is now linked to your Discord account.</p><p>You can now remove any old verification code from your Roblox profile.</p>`,
      200,
    );
  } catch (err) {
    // Never log tokens — none are persisted here and err contains none.
    log.error("Roblox OAuth callback failed", err);
    return page(
      "Verification failed",
      "<p>Roblox services were unavailable while completing the login. Please run <code>/verify oauth</code> again in a minute.</p>",
      502,
    );
  }
}
