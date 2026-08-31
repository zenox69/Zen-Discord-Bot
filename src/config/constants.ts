/**
 * Central, typed constants: custom-id grammar, cache TTLs, rate limits,
 * and shared UI rules. No hard-coded guild/channel/role IDs live anywhere.
 */

export const CUSTOM_ID_PREFIX = {
  verify: "verify",
  roblox: "roblox",
  eligible: "eligible",
  ticket: "ticket",
  order: "order",
  customer: "customer",
  panel: "panel",
  setup: "setup",
} as const;

export type CustomIdPrefix = (typeof CUSTOM_ID_PREFIX)[keyof typeof CUSTOM_ID_PREFIX];

/** Build a structured custom id: cid("order", "claim", orderId) -> "order:claim:123" */
export function cid(prefix: string, action: string, ...parts: Array<string | number>): string {
  return [prefix, action, ...parts.map(String)].join(":");
}

export interface ParsedCustomId {
  prefix: string;
  action: string;
  parts: string[];
}

export function parseCustomId(customId: string): ParsedCustomId {
  const [prefix, action, ...parts] = customId.split(":");
  return { prefix: prefix ?? "", action: action ?? "", parts };
}

/** In-memory cache TTLs for RoProxy responses. DB remains source of truth. */
export const ROBLOX_CACHE_TTL_MS = {
  username: 30 * 60_000, // 30 min
  profile: 10 * 60_000, // 10 min
  groups: 2 * 60_000, // 2 min
  avatar: 45 * 60_000, // 45 min
} as const;

/** Verification challenge lifetime. */
export const VERIFY_TTL_MS = 15 * 60_000;

/** Centralized per-user rate limits (keyed by rateLimiter). */
export const LIMITS = {
  eligibleCommand: { limit: 3, windowMs: 60_000 },
  profileCommand: { limit: 5, windowMs: 60_000 },
  verifyStart: { limit: 1, windowMs: 10_000 },
  verifyCheck: { limit: 1, windowMs: 10_000 },
  eligibleRefresh: { limit: 1, windowMs: 60_000 },
  ticketCreate: { limit: 1, windowMs: 30_000 },
  orderSubmit: { limit: 1, windowMs: 5_000 },
} as const;

/** Max communities shown per /eligible embed page before pagination kicks in. */
export const ELIGIBILITY_PAGE_SIZE = 8;

/** Closed ticket channels are deleted after this delay (ms). */
export const TICKET_DELETE_DELAY_MS = 60_000;

/** Discord channel names are limited to 100; ticket slugs are kept short. */
export const TICKET_SLUG_MAX = 20;
