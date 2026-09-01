import { ROBLOX_CACHE_TTL_MS } from "../config/constants.js";
import { env } from "../config/env.js";
import type { GroupRole, RobloxProfile, RobloxUserRef } from "../types/roblox.js";
import { RobloxApiError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

/**
 * RobloxService — the single gateway for all public Roblox data, served via
 * the RoProxy mirror.
 *
 * Guarantees:
 *  - every request has a timeout (AbortController)
 *  - retries with exponential backoff for network/timeout/429/5xx only
 *  - status-code checking + JSON shape validation
 *  - in-memory TTL caching (username 30m, profile 10m, groups 2m, avatar 45m)
 *  - RobloxApiError is thrown on infrastructure failure. Callers must NEVER
 *    treat that as "not a member" — it is a distinct, unknown state.
 *
 * This service only ever performs PUBLIC lookups. It never sends, stores, or
 * logs Roblox credentials of any kind.
 */

const USERS_BASE = "https://users.roproxy.com";
const GROUPS_BASE = "https://groups.roproxy.com";
const THUMBNAILS_BASE = "https://thumbnails.roproxy.com";

class TtlCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    if (this.entries.size > 5000) this.evictExpired();
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now > entry.expiresAt) this.entries.delete(key);
    }
  }
}

const usernameCache = new TtlCache<RobloxUserRef | null>();
const profileCache = new TtlCache<RobloxProfile | null>();
const groupsCache = new TtlCache<GroupRole[]>();
const avatarCache = new TtlCache<string>();

// Serialize outbound calls with a small gap so slash commands and background
// jobs cannot burst RoProxy even when their caches miss at the same time.
const REQUEST_GAP_MS = 250;
let lastRequestAt = 0;
let requestQueue: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRequestSlot(): Promise<void> {
  const slot = requestQueue.then(async () => {
    const waitMs = Math.max(0, lastRequestAt + REQUEST_GAP_MS - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    lastRequestAt = Date.now();
  });
  requestQueue = slot.catch(() => undefined);
  await slot;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  await waitForRequestSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.ROBLOX_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new RobloxApiError("timeout", url, `Timed out after ${env.ROBLOX_REQUEST_TIMEOUT_MS}ms`);
    }
    throw new RobloxApiError("network", url, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: unknown; message?: unknown };
      detail =
        typeof body.error === "string"
          ? body.error
          : typeof body.message === "string"
            ? body.message
            : "";
    } catch {
      /* non-JSON error body */
    }
    throw new RobloxApiError("http", url, `HTTP ${res.status}${detail ? ` — ${detail}` : ""}`, res.status);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new RobloxApiError("invalid", url, "Response was not valid JSON");
  }
  return json as T;
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown = new RobloxApiError("network", label, "Request failed");
  for (let attempt = 0; attempt <= env.ROBLOX_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retriable =
        err instanceof RobloxApiError &&
        (err.kind === "network" ||
          err.kind === "timeout" ||
          (err.kind === "http" && ((err.status ?? 0) === 429 || (err.status ?? 0) >= 500)));
      if (!retriable || attempt === env.ROBLOX_MAX_RETRIES) break;
      const backoff = Math.min(8000, 400 * 2 ** attempt) + Math.floor(Math.random() * 250);
      log.warn(`Roblox request ${label} failed — retry ${attempt + 1}/${env.ROBLOX_MAX_RETRIES} in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

const USERNAME_RE = /^[A-Za-z0-9_]{2,20}$/;

// ---------------------------------------------------------------------------
// 1. Username -> user id
// ---------------------------------------------------------------------------

async function resolveUsernameOnce(rawUsername: string): Promise<RobloxUserRef | null> {
  const username = rawUsername.trim();
  if (!USERNAME_RE.test(username)) return null;
  const url = `${USERS_BASE}/v1/usernames/users`;
  const json = await withRetry(`resolveUsername:${username}`, () =>
    fetchJson<{ data?: Array<{ id?: unknown; name?: unknown; displayName?: unknown }> }>(url, {
      method: "POST",
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
    }),
  );
  if (!Array.isArray(json.data)) {
    throw new RobloxApiError("invalid", url, "Username response did not contain a data array");
  }
  const entry = json.data[0];
  if (!entry || (typeof entry.id !== "number" && typeof entry.id !== "string")) return null;
  const name = typeof entry.name === "string" ? entry.name : username;
  return {
    id: String(entry.id),
    name,
    displayName: typeof entry.displayName === "string" ? entry.displayName : name,
  };
}

/**
 * Resolve a Roblox username to its user id.
 * Returns null for unknown/invalid usernames; throws RobloxApiError on
 * infrastructure failure (429/5xx/network/timeout after retries).
 */
async function resolveUsername(rawUsername: string): Promise<RobloxUserRef | null> {
  const key = rawUsername.trim().toLowerCase();
  const cached = usernameCache.get(key);
  if (cached !== undefined) return cached;

  let result: RobloxUserRef | null;
  try {
    result = await resolveUsernameOnce(rawUsername);
  } catch (err) {
    // The public API answers 400/404 for usernames it cannot find.
    if (err instanceof RobloxApiError && ((err.status ?? 0) === 400 || (err.status ?? 0) === 404)) {
      result = null;
    } else {
      throw err;
    }
  }
  usernameCache.set(key, result, result ? ROBLOX_CACHE_TTL_MS.username : 5 * 60_000);
  return result;
}

// ---------------------------------------------------------------------------
// 2. Public profile
// ---------------------------------------------------------------------------

async function getProfileOnce(userId: string): Promise<RobloxProfile | null> {
  const url = `${USERS_BASE}/v1/users/${encodeURIComponent(userId)}`;
  const json = await withRetry(`profile:${userId}`, () => fetchJson<Record<string, unknown>>(url));
  if (!json || typeof json !== "object") {
    throw new RobloxApiError("invalid", url, "Profile response was not an object");
  }
  const id = json.id;
  const name = json.name;
  if ((typeof id !== "number" && typeof id !== "string") || typeof name !== "string") {
    throw new RobloxApiError("invalid", url, "Profile response was missing id or name");
  }
  const created = typeof json.created === "string" ? new Date(json.created) : null;
  if (!created || Number.isNaN(created.getTime())) {
    throw new RobloxApiError("invalid", url, "Profile response had an invalid created date");
  }
  return {
    id: String(id),
    name,
    displayName: typeof json.displayName === "string" ? json.displayName : name,
    description: typeof json.description === "string" ? json.description : "",
    created,
    isBanned: json.isBanned === true,
    hasVerifiedBadge: json.hasVerifiedBadge === true,
  };
}

/**
 * Public profile, or null when the account does not exist. Throws on infra failure.
 * Pass { forceRefresh: true } to bypass the TTL cache read (the fresh result is
 * still written back to the cache). Verification checks MUST use this — a user
 * who just edited their profile description must not be judged on stale data.
 */
async function getProfile(userId: string, opts?: { forceRefresh?: boolean }): Promise<RobloxProfile | null> {
  if (!opts?.forceRefresh) {
    const cached = profileCache.get(userId);
    if (cached !== undefined) return cached;
  }

  let result: RobloxProfile | null;
  try {
    result = await getProfileOnce(userId);
  } catch (err) {
    if (err instanceof RobloxApiError && (err.status ?? 0) === 404) {
      result = null;
    } else {
      throw err;
    }
  }
  profileCache.set(userId, result, ROBLOX_CACHE_TTL_MS.profile);
  return result;
}

// ---------------------------------------------------------------------------
// 3. Avatar headshot (embed thumbnail)
// ---------------------------------------------------------------------------

/** Sizes to try in order; 420x420 is preferred, 170x420-class fallback below. */
const AVATAR_SIZES = ["420x420", "170x170"] as const;

async function getAvatarOnce(userId: string): Promise<string> {
  for (const size of AVATAR_SIZES) {
    const url =
      `${THUMBNAILS_BASE}/v1/users/avatar-headshot` +
      `?userIds=${encodeURIComponent(userId)}&size=${size}&format=Png&isCircular=false`;
    try {
      const json = await withRetry(`avatar:${userId}`, () =>
        fetchJson<{ data?: Array<{ imageUrl?: unknown }> }>(url),
      );
      if (!Array.isArray(json.data)) {
        throw new RobloxApiError("invalid", url, "Avatar response did not contain a data array");
      }
      const imageUrl = json.data[0]?.imageUrl;
      if (typeof imageUrl === "string" && imageUrl.length > 0) return imageUrl;
    } catch (err) {
      // Unsupported size / missing user -> try the next size.
      if (err instanceof RobloxApiError && [400, 404, 405].includes(err.status ?? 0)) continue;
      throw err;
    }
  }
  throw new RobloxApiError("invalid", "avatar-headshot", "No avatar image URL returned");
}

async function getAvatarHeadshotUrl(userId: string): Promise<string> {
  const cached = avatarCache.get(userId);
  if (cached !== undefined) return cached;
  const url = await getAvatarOnce(userId);
  avatarCache.set(userId, url, ROBLOX_CACHE_TTL_MS.avatar);
  return url;
}

// ---------------------------------------------------------------------------
// 4. Group memberships (single call returns ALL of the user's groups)
// ---------------------------------------------------------------------------

async function getGroupRolesOnce(userId: string): Promise<GroupRole[]> {
  const url = `${GROUPS_BASE}/v1/users/${encodeURIComponent(userId)}/groups/roles`;
  const json = await withRetry(`groups:${userId}`, () =>
    fetchJson<{ data?: Array<Record<string, unknown>> }>(url),
  );
  if (!Array.isArray(json.data)) {
    throw new RobloxApiError("invalid", url, "Group membership response did not contain a data array");
  }
  const rows = json.data;
  const out: GroupRole[] = [];
  for (const row of rows) {
    // Current Roblox/RoProxy shape: { group: { id, name }, role: { id, name, rank } }
    const group = row.group as Record<string, unknown> | undefined;
    const role = row.role as Record<string, unknown> | undefined;
    if (group && (typeof group.id === "number" || typeof group.id === "string")) {
      out.push({
        groupId: String(group.id),
        groupName: typeof group.name === "string" ? group.name : "Unknown group",
        roleId: typeof role?.id === "number" ? role.id : 0,
        roleName: typeof role?.name === "string" ? role.name : "Member",
        rank: typeof role?.rank === "number" ? role.rank : 0,
      });
      continue;
    }
    // Legacy flat shape: { group_id, name, role_id, rank_name, rank }
    const groupId = row.group_id;
    if (typeof groupId !== "number" && typeof groupId !== "string") continue;
    out.push({
      groupId: String(groupId),
      groupName: typeof row.name === "string" ? row.name : "Unknown group",
      roleId: typeof row.role_id === "number" ? row.role_id : 0,
      roleName: typeof row.rank_name === "string" ? row.rank_name : "Member",
      rank: typeof row.rank === "number" ? row.rank : 0,
    });
  }
  return out;
}

/**
 * CURRENT group memberships for a Roblox user.
 * IMPORTANT: on RoProxy failure this throws RobloxApiError — callers must
 * surface "services unavailable" and must never report "not a member".
 * { forceRefresh: true } bypasses the TTL cache read (final order-submission
 * revalidation must not trust a stale membership snapshot).
 */
async function getGroupRoles(userId: string, opts?: { forceRefresh?: boolean }): Promise<GroupRole[]> {
  if (!opts?.forceRefresh) {
    const cached = groupsCache.get(userId);
    if (cached !== undefined) return cached;
  }
  const roles = await getGroupRolesOnce(userId);
  groupsCache.set(userId, roles, ROBLOX_CACHE_TTL_MS.groups);
  return roles;
}

// ---------------------------------------------------------------------------

export const roblox = {
  resolveUsername,
  getProfile,
  getAvatarHeadshotUrl,
  getGroupRoles,
  profileUrl: (userId: string): string =>
    `https://www.roblox.com/users/${encodeURIComponent(userId)}/profile`,
};
