import { describe, expect, it } from "vitest";
import { createShutdown, type ShutdownDeps } from "../src/lifecycle.js";

function makeDeps(overrides: Partial<ShutdownDeps> = {}) {
  const calls: string[] = [];
  const deps: ShutdownDeps = {
    stopJobs: () => calls.push("stopJobs"),
    closeHealth: async () => {
      calls.push("closeHealth");
    },
    destroyClient: () => calls.push("destroyClient"),
    disconnectDb: async () => {
      calls.push("disconnectDb");
    },
    exit: (code) => calls.push(`exit:${code}`),
    ...overrides,
  };
  return { deps, calls };
}

function gatedCloseHealth(onRun?: () => void) {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    closeHealth: () => {
      onRun?.();
      return promise;
    },
    release: () => release(),
  };
}

describe("createShutdown", () => {
  it("runs cleanup steps in order and exits 0 by default", async () => {
    const { deps, calls } = makeDeps();
    await createShutdown(deps)("SIGTERM");
    expect(calls).toEqual(["stopJobs", "closeHealth", "destroyClient", "disconnectDb", "exit:0"]);
  });

  it("exits with the requested fatal code", async () => {
    const { deps, calls } = makeDeps();
    await createShutdown(deps)("unhandledRejection", 1);
    expect(calls[calls.length - 1]).toBe("exit:1");
  });

  it("is idempotent — a concurrent second call never re-runs cleanup", async () => {
    const gate = gatedCloseHealth();
    const { deps, calls } = makeDeps({ closeHealth: gate.closeHealth });
    const shutdown = createShutdown(deps);
    const first = shutdown("SIGTERM");
    await shutdown("SIGINT");
    gate.release();
    await first;
    expect(calls.filter((c) => c === "stopJobs")).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("exit:"))).toEqual(["exit:0"]);
  });

  it("a fatal request upgrades the pending exit code", async () => {
    const gate = gatedCloseHealth();
    const { deps, calls } = makeDeps({ closeHealth: gate.closeHealth });
    const shutdown = createShutdown(deps);
    const first = shutdown("SIGTERM");
    await shutdown("unhandledRejection", 1);
    gate.release();
    await first;
    expect(calls[calls.length - 1]).toBe("exit:1");
  });

  it("a benign request never downgrades a fatal exit code", async () => {
    const gate = gatedCloseHealth();
    const { deps, calls } = makeDeps({ closeHealth: gate.closeHealth });
    const shutdown = createShutdown(deps);
    const first = shutdown("invalidated", 1);
    await shutdown("SIGTERM");
    gate.release();
    await first;
    expect(calls[calls.length - 1]).toBe("exit:1");
  });

  it("a failing step does not block the remaining cleanup", async () => {
    const { deps, calls } = makeDeps({
      closeHealth: async () => {
        throw new Error("boom");
      },
    });
    await createShutdown(deps)("SIGTERM");
    expect(calls).toContain("destroyClient");
    expect(calls).toContain("disconnectDb");
    expect(calls[calls.length - 1]).toBe("exit:0");
  });
});
