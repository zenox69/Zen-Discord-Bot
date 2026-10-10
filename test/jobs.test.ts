import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
const mocks = vi.hoisted(() => ({ callbacks: [] as Array<() => void>, stop: vi.fn(), sweep: vi.fn(), recover: vi.fn(), refresh: vi.fn(), notify: vi.fn() }));
vi.mock("node-cron", () => ({ default: { validate: () => true, schedule: (_expression: string, callback: () => void) => { mocks.callbacks.push(callback); return { stop: mocks.stop }; } } }));
vi.mock("../src/jobs/verificationSweeper.js", () => ({ sweepExpiredVerifications: mocks.sweep }));
vi.mock("../src/jobs/ticketRecovery.js", () => ({ recoverTicketChannels: mocks.recover }));
vi.mock("../src/jobs/membershipRefresh.js", () => ({ refreshTrackedMemberships: mocks.refresh }));
vi.mock("../src/jobs/eligibilityNotifier.js", () => ({ notifyNewlyEligible: mocks.notify }));
import { startJobs, stopJobs } from "../src/jobs/index.js";
beforeEach(async () => { await stopJobs(); vi.resetAllMocks(); mocks.callbacks.length = 0; mocks.sweep.mockResolvedValue(undefined); mocks.recover.mockResolvedValue(undefined); });
describe("scheduled job lifecycle", () => {
  it("does not overlap startup and scheduled runs, and drains before stop resolves", async () => {
    let release!: () => void; mocks.sweep.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    startJobs({} as Client); await Promise.resolve();
    mocks.callbacks[0]!(); expect(mocks.sweep).toHaveBeenCalledTimes(1);
    let drained = false; const stopped = stopJobs().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false); expect(mocks.stop).toHaveBeenCalledTimes(4);
    release(); await stopped; expect(drained).toBe(true);
    mocks.callbacks[0]!(); expect(mocks.sweep).toHaveBeenCalledTimes(1);
  });
});
