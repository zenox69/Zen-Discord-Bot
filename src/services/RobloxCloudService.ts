import { env } from "../config/env.js";
import { RobloxApiError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

/**
 * RobloxCloudService — Open Cloud reads (apis.roblox.com) authorized by the
 * USER'S OWN OAuth access token from "Log in with Roblox". No API key and
 * no third-party mirror: the token is used once during the OAuth callback
 * (identity + the user's own group memberships) and never persisted.
 *
 * Guarantees:
 *  - timeout on every request (AbortController)
 *  - one retry for network/timeout/429/5xx with short backoff
 *  - RobloxApiError on failure — callers must degrade honestly (fall back
 *    to FIRST_SEEN), never fabricate a join date.
 */

const CLOUD_BASE = "https://apis.roblox.com";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(label: string, url: string, accessToken: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.ROBLOX_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = new RobloxApiError("http", url, `HTTP ${res.status}`, res.status);
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
 * The logged-in user's membership in ONE group, read with their own token
 * (`GET /cloud/v2/groups/{groupId}/memberships?filter=user == 'users/{me}'`).
 * Returns null when they are not a member. The token's `group` resource
 * scope governs which groups are readable; unreadable groups surface as
 * RobloxApiError and callers degrade to FIRST_SEEN.
 */
export async function getUserGroupMembership(
  accessToken: string,
  groupId: string,
  userId: string,
): Promise<GroupMembershipInfo | null> {
  const filter = `user == 'users/${userId}'`;
  const url =
    `${CLOUD_BASE}/cloud/v2/groups/${encodeURIComponent(groupId)}/memberships` +
    `?maxPageSize=1&filter=${encodeURIComponent(filter)}`;
  const json = await fetchJson(`groupMembership:${groupId}:${userId}`, url, accessToken);
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
