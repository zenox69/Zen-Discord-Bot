import { afterEach, describe, expect, it, vi } from "vitest";
import type { BaseInteraction, GuildMember } from "discord.js";
import type { GuildSettings } from "@prisma/client";
import { getInteractionMember, isAdmin, isStaff } from "../src/utils/permissions.js";
import { TtlCache } from "../src/utils/ttlCache.js";
import { withWorkflowLock } from "../src/utils/workflowLock.js";
import { redact, redactText } from "../src/utils/redact.js";
import { retryAfterMs } from "../src/utils/retryAfter.js";

afterEach(() => vi.restoreAllMocks());

describe("permission snapshots", () => {
  it("resolves raw members with force and reuses the same interaction snapshot", async () => {
    const member = { id: "u1", guild: { id: "g1" } };
    const fetch = vi.fn(async () => member);
    const interaction = { user: { id: "u1" }, member: { roles: ["old-role"] }, guild: { id: "g1", members: { fetch } } } as unknown as BaseInteraction;
    expect(await getInteractionMember(interaction)).toBe(member);
    expect(await getInteractionMember(interaction)).toBe(member);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith({ user: "u1", force: true });
  });
  it("fails closed on member fetch errors and mismatched identities", async () => {
    for (const result of [Promise.reject(new Error("403")), Promise.resolve({ id: "other", guild: { id: "g1" } })]) {
      const interaction = { user: { id: "u1" }, guild: { id: "g1", members: { fetch: () => result } } } as unknown as BaseInteraction;
      await expect(getInteractionMember(interaction)).rejects.toMatchObject({ code: "MEMBER_UNAVAILABLE" });
    }
  });
  it("malformed member representations never grant staff/admin", () => {
    const settings = { adminRoleId: "admin", staffRoleId: "staff" } as GuildSettings;
    for (const member of [null, {}, { roles: ["admin"] }]) {
      expect(isAdmin(member as unknown as GuildMember, settings)).toBe(false);
      expect(isStaff(member as unknown as GuildMember, settings)).toBe(false);
    }
  });
});

describe("bounded state and retries", () => {
  it("evicts live entries at the limit and expires exactly on the TTL boundary", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const cache = new TtlCache<number>(2);
    cache.set("a", 1, 100); cache.set("b", 2, 100); cache.set("c", 3, 100);
    expect(cache.get("a")).toBeUndefined(); expect(cache.get("c")).toBe(3);
    vi.spyOn(Date, "now").mockReturnValue(1100);
    expect(cache.get("c")).toBeUndefined();
  });
  it("rejects concurrent workflow requests and releases after failures", async () => {
    let release!: () => void;
    const first = withWorkflowLock("same", () => new Promise<void>((resolve) => { release = resolve; }));
    await expect(withWorkflowLock("same", async () => undefined)).rejects.toMatchObject({ code: "WORKFLOW_BUSY" });
    await expect(withWorkflowLock("other", async () => 2)).resolves.toBe(2);
    release(); await first;
    await expect(withWorkflowLock("same", async () => { throw new Error("DB failed"); })).rejects.toThrow("DB failed");
    await expect(withWorkflowLock("same", async () => 3)).resolves.toBe(3);
  });
  it("parses seconds and HTTP dates without accepting garbage", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-10T00:00:00Z"));
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs("Sat, 10 Oct 2026 00:00:03 GMT")).toBe(3000);
    expect(retryAfterMs("bad")).toBeUndefined();
  });
});

describe("secret redaction", () => {
  it("redacts environment secrets, URL credentials, callback codes and bearer tokens", () => {
    const text = redactText(`failure ${process.env.DISCORD_TOKEN} postgresql://person:private@db/prod https://host/redirect?code=one&state=two Bearer access-secret`);
    for (const value of [process.env.DISCORD_TOKEN!, "private", "code=one", "state=two", "access-secret"]) expect(text).not.toContain(value);
    expect(text).toContain("failure");
  });
  it("redacts nested credential fields and cyclic objects without losing error stacks", () => {
    const value: Record<string, unknown> = { request: { authorization: "secret", client_secret: "private" }, message: "useful" };
    value.self = value;
    expect(redact(value)).toMatchObject({ request: { authorization: "[REDACTED]", client_secret: "[REDACTED]" }, self: "[circular]" });
    expect(redact(new Error("safe"))).toMatchObject({ message: "safe", stack: expect.stringContaining("Error: safe") });
  });
});
