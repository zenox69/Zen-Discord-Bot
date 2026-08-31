import { createServer, type Server } from "node:http";
import { prisma } from "./database/prisma.js";
import { getBotClient } from "./utils/botClient.js";
import { log } from "./utils/logger.js";

/**
 * Minimal HTTP health endpoint for platform health checks (Northflank etc.).
 * 200 = Discord connected AND database reachable; 503 otherwise.
 * Port comes from HEALTH_PORT (0 = disabled, e.g. local development).
 */
export function startHealthServer(port: number): Server | null {
  if (port <= 0) return null;

  const server = createServer((_req, res) => {
    if (_req.url !== "/healthz") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    void (async () => {
      let healthy = false;
      try {
        const dbOk = await Promise.race([
          prisma.$queryRaw`SELECT 1`.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
        ]);
        let discordOk = false;
        try {
          discordOk = getBotClient().isReady();
        } catch {
          discordOk = false;
        }
        healthy = dbOk && discordOk;
      } catch {
        healthy = false;
      }
      res.writeHead(healthy ? 200 : 503, { "content-type": "text/plain" });
      res.end(healthy ? "ok" : "unhealthy");
    })();
  });

  server.on("error", (err) => log.error("Health server error", err));
  server.listen(port, "0.0.0.0", () => log.info(`Health endpoint listening on :${port}/healthz`));
  return server;
}
