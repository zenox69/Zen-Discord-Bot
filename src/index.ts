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
import { startHealthServer } from "./health.js";

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

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection:", reason);
  void reportError(reason instanceof Error ? reason : new Error(String(reason)), {});
});

process.on("uncaughtException", (err) => {
  // All workflow state lives in Postgres, so crash + supervised restart is safe.
  log.error("Uncaught exception — process will exit for supervised restart", err);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received — shutting down gracefully...`);
  stopJobs();
  client.destroy();
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

client.login(env.DISCORD_TOKEN).catch((err) => {
  log.error("Failed to log in to Discord", err);
  process.exit(1);
});

// Optional health endpoint for the hosting platform (HEALTH_PORT=0 disables).
startHealthServer(Number(process.env.HEALTH_PORT ?? 3000));
