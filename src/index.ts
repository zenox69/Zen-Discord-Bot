import { Client, GatewayIntentBits, Partials } from "discord.js";
import { onChannelDelete } from "./events/channelDelete.js";
import { onGuildCreate } from "./events/guildCreate.js";
import { onInteractionCreate } from "./events/interactionCreate.js";
import { onReady } from "./events/ready.js";
import { registerAllInteractions } from "./interactions/index.js";
import { prisma } from "./database/prisma.js";
import { env } from "./config/env.js";
import { reportError } from "./utils/errorBoundary.js";
import { log } from "./utils/logger.js";
import { setBotClient } from "./utils/botClient.js";
import { stopJobs } from "./jobs/index.js";
import { closeHealthServer, startHealthServer } from "./health.js";
import { createShutdown } from "./lifecycle.js";

/**
 * Entry point. No privileged gateway intents are required — the bot works
 * with interactions, which carry full member/role data in their payloads.
 */
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

setBotClient(client);
registerAllInteractions();

client.once("ready", () => onReady(client));
client.on("interactionCreate", (interaction) => {
  void onInteractionCreate(client, interaction);
});
client.on("guildCreate", (guild) => onGuildCreate(client, guild));
client.on("channelDelete", (channel) => onChannelDelete(client, channel));

client.on("error", (err) => log.error("Discord client error", err));
client.on("warn", (msg) => log.warn(`Discord client warning: ${msg}`));
client.on("shardDisconnect", () => log.warn("Shard disconnected — reconnecting..."));
client.on("shardReady", () => log.info("Shard ready — Discord connection (re)established."));

// Health endpoint first, so the platform can probe from the start
// (503 until Discord and the database are both ready).
const healthServer = startHealthServer(env.HEALTH_PORT);

// One guarded shutdown routine for every exit path (see lifecycle.ts).
const shutdown = createShutdown({
  stopJobs,
  closeHealth: () => closeHealthServer(healthServer),
  destroyClient: () => client.destroy(),
  disconnectDb: () => prisma.$disconnect(),
  exit: (code) => process.exit(code),
});

client.on("invalidated", () => {
  // Token was revoked/changed or the session was invalidated by Discord.
  // A restart cannot fix this; exit so the supervisor alerts the operator.
  // The gateway session is already dead, so graceful local cleanup is safe.
  log.error("Discord session invalidated — exiting for supervised restart.");
  void shutdown("invalidated", 1);
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  // All state lives in Postgres, so cleanup + supervised restart is safe.
  // Never swallow: report it (bounded so a hung webhook can't block the
  // exit), then run the graceful shutdown with failure status.
  log.error("Unhandled promise rejection — exiting for supervised restart", err);
  const deadline = new Promise<void>((resolve) => {
    setTimeout(resolve, 5000).unref();
  });
  void Promise.race([reportError(err, {}).catch(() => undefined), deadline])
    .finally(() => void shutdown("unhandledRejection", 1));
});

process.on("uncaughtException", (err) => {
  // Deliberately NOT graceful: after an uncaught exception the process state
  // may be corrupt, and async cleanup could hang or make things worse.
  // Crash fast and let the supervisor restart; all workflow state lives in
  // Postgres.
  log.error("Uncaught exception — process will exit for supervised restart", err);
  process.exit(1);
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Startup database check (non-fatal): make "database unreachable" immediately
// visible in the logs. The bot keeps running; the health endpoint reports
// 503 and the background jobs retry until the database answers.
void (async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    log.info("Database connection verified at startup.");
  } catch (err) {
    log.error(
      "Database not reachable at startup — continuing; health check will report 503 until it recovers. Check DATABASE_URL.",
      err,
    );
  }
})();

client.login(env.DISCORD_TOKEN).catch((err) => {
  log.error("Failed to log in to Discord", err);
  // Health server and Prisma may already be up — clean them up before exit.
  void shutdown("login failure", 1);
});
