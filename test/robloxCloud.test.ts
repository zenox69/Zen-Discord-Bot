import { afterEach, describe, expect, it, vi } from "vitest";
import { robloxCloud } from "../src/services/RobloxCloudService.js";
import { RobloxApiError } from "../src/utils/errors.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("robloxCloud.getGroupMembership", () => {
  it("parses the official createTime from the Open Cloud response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("test-open-cloud-key");
        expect(String(init?.headers as Record<string, string>)).not.toContain("roproxy");
        return jsonResponse(200, {
          groupMemberships: [
            {
              path: "groups/123/memberships/456",
              user: "users/202",
              role: "groups/123/roles/789",
              createTime: "2024-03-01T10:30:00.000Z",
              updateTime: "2024-03-01T10:30:00.000Z",
            },
          ],
        });
      }),
    );
    const info = await robloxCloud.getGroupMembership("123", "202");
    expect(info?.createTime?.toISOString()).toBe("2024-03-01T10:30:00.000Z");
  });

  it("returns null when the user is not a member (empty list)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(200, { groupMemberships: [] })));
    await expect(robloxCloud.getGroupMembership("123", "202")).resolves.toBeNull();
  });

  it("returns null createTime when the field is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(200, { groupMemberships: [{ path: "groups/1/memberships/2" }] })));
    const info = await robloxCloud.getGroupMembership("1", "2");
    expect(info?.createTime).toBeNull();
  });

  it("throws RobloxApiError on HTTP failure — never a fabricated date", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(403, { message: "forbidden" })));
    await expect(robloxCloud.getGroupMembership("123", "202")).rejects.toMatchObject({
      name: "RobloxApiError",
      kind: "http",
      status: 403,
    });
  });

  it("retries once after a 500 and recovers", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        call += 1;
        if (call === 1) return jsonResponse(500, { message: "boom" });
        return jsonResponse(200, {
          groupMemberships: [{ createTime: "2025-01-01T00:00:00.000Z" }],
        });
      }),
    );
    const info = await robloxCloud.getGroupMembership("123", "202");
    expect(call).toBe(2);
    expect(info?.createTime?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
  });

  it("does not retry 4xx", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        call += 1;
        return jsonResponse(401, { message: "unauthorized" });
      }),
    );
    await expect(robloxCloud.getGroupMembership("123", "202")).rejects.toBeInstanceOf(RobloxApiError);
    expect(call).toBe(1);
  });

  it("encodes the CEL user filter", async () => {
    let requestedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        requestedUrl = url;
        return jsonResponse(200, { groupMemberships: [] });
      }),
    );
    await robloxCloud.getGroupMembership("123", "202");
    expect(requestedUrl).toContain("/cloud/v2/groups/123/memberships");
    expect(requestedUrl).toContain(encodeURIComponent("user == 'users/202'"));
  });
});
