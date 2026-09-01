import { AuditCategory } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import { audit } from "../services/AuditService.js";
import { syncMemberships } from "../services/EligibilityService.js";
import { log } from "../utils/logger.js";

/**
 * Periodic membership refresh.
 *
 * Scaling note (reviewed deliberately): this loop is sequential ON PURPOSE.
 * RobloxService already serializes every RoProxy call through a centralized
 * 250ms request gap, so a bounded worker pool here could NOT increase
 * upstream throughput — it would only overlap database work, which is cheap.
 * A pool would add race-condition surface for no real gain at this scale.
 * Keep it sequential; if volume ever grows, raise the rate limiter's scope
 * (with upstream awareness) before parallelizing this job.
 */
export async function refreshTrackedMemberships(): Promise<void> {
  const tracked = await prisma.communityMembership.findMany({
    where: { community: { enabled: true } },
    select: { robloxUserId: true, community: { select: { guildId: true } } },
  });
  const pairs = new Map<string, { robloxUserId: string; guildId: string }>();
  for (const row of tracked) {
    const pair = { robloxUserId: row.robloxUserId, guildId: row.community.guildId };
    pairs.set(`${pair.guildId}:${pair.robloxUserId}`, pair);
  }

  let failures = 0;
  for (const pair of pairs.values()) {
    try {
      await syncMemberships(pair.robloxUserId, pair.guildId);
    } catch (error) {
      failures += 1;
      log.warn(
        `Membership refresh failed for Roblox ${pair.robloxUserId} in guild ${pair.guildId}`,
        error,
      );
      await audit({
        category: AuditCategory.SYSTEM,
        action: "MEMBERSHIP_REFRESH_FAILED",
        guildId: pair.guildId,
        details: { robloxUserId: pair.robloxUserId, error: String(error) },
      });
    }
  }
  log.info(`Membership refresh completed: ${pairs.size - failures}/${pairs.size} succeeded.`);
}
