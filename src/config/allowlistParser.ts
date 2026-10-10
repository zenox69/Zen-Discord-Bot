/** Empty means unrestricted; every nonempty entry must be a Discord snowflake. */
export function parseGuildAllowlist(raw: string): Set<string> {
  if (!raw.trim()) return new Set();
  const ids = raw.split(",").map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0 || ids.some((id) => !/^[1-9]\d{16,19}$/.test(id))) {
    throw new Error("GUILD_ID must contain comma-separated Discord guild IDs");
  }
  return new Set(ids);
}
