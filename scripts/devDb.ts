import EmbeddedPostgres from "embedded-postgres";
import fs from "node:fs";
import path from "node:path";

/**
 * Local development database — embedded Postgres, no admin/install needed.
 * Data lives in ./.pgdata (gitignored). Run in a separate terminal:
 *
 *   npm run db:start
 *
 * The .env DATABASE_URL (postgresql://postgres:postgres@localhost:5432/zenmarketplace)
 * points at this instance. Safe to re-run: an existing cluster is reused.
 */

const PORT = Number(process.env.DEV_DB_PORT ?? 5432);
const DATA_DIR = process.env.DEV_DB_DIR ?? "./.pgdata";

async function main(): Promise<void> {
  const pg = new EmbeddedPostgres({
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

  console.log(`[dev-db] Postgres is up on localhost:${PORT}`);
  console.log(`[dev-db] Database: zenmarketplace | user: postgres | password: postgres`);
  console.log("[dev-db] Keep this terminal open while the bot is running. Ctrl+C to stop.");
}

main().catch((err) => {
  console.error("[dev-db] Failed to start embedded Postgres:", err);
  process.exit(1);
});
