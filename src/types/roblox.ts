/** Typed shapes for public Roblox data served through RoProxy. */

export interface RobloxUserRef {
  id: string;
  name: string;
  displayName: string;
}

export interface RobloxProfile {
  id: string;
  name: string;
  displayName: string;
  description: string;
  created: Date;
  isBanned: boolean;
  hasVerifiedBadge: boolean;
}

/** One row from the group-roles endpoint (current membership, with role info). */
export interface GroupRole {
  groupId: string;
  groupName: string;
  roleId: number;
  roleName: string;
  rank: number;
}
