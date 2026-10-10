import { PermissionFlagsBits, type GuildMember, type User, type BaseInteraction } from "discord.js";
import type { GuildSettings } from "@prisma/client";
import { AppError } from "./errors.js";

/**
 * Permission helpers. Every command AND every button/select/modal performs
 * server-side checks through these — never rely on hidden UI alone.
 *
 * Roles (per guild, configured via /setup):
 *   Customer    — implicit: any member
 *   Staff       — staffRoleId (also implies customer powers)
 *   Administrator — adminRoleId (also implies staff powers)
 * Guild owner always counts as administrator.
 */

function memberRoles(member: GuildMember): Set<string> {
  return new Set(member?.roles?.cache?.map((r) => r.id) ?? []);
}

export function isAdmin(member: GuildMember, settings: GuildSettings): boolean {
  if (!member?.id || !member.guild) return false;
  if (member.guild.ownerId === member.id) return true;
  // A native Discord Administrator always outranks role configuration —
  // otherwise a server admin is locked out before any admin role exists.
  if (typeof member.permissions?.has === "function" && member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (!settings.adminRoleId) return false;
  return memberRoles(member).has(settings.adminRoleId);
}

export function isStaff(member: GuildMember, settings: GuildSettings): boolean {
  if (isAdmin(member, settings)) return true;
  if (!settings.staffRoleId) return false;
  return memberRoles(member).has(settings.staffRoleId);
}

// One current REST snapshot per interaction; roles are rechecked on each new
// button/modal interaction, including forms opened before a role was removed.
const memberSnapshots = new WeakMap<BaseInteraction, Promise<GuildMember>>();
export function getInteractionMember(interaction: BaseInteraction): Promise<GuildMember> {
  const existing = memberSnapshots.get(interaction);
  if (existing) return existing;
  const result = (async () => {
    const guild = interaction.guild;
    if (!guild) throw new AppError({ code: "NOT_A_MEMBER", friendly: "❌ This action requires a server membership." });
    try {
      const member = await guild.members.fetch({ user: interaction.user.id, force: true });
      if (member.id !== interaction.user.id || member.guild.id !== guild.id) throw new Error("Member mismatch");
      return member;
    } catch {
      throw new AppError({ code: "MEMBER_UNAVAILABLE", friendly: "❌ Could not confirm your current server permissions. Please try again." });
    }
  })();
  memberSnapshots.set(interaction, result);
  return result;
}

export function isSelfOrStaff(
  member: GuildMember,
  target: User,
  settings: GuildSettings,
): boolean {
  return member.id === target.id || isStaff(member, settings);
}

export function requireAdmin(member: GuildMember, settings: GuildSettings): void {
  if (!isAdmin(member, settings)) {
    throw new AppError({
      code: "NOT_ADMIN",
      friendly: "❌ This action requires the **Administrator** role (or server ownership).",
    });
  }
}

export function requireStaff(member: GuildMember, settings: GuildSettings): void {
  if (!isStaff(member, settings)) {
    throw new AppError({
      code: "NOT_STAFF",
      friendly: "❌ This action requires the **Staff** or **Administrator** role.",
    });
  }
}
