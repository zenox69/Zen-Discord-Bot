import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { closeHealthServer } from "../src/health.js";

describe("closeHealthServer", () => {
  it("resolves immediately when the health server is disabled (null)", async () => {
    await expect(closeHealthServer(null)).resolves.toBeUndefined();
  });

  it("awaits close of a listening server", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    expect(server.listening).toBe(true);
    await closeHealthServer(server);
    expect(server.listening).toBe(false);
  });
});
