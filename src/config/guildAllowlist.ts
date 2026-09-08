import { env } from "./env.js";

/**
 * Guild allowlist, sourced from the GUILD_ID environment variable
 * (comma-separated). Semantics:
 *  - GUILD_ID unset/empty  → the bot works in ANY server (backwards compatible)
 *  - GUILD_ID set          → ONLY the listed servers may use the bot; the bot
 *                            auto-leaves any other server it is added to.
 */
export function parseGuildAllowlist(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^\d{17,20}$/.test(id)),
  );
}

export const allowedGuildIds = parseGuildAllowlist(env.GUILD_ID);

export function isGuildAllowed(guildId: string | null): boolean {
  if (allowedGuildIds.size === 0) return true;
  return guildId !== null && allowedGuildIds.has(guildId);
}
