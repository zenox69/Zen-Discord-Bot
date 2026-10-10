import { z } from "zod";
import "dotenv/config";
import cron from "node-cron";
import { parseGuildAllowlist } from "./allowlistParser.js";

/**
 * Environment is validated once at startup. The process refuses to boot
 * with a missing or malformed variable instead of failing mid-interaction.
 */
const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_CLIENT_ID: z.string().min(1, "DISCORD_CLIENT_ID is required"),
  /**
   * Guild allowlist, comma-separated (e.g. "111..., 222..."). When set, ONLY
   * these servers can use the bot — the bot auto-leaves any other server.
   * Unset/empty = the bot works in any server it is added to.
   */
  GUILD_ID: z.string().trim().default("").refine((raw) => {
    try { parseGuildAllowlist(raw); return true; } catch { return false; }
  }, "Must contain comma-separated Discord guild IDs"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  CRON_ELIGIBILITY_NOTIFIER: z.string().default("0 */6 * * *").refine(cron.validate, "Invalid cron expression"),
  CRON_MEMBERSHIP_REFRESH: z.string().default("*/30 * * * *").refine(cron.validate, "Invalid cron expression"),
  CRON_VERIFICATION_SWEEPER: z.string().default("*/5 * * * *").refine(cron.validate, "Invalid cron expression"),

  ROBLOX_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(10000),
  ROBLOX_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  /**
   * Roblox OAuth 2.0 app (Creator Dashboard → User Apps). Optional — when
   * all three are set, /verify oauth offers "Login with Roblox" account
   * linking as an alternative to the profile-code challenge. The callback
   * lands on {PUBLIC_BASE_URL}/redirect by default, which must be
   * registered as a redirect URI in the OAuth app. The access token is used
   * once (identity + the user's own group-membership join dates) and is
   * never persisted or logged.
   */
  ROBLOX_OAUTH_CLIENT_ID: z.string().trim().optional(),
  ROBLOX_OAUTH_CLIENT_SECRET: z.string().trim().optional(),
  PUBLIC_BASE_URL: z.string().trim().url().optional(),
  /**
   * Path part of the OAuth callback, as registered in the Roblox app's
   * Redirect URLs (e.g. "/redirect"). Must match what PUBLIC_BASE_URL +
   * this path resolves to. Default: /redirect.
   */
  ROBLOX_OAUTH_CALLBACK_PATH: z.string().trim().refine(
    (path) => path === "" || /^\/(?!\/)[^?#\s]+$/.test(path),
    "Must be an absolute callback path without a query or fragment",
  ).optional(),

  HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
}).superRefine((values, ctx) => {
  if (!values.PUBLIC_BASE_URL) return;
  let url: URL;
  try { url = new URL(values.PUBLIC_BASE_URL); } catch { return; } // The field validator already reports invalid URLs.
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["PUBLIC_BASE_URL"], message: "Must be an HTTP(S) URL without credentials, query or fragment" });
  }
  if (values.NODE_ENV === "production" && url.protocol !== "https:") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["PUBLIC_BASE_URL"], message: "OAuth public URL must use HTTPS in production" });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configuration. Fix the following and restart:");
  for (const issue of parsed.error.issues) {
    console.error(`   • ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
