import { ActivityType, type Client } from "discord.js";
import { log } from "../utils/logger.js";
import { startJobs } from "../jobs/index.js";

export function onReady(client: Client): void {
  if (!client.user) return;
  client.user.setPresence({
    activities: [{ name: "Marketplace | /setup", type: ActivityType.Watching }],
    status: "online",
  });
  startJobs(client);
  log.info(`Logged in as ${client.user.tag} — serving ${client.guilds.cache.size} guild(s).`);
}
