import { log } from "./utils/logger.js";

export type ShutdownDeps = {
  stopJobs: () => void;
  closeHealth: () => Promise<void>;
  destroyClient: () => void;
  disconnectDb: () => Promise<void>;
  exit: (code: number) => void;
};

const SHUTDOWN_BACKSTOP_MS = 10_000;

/**
 * Single guarded graceful-shutdown routine shared by every exit path.
 *
 * - Idempotent: concurrent fatal requests never re-run cleanup.
 * - Exit-code safe: a fatal request arriving while a graceful (code 0)
 *   shutdown is already running upgrades the final exit code, but a later
 *   benign request can never downgrade a fatal one.
 * - Each step is isolated: one failing teardown step never blocks the rest.
 * - A hard backstop exits 1 if any step hangs.
 */
export function createShutdown(deps: ShutdownDeps): (reason: string, exitCode?: number) => Promise<void> {
  let running = false;
  let exitCode = 0;

  return async function shutdown(reason: string, code = 0): Promise<void> {
    if (running) {
      if (code !== 0) exitCode = code;
      log.info(`${reason}: shutdown already in progress — waiting for it to finish.`);
      return;
    }
    running = true;
    exitCode = code;
    log.info(`${reason} received — shutting down gracefully (exit code ${exitCode})...`);

    const backstop = setTimeout(() => deps.exit(1), SHUTDOWN_BACKSTOP_MS);
    backstop.unref();

    const step = async (fn: () => unknown): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        log.warn(`Shutdown step failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    await step(deps.stopJobs);
    await step(deps.closeHealth);
    await step(deps.destroyClient);
    await step(deps.disconnectDb);

    clearTimeout(backstop);
    log.info("Shutdown complete.");
    deps.exit(exitCode);
  };
}
