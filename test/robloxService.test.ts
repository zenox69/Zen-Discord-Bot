import { afterEach, describe, expect, it, vi } from "vitest";
import { roblox } from "../src/services/RobloxService.js";
import { RobloxApiError } from "../src/utils/errors.js";

let callCount = 0;
let responder: (call: number) => Response | never;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(): void {
  callCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, _init?: RequestInit) => {
      callCount += 1;
      return responder(callCount);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveUsername", () => {
  it("resolves a known username", async () => {
    mockFetch();
    responder = () =>
      jsonResponse(200, { data: [{ id: 101, name: "alpha_user", displayName: "Alpha" }] });
    await expect(roblox.resolveUsername("alpha_user")).resolves.toEqual({
      id: "101",
      name: "alpha_user",
      displayName: "Alpha",
    });
  });

  it("returns null for an empty data array (unknown user)", async () => {
    mockFetch();
    responder = () => jsonResponse(200, { data: [] });
    await expect(roblox.resolveUsername("ghost_user_1")).resolves.toBeNull();
  });

  it("returns null on HTTP 400/404 from the public API", async () => {
    mockFetch();
    responder = () => jsonResponse(400, { errors: ["not found"] });
    await expect(roblox.resolveUsername("missing_user_2")).resolves.toBeNull();
  });

  it("throws RobloxApiError(invalid) for malformed JSON shape", async () => {
    mockFetch();
    responder = () => jsonResponse(200, { data: "not-an-array" });
    await expect(roblox.resolveUsername("malformed_user_3")).rejects.toMatchObject({
      name: "RobloxApiError",
      kind: "invalid",
    });
  });
});

describe("getProfile", () => {
  it("parses a valid profile", async () => {
    mockFetch();
    responder = () =>
      jsonResponse(200, {
        id: 202,
        name: "beta_user",
        displayName: "Beta",
        created: "2010-01-01T00:00:00.000Z",
        description: "code-XYZ",
        isBanned: false,
      });
    const profile = await roblox.getProfile("202");
    expect(profile).toMatchObject({
      id: "202",
      name: "beta_user",
      description: "code-XYZ",
      isBanned: false,
    });
  });

  it("returns null on 404", async () => {
    mockFetch();
    responder = () => jsonResponse(404, { error: "user not found" });
    await expect(roblox.getProfile("999999999999")).resolves.toBeNull();
  });

  it("throws RobloxApiError(invalid) when id/name is missing", async () => {
    mockFetch();
    responder = () => jsonResponse(200, { created: "2010-01-01T00:00:00.000Z" });
    await expect(roblox.getProfile("303")).rejects.toBeInstanceOf(RobloxApiError);
  });
});

describe("getGroupRoles", () => {
  it("parses the current nested group/role shape", async () => {
    mockFetch();
    responder = () =>
      jsonResponse(200, {
        data: [
          {
            group: { id: 11, name: "Community A" },
            role: { id: 2, name: "Owner", rank: 10 },
          },
          {
            group: { id: "22", name: "Community B" },
            role: { id: 1, name: "Developer", rank: 253 },
          },
        ],
      });
    const roles = await roblox.getGroupRoles("404");
    expect(roles).toHaveLength(2);
    expect(roles[0]).toEqual({
      groupId: "11",
      groupName: "Community A",
      roleId: 2,
      roleName: "Owner",
      rank: 10,
    });
    expect(roles[1]!).toMatchObject({ groupId: "22", roleName: "Developer", rank: 253 });
  });

  it("still parses the legacy flat shape", async () => {
    mockFetch();
    responder = () =>
      jsonResponse(200, {
        data: [{ group_id: 33, name: "Legacy Group", role_id: 1, rank_name: "Member", rank: 1 }],
      });
    const roles = await roblox.getGroupRoles("405");
    expect(roles).toHaveLength(1);
    expect(roles[0]).toEqual({
      groupId: "33",
      groupName: "Legacy Group",
      roleId: 1,
      roleName: "Member",
      rank: 1,
    });
  });

  it("throws RobloxApiError(invalid) when data is not an array", async () => {
    mockFetch();
    responder = () => jsonResponse(200, { data: {} });
    await expect(roblox.getGroupRoles("505")).rejects.toMatchObject({
      name: "RobloxApiError",
      kind: "invalid",
    });
  });

  it("never reports 'not a member' on infrastructure failure", async () => {
    mockFetch();
    responder = () => {
      throw new TypeError("fetch failed");
    };
    await expect(roblox.getGroupRoles("606")).rejects.toMatchObject({
      name: "RobloxApiError",
      kind: "network",
    });
    expect(callCount).toBe(3); // initial attempt + 2 retries
  });
});

describe("retry behaviour", () => {
  it("recovers after a 500", async () => {
    mockFetch();
    responder = (call) => {
      if (call === 1) return jsonResponse(500, { error: "boom" });
      return jsonResponse(200, { data: [] });
    };
    await expect(roblox.resolveUsername("flaky_user_7")).resolves.toBeNull();
    expect(callCount).toBe(2);
  });

  it("does not retry 404s", async () => {
    mockFetch();
    responder = () => jsonResponse(404, { error: "nope" });
    await expect(roblox.getProfile("707")).resolves.toBeNull();
    expect(callCount).toBe(1);
  });
});
