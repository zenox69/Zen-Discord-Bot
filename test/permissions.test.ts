import { describe, expect, it } from "vitest";
import { PermissionFlagsBits, type GuildMember } from "discord.js";
import type { GuildSettings } from "@prisma/client";
import { isAdmin, isSelfOrStaff, isStaff, requireAdmin } from "../src/utils/permissions.js";

/** Minimal GuildMember stub carrying only what the permission helpers read. */
function makeMember(opts: {
  id?: string;
  ownerId?: string;
  roleIds?: string[];
  administrator?: boolean;
} = {}): GuildMember {
  const { id = "user-1", ownerId = "owner-1", roleIds = [], administrator = false } = opts;
  return {
    id,
    guild: { ownerId },
    roles: { cache: roleIds.map((roleId) => ({ id: roleId })) },
    permissions: {
      has: (flag: bigint) => administrator && flag === PermissionFlagsBits.Administrator,
    },
  } as unknown as GuildMember;
}

/** Minimal GuildSettings stub carrying only the role columns the helpers read. */
function makeSettings(opts: { adminRoleId?: string | null; staffRoleId?: string | null } = {}): GuildSettings {
  return {
    adminRoleId: opts.adminRoleId ?? null,
    staffRoleId: opts.staffRoleId ?? null,
  } as unknown as GuildSettings;
}

const settings = makeSettings({ adminRoleId: "admin-role", staffRoleId: "staff-role" });

describe("isAdmin", () => {
  it("grants access to the guild owner without any roles", () => {
    expect(isAdmin(makeMember({ id: "owner-1" }), settings)).toBe(true);
  });

  it("grants access to a native Discord Administrator", () => {
    expect(isAdmin(makeMember({ administrator: true }), settings)).toBe(true);
  });

  it("grants access to the configured admin role", () => {
    expect(isAdmin(makeMember({ roleIds: ["admin-role"] }), settings)).toBe(true);
  });

  it("denies access to the staff role alone", () => {
    const member = makeMember({ roleIds: ["staff-role"] });
    expect(isAdmin(member, settings)).toBe(false);
  });

  it("denies access when no admin role is configured and there is no Administrator", () => {
    expect(isAdmin(makeMember({ roleIds: ["admin-role"] }), makeSettings({ adminRoleId: null }))).toBe(false);
  });
});

describe("isStaff", () => {
  it("grants access to the configured staff role", () => {
    expect(isStaff(makeMember({ roleIds: ["staff-role"] }), settings)).toBe(true);
  });

  it("implies staff access from the admin role", () => {
    expect(isStaff(makeMember({ roleIds: ["admin-role"] }), settings)).toBe(true);
  });

  it("grants access to the guild owner", () => {
    expect(isStaff(makeMember({ id: "owner-1" }), settings)).toBe(true);
  });

  it("denies access to unrelated members", () => {
    expect(isStaff(makeMember({ roleIds: ["customer-role"] }), settings)).toBe(false);
  });

  it("denies everyone when no staff role is configured (except owner/Administrator)", () => {
    const bare = makeSettings({ staffRoleId: null, adminRoleId: null });
    expect(isStaff(makeMember({ roleIds: ["staff-role"] }), bare)).toBe(false);
  });
});

describe("isSelfOrStaff", () => {
  const target = { id: "user-1" } as never;

  it("allows the member to act on themselves", () => {
    expect(isSelfOrStaff(makeMember({ id: "user-1" }), target, settings)).toBe(true);
  });

  it("allows staff to act on others", () => {
    expect(isSelfOrStaff(makeMember({ id: "staffer", roleIds: ["staff-role"] }), target, settings)).toBe(true);
  });

  it("denies non-staff members acting on others", () => {
    expect(isSelfOrStaff(makeMember({ id: "user-2" }), target, settings)).toBe(false);
  });
});

describe("requireAdmin", () => {
  it("throws for a non-admin member", () => {
    expect(() => requireAdmin(makeMember({ roleIds: ["staff-role"] }), settings)).toThrow();
  });

  it("does not throw for an admin member", () => {
    expect(() => requireAdmin(makeMember({ roleIds: ["admin-role"] }), settings)).not.toThrow();
  });

  it("does not throw for the guild owner", () => {
    expect(() => requireAdmin(makeMember({ id: "owner-1" }), settings)).not.toThrow();
  });
});
