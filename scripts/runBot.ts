import EmbeddedPostgres from "embedded-postgres";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

/**
 * One-command local development: `npm run bot`
 *
 * Boots the embedded Postgres (same data dir as `npm run db:start`), waits
 * until it accepts connections, then runs the bot in the same terminal.
 * Ctrl+C (or the bot exiting) tears the whole tree down — bot first,
 * Postgres second. If a Postgres is already listening on the port, it is
 * reused and only the bot is managed here.
 */

const PORT = Number(process.env.DEV_DB_PORT ?? 5432);
const DATA_DIR = process.env.DEV_DB_DIR ?? "./.pgdata";

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    setTimeout(() => done(false), 2000);
  });
}

async function main(): Promise<void> {
  let pg: EmbeddedPostgres | null = null;
  let ownsDb = false;

  if (await portOpen(PORT)) {
    console.log(`[bot] Using existing Postgres on localhost:${PORT}`);
  } else {
    pg = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      user: "postgres",
      password: "postgres",
      port: PORT,
      persistent: true,
      // Windows default locale yields WIN1252 encoding, which cannot store
      // the ₱ currency symbol the schema uses. Force UTF8 via the C locale.
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    // initdb only on first run; afterwards the cluster is simply restarted.
    if (!fs.existsSync(path.join(DATA_DIR, "PG_VERSION"))) {
      await pg.initialise();
    }
    await pg.start();
    try {
      await pg.createDatabase("zenmarketplace");
    } catch (err) {
      if (!String(err).includes("already exists")) throw err;
    }
    ownsDb = true;
    console.log(`[bot] Postgres is up on localhost:${PORT} (data: ${DATA_DIR})`);
  }

  const bot = spawn("npx", ["tsx", "watch", "src/index.ts"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    cwd: process.cwd(),
  });
  console.log("[bot] Starting bot... (Ctrl+C stops bot + database)");

  let shuttingDown = false;
  const shutdown = (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[bot] Shutting down...");
    // Kill the bot's entire process tree (cmd -> npx -> tsx -> node).
    if (bot.pid) execFile("taskkill", ["/F", "/T", "/PID", String(bot.pid)], () => undefined);
    if (ownsDb && pg) {
      pg.stop()
        .catch(() => undefined)
        .finally(() => process.exit(code));
      setTimeout(() => process.exit(code), 5000).unref();
    } else {
      setTimeout(() => process.exit(code), 500).unref();
    }
  };

  bot.on("error", (err) => {
    console.error("[bot] Failed to start the bot process:", err);
    shutdown(1);
  });
  bot.on("exit", (code) => shutdown(code ?? 0));
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}

main().catch((err) => {
  console.error("[bot] Failed to start:", err);
  process.exit(1);
});
