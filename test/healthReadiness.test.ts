import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), ready: vi.fn(), callback: vi.fn() }));
vi.mock("../src/database/prisma.js", () => ({ prisma: { $queryRaw: mocks.query } }));
vi.mock("../src/utils/botClient.js", () => ({ getBotClient: () => ({ isReady: mocks.ready }) }));
vi.mock("../src/services/RobloxOAuthService.js", () => ({ OAUTH_CALLBACK_PATH: "/redirect", isOAuthVerificationConfigured: () => true, handleRobloxOAuthCallback: mocks.callback }));
import { closeHealthServer, markHealthDraining, startHealthServer } from "../src/health.js";
let server: Server | null = null;
async function listen(): Promise<string> {
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await closeHealthServer(reservation); server = startHealthServer(port)!; await once(server, "listening");
  return `http://127.0.0.1:${port}`;
}
beforeEach(() => { vi.resetAllMocks(); mocks.ready.mockReturnValue(true); mocks.query.mockResolvedValue(1); mocks.callback.mockResolvedValue({ status: 200, html: "verified" }); });
afterEach(async () => { await closeHealthServer(server); server = null; });
describe("health/readiness endpoints", () => {
  it("keeps liveness independent of Discord and database availability", async () => {
    mocks.ready.mockReturnValue(false); const base = await listen();
    expect((await fetch(`${base}/livez`)).status).toBe(200);
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("reports database failure as unready on both readiness aliases", async () => {
    mocks.query.mockRejectedValue(new Error("offline")); const base = await listen();
    for (const path of ["/healthz", "/readyz"]) expect((await fetch(base + path)).status).toBe(503);
  });
  it("coalesces concurrent readiness probes into one database query", async () => {
    let release!: () => void; mocks.query.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const base = await listen(); let requests = 0; server!.on("request", () => { requests += 1; });
    const a = fetch(`${base}/readyz`); const b = fetch(`${base}/healthz`);
    await vi.waitFor(() => expect(requests).toBe(2)); expect(mocks.query).toHaveBeenCalledTimes(1);
    release(); expect((await a).status).toBe(200); expect((await b).status).toBe(200);
  });
  it("bounds hanging database probes and recovers once the query settles", async () => {
    let release!: () => void; mocks.query.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const base = await listen();
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    release(); await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  }, 10_000);
  it("rejects readiness and new OAuth callbacks while draining", async () => {
    const base = await listen(); markHealthDraining();
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    expect((await fetch(`${base}/redirect?code=c&state=s`)).status).toBe(503);
    expect(mocks.callback).not.toHaveBeenCalled();
  });
  it("makes an already running readiness probe unready when shutdown starts", async () => {
    let release!: () => void; mocks.query.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const base = await listen(); const response = fetch(`${base}/readyz`);
    await vi.waitFor(() => expect(mocks.query).toHaveBeenCalled());
    markHealthDraining(); release(); expect((await response).status).toBe(503);
  });
  it("preserves OAuth aliases and returns privacy headers", async () => {
    const base = await listen();
    for (const path of ["/redirect", "/oauth/roblox/callback"]) {
      const response = await fetch(`${base}${path}?code=c&state=s`);
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
    expect((await fetch(`${base}/redirect?code=c&state=s`, { method: "POST" })).status).toBe(405);
    expect(mocks.callback).toHaveBeenCalledTimes(2);
  });
});
