import { AuditCategory } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import { audit } from "../services/AuditService.js";
import { log } from "../utils/logger.js";

export async function sweepExpiredVerifications(): Promise<void> {
  const expired = await prisma.robloxVerification.findMany({
    where: { expiresAt: { lt: new Date() } },
    select: { guildId: true },
  });
  if (expired.length === 0) return;

  await prisma.robloxVerification.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const counts = new Map<string, number>();
  for (const row of expired) counts.set(row.guildId, (counts.get(row.guildId) ?? 0) + 1);
  for (const [guildId, count] of counts) {
    await audit({
      category: AuditCategory.VERIFICATION,
      action: "EXPIRED_CHALLENGES_REMOVED",
      guildId,
      details: { count },
    });
  }
  log.info(`Removed ${expired.length} expired Roblox verification challenge(s).`);
}
