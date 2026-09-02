import { createServer, type Server } from "node:http";
import { prisma } from "./database/prisma.js";
import { getBotClient } from "./utils/botClient.js";
import { log } from "./utils/logger.js";
import {
  OAUTH_CALLBACK_PATH,
  handleRobloxOAuthCallback,
  isOAuthVerificationConfigured,
} from "./services/RobloxOAuthService.js";
import { env } from "./config/env.js";

/** Paths the OAuth callback accepts: the configured one, the default, and "/redirect". */
function isOAuthCallbackPath(url: string): boolean {
  const configured = (env.ROBLOX_OAUTH_CALLBACK_PATH || "").replace(/\/+$/, "");
  return [configured, OAUTH_CALLBACK_PATH, "/redirect"].some(
    (p) => p.length > 0 && (url === p || url.startsWith(`${p}?`)),
  );
}

/**
 * Minimal HTTP health endpoint for platform health checks (Northflank etc.).
 * 200 = Discord connected AND database reachable; 503 otherwise.
 * Port comes from HEALTH_PORT (0 = disabled, e.g. local development).
 * Never includes credentials, connection strings, or other internal data.
 */

const DB_CHECK_TIMEOUT_MS = 3000;

function checkDatabase(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, DB_CHECK_TIMEOUT_MS);
    void prisma
      .$queryRaw`SELECT 1`
      .then(
        () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(true);
          }
        },
        () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(false);
          }
        },
      );
  });
}

export function startHealthServer(port: number): Server | null {
  if (port <= 0) return null;

  const server = createServer((_req, res) => {
    // OAuth callback: full-page HTML result (never /healthz semantics).
    if (_req.url && isOAuthCallbackPath(_req.url)) {
      if (!isOAuthVerificationConfigured()) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const url = new URL(_req.url, "http://localhost");
      void handleRobloxOAuthCallback({
        code: url.searchParams.get("code") ?? undefined,
        state: url.searchParams.get("state") ?? undefined,
        error: url.searchParams.get("error") ?? undefined,
      })
        .then((result) => {
          res.writeHead(result.status, { "content-type": "text/html; charset=utf-8" });
          res.end(result.html);
        })
        .catch(() => {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("internal error");
        });
      return;
    }
    if (_req.url !== "/healthz") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    void (async () => {
      let healthy = false;
      try {
        let discordOk = false;
        try {
          discordOk = getBotClient().isReady();
        } catch {
          discordOk = false;
        }
        healthy = discordOk && (await checkDatabase());
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

/**
 * Await graceful close of the health server. Resolves immediately when the
 * server is disabled (null). Never rejects — shutdown must not be blocked by
 * a close failure. Idle keep-alive sockets (platform probes) are force-closed
 * so close() doesn't wait for them to time out.
 */
export function closeHealthServer(server: Server | null): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}
