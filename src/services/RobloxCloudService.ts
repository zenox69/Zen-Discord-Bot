import { env } from "../config/env.js";
import { RobloxApiError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

/**
 * RobloxCloudService — Open Cloud API access (apis.roblox.com) using the
 * developer's API key. Separate from RobloxService (public RoProxy data):
 * the API key is a secret and must NEVER be sent through a third-party
 * mirror — Open Cloud is always called directly over HTTPS.
 *
 * Guarantees:
 *  - timeout on every request (AbortController)
 *  - one retry for network/timeout/429/5xx with short backoff
 *  - serialized requests with the same pacing philosophy as RoProxy so the
 *    two services combined never burst upstream
 *  - RobloxApiError on failure — callers must degrade honestly (fall back
 *    to FIRST_SEEN), never fabricate a join date.
 *
 * Currently used for: official group-membership join dates (GroupMembership
 * createTime) — turning the FIRST_SEEN approximation into OFFICIAL_API data.
 */

const CLOUD_BASE = "https://apis.roblox.com";

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

async function fetchJson<T>(label: string, url: string, init?: RequestInit): Promise<T> {
  const apiKey = env.ROBLOX_API_KEY;
  if (!apiKey) throw new RobloxApiError("network", label, "ROBLOX_API_KEY is not configured");

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    await waitForRequestSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.ROBLOX_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: { "x-api-key": apiKey, ...(init?.headers ?? {}) },
      });
      if (!res.ok) {
        let detail = "";
        try {
          const body = (await res.json()) as { message?: unknown };
          if (typeof body.message === "string") detail = body.message;
        } catch {
          /* non-JSON error body */
        }
        const err = new RobloxApiError("http", url, `HTTP ${res.status}${detail ? ` — ${detail}` : ""}`, res.status);
        if ((res.status === 429 || res.status >= 500) && attempt === 0) {
          lastErr = err;
          await sleep(600);
          continue;
        }
        throw err;
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof RobloxApiError) throw err;
      if (attempt === 0) {
        lastErr = err;
        await sleep(600);
        continue;
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new RobloxApiError("timeout", url, `Timed out after ${env.ROBLOX_REQUEST_TIMEOUT_MS}ms`);
      }
      throw new RobloxApiError("network", url, err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof RobloxApiError
    ? lastErr
    : new RobloxApiError("network", url, lastErr instanceof Error ? lastErr.message : String(lastErr));
}

export interface GroupMembershipInfo {
  /** Official time the membership was created (join date for this spell). */
  createTime: Date | null;
}

/**
 * Official membership info for one (group, user) pair.
 * Returns null when the user is not a member. Throws RobloxApiError on
 * infrastructure failure — callers degrade to FIRST_SEEN, never invent data.
 */
export async function getGroupMembership(groupId: string, userId: string): Promise<GroupMembershipInfo | null> {
  const filter = `user == 'users/${userId}'`;
  const url =
    `${CLOUD_BASE}/cloud/v2/groups/${encodeURIComponent(groupId)}/memberships` +
    `?maxPageSize=1&filter=${encodeURIComponent(filter)}`;
  const json = await fetchJson(`groupMembership:${groupId}:${userId}`, url);
  const list = (json as { groupMemberships?: unknown }).groupMemberships;
  if (!Array.isArray(list) || list.length === 0) return null;
  const first = list[0] as { createTime?: unknown } | undefined;
  if (!first || typeof first.createTime !== "string") {
    log.warn(`Open Cloud membership for group ${groupId} user ${userId} had no createTime`);
    return { createTime: null };
  }
  const createTime = new Date(first.createTime);
  if (Number.isNaN(createTime.getTime())) {
    log.warn(`Open Cloud membership createTime was invalid for group ${groupId} user ${userId}`);
    return { createTime: null };
  }
  return { createTime };
}

export const robloxCloud = {
  getGroupMembership,
};
