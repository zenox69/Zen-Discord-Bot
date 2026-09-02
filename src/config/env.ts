import { z } from "zod";
import "dotenv/config";

/**
 * Environment is validated once at startup. The process refuses to boot
 * with a missing or malformed variable instead of failing mid-interaction.
 */
const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_CLIENT_ID: z.string().min(1, "DISCORD_CLIENT_ID is required"),
  GUILD_ID: z.string().optional().default(""),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  CRON_ELIGIBILITY_NOTIFIER: z.string().default("0 */6 * * *"),
  CRON_MEMBERSHIP_REFRESH: z.string().default("*/30 * * * *"),
  CRON_VERIFICATION_SWEEPER: z.string().default("*/5 * * * *"),

  ROBLOX_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(10000),
  ROBLOX_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  /**
   * Roblox OAuth 2.0 app (Creator Dashboard → User Apps). Optional — when
   * all three are set, /verify oauth offers "Login with Roblox" account
   * linking as an alternative to the profile-code challenge. The callback
   * lands on {PUBLIC_BASE_URL}/oauth/roblox/callback, which must be
   * registered as a redirect URI in the OAuth app. The access token is used
   * once (identity + the user's own group-membership join dates) and is
   * never persisted or logged.
   */
  ROBLOX_OAUTH_CLIENT_ID: z.string().trim().optional(),
  ROBLOX_OAUTH_CLIENT_SECRET: z.string().trim().optional(),
  PUBLIC_BASE_URL: z.string().trim().url().optional(),

  HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
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
