import cron, { type ScheduledTask } from "node-cron";
import type { Client } from "discord.js";
import { env } from "../config/env.js";
import { log } from "../utils/logger.js";
import { notifyNewlyEligible } from "./eligibilityNotifier.js";
import { refreshTrackedMemberships } from "./membershipRefresh.js";
import { recoverTicketChannels } from "./ticketRecovery.js";
import { sweepExpiredVerifications } from "./verificationSweeper.js";

const tasks: ScheduledTask[] = [];
let started = false;

function guarded(name: string, job: () => Promise<void>): () => void {
  let running = false;
  return () => {
    if (running) {
      log.warn(`Skipping overlapping ${name} job.`);
      return;
    }
    running = true;
    void job()
      .catch((error) => log.error(`${name} job failed`, error))
      .finally(() => {
        running = false;
      });
  };
}

function schedule(expression: string, name: string, job: () => Promise<void>): void {
  if (!cron.validate(expression)) throw new Error(`Invalid ${name} cron expression: ${expression}`);
  tasks.push(cron.schedule(expression, guarded(name, job)));
}

export function startJobs(client: Client): void {
  if (started) return;
  started = true;
  schedule(env.CRON_VERIFICATION_SWEEPER, "verification sweeper", sweepExpiredVerifications);
  schedule(env.CRON_MEMBERSHIP_REFRESH, "membership refresh", refreshTrackedMemberships);
  schedule(env.CRON_ELIGIBILITY_NOTIFIER, "eligibility notifier", () =>
    notifyNewlyEligible(client),
  );
  schedule("* * * * *", "ticket recovery", () => recoverTicketChannels(client));

  void sweepExpiredVerifications().catch((error) =>
    log.error("Initial verification sweep failed", error),
  );
  void recoverTicketChannels(client).catch((error) =>
    log.error("Initial ticket recovery failed", error),
  );
  log.info(`Started ${tasks.length} scheduled background jobs.`);
}

export function stopJobs(): void {
  for (const task of tasks) task.stop();
  tasks.length = 0;
  started = false;
}
