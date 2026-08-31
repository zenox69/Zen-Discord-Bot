import { AuditCategory, LeavePolicy, type RobloxCommunity } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import { audit } from "./AuditService.js";
import { AppError } from "../utils/errors.js";
import { sanitizeInput } from "../utils/text.js";

/**
 * CommunityService — CRUD for the Roblox communities a guild tracks.
 * Communities are fully configurable from Discord; nothing is hard-coded.
 */

const GROUP_ID_RE = /^\d{1,19}$/;

export interface CommunityInput {
  name?: string | null;
  robloxGroupId?: string | null;
  requiredDays?: number | null;
  emoji?: string | null;
  inviteUrl?: string | null;
  notes?: string | null;
  leavePolicy?: LeavePolicy;
}

async function assertValid(input: CommunityInput): Promise<void> {
  const name = input.name ? sanitizeInput(input.name, 60) : "";
  if (name.length < 2) throw new AppError({ code: "INVALID_NAME", friendly: "❌ Community name is too short." });
  if (!GROUP_ID_RE.test((input.robloxGroupId ?? "").trim())) {
    throw new AppError({ code: "INVALID_GROUP_ID", friendly: "❌ Roblox group ID must be numeric." });
  }
  if (
    input.requiredDays === null ||
    input.requiredDays === undefined ||
    !Number.isInteger(input.requiredDays) ||
    input.requiredDays < 0 ||
    input.requiredDays > 3650
  ) {
    throw new AppError({ code: "INVALID_DAYS", friendly: "❌ Required days must be a whole number between 0 and 3650." });
  }
}

export async function addCommunity(
  guildId: string,
  actorDiscordId: string,
  input: CommunityInput,
): Promise<RobloxCommunity> {
  await assertValid(input);
  const robloxGroupId = (input.robloxGroupId ?? "").trim();
  const existing = await prisma.robloxCommunity.findFirst({ where: { guildId, robloxGroupId } });
  if (existing) {
    throw new AppError({
      code: "DUPLICATE_GROUP",
      friendly: `❌ Group \`${robloxGroupId}\` is already tracked as **${existing.name}**.`,
    });
  }
  const community = await prisma.robloxCommunity.create({
    data: {
      guildId,
      name: sanitizeInput(input.name ?? "", 60),
      robloxGroupId,
      requiredDays: input.requiredDays ?? 0,
      emoji: input.emoji ? sanitizeInput(input.emoji, 8) : null,
      inviteUrl: input.inviteUrl ? sanitizeInput(input.inviteUrl, 500) : null,
      notes: input.notes ? sanitizeInput(input.notes, 500) : null,
      leavePolicy: input.leavePolicy ?? "RESET_ON_LEAVE",
    },
  });
  await audit({
    category: AuditCategory.COMMUNITY,
    action: "ADDED",
    guildId,
    actorDiscordId,
    details: { name: community.name, robloxGroupId, requiredDays: community.requiredDays },
  });
  return community;
}

export async function findCommunityByName(guildId: string, rawName: string): Promise<RobloxCommunity> {
  const needle = rawName.trim().toLowerCase();
  const all = await prisma.robloxCommunity.findMany({ where: { guildId } });
  const exact = all.find((c) => c.name.toLowerCase() === needle);
  if (exact) return exact;
  const starts = all.filter((c) => c.name.toLowerCase().startsWith(needle));
  if (starts.length === 1) return starts[0]!;
  if (starts.length > 1) {
    throw new AppError({
      code: "AMBIGUOUS_COMMUNITY",
      friendly: `❌ Multiple communities match: ${starts.map((c) => `**${c.name}**`).join(", ")}.`,
    });
  }
  throw new AppError({ code: "COMMUNITY_NOT_FOUND", friendly: `❌ No community named “${rawName.trim()}”. Use \`/community list\`.` });
}

export async function editCommunity(
  guildId: string,
  actorDiscordId: string,
  rawName: string,
  input: CommunityInput,
): Promise<RobloxCommunity> {
  const target = await findCommunityByName(guildId, rawName);
  const changes: Record<string, unknown> = {};

  if (input.name !== undefined && input.name !== null) {
    const name = sanitizeInput(input.name, 60);
    if (name.length >= 2) changes.name = name;
  }
  if (input.robloxGroupId !== undefined && input.robloxGroupId !== null) {
    const id = input.robloxGroupId.trim();
    if (!GROUP_ID_RE.test(id)) throw new AppError({ code: "INVALID_GROUP_ID", friendly: "❌ Roblox group ID must be numeric." });
    const clash = await prisma.robloxCommunity.findFirst({ where: { guildId, robloxGroupId: id } });
    if (clash && clash.id !== target.id) {
      throw new AppError({ code: "DUPLICATE_GROUP", friendly: `❌ Group \`${id}\` is already tracked as **${clash.name}**.` });
    }
    changes.robloxGroupId = id;
  }
  if (input.requiredDays !== undefined && input.requiredDays !== null) {
    if (!Number.isInteger(input.requiredDays) || input.requiredDays < 0 || input.requiredDays > 3650) {
      throw new AppError({ code: "INVALID_DAYS", friendly: "❌ Required days must be a whole number between 0 and 3650." });
    }
    changes.requiredDays = input.requiredDays;
  }
  if (input.emoji !== undefined) changes.emoji = input.emoji ? sanitizeInput(input.emoji, 8) : null;
  if (input.inviteUrl !== undefined) changes.inviteUrl = input.inviteUrl ? sanitizeInput(input.inviteUrl, 500) : null;
  if (input.notes !== undefined) changes.notes = input.notes ? sanitizeInput(input.notes, 500) : null;
  if (input.leavePolicy !== undefined) changes.leavePolicy = input.leavePolicy;

  if (Object.keys(changes).length === 0) {
    throw new AppError({ code: "NO_CHANGES", friendly: "❌ Provide at least one field to change." });
  }

  const updated = await prisma.robloxCommunity.update({ where: { id: target.id }, data: changes });
  await audit({
    category: AuditCategory.COMMUNITY,
    action: "EDITED",
    guildId,
    actorDiscordId,
    details: { name: updated.name, changes },
  });
  return updated;
}

export async function removeCommunity(guildId: string, actorDiscordId: string, rawName: string): Promise<void> {
  const target = await findCommunityByName(guildId, rawName);
  await prisma.robloxCommunity.delete({ where: { id: target.id } });
  await audit({
    category: AuditCategory.COMMUNITY,
    action: "REMOVED",
    guildId,
    actorDiscordId,
    details: { name: target.name, robloxGroupId: target.robloxGroupId },
  });
}

export async function setCommunityEnabled(
  guildId: string,
  actorDiscordId: string,
  rawName: string,
  enabled: boolean,
): Promise<RobloxCommunity> {
  const target = await findCommunityByName(guildId, rawName);
  const updated = await prisma.robloxCommunity.update({ where: { id: target.id }, data: { enabled } });
  await audit({
    category: AuditCategory.COMMUNITY,
    action: enabled ? "ENABLED" : "DISABLED",
    guildId,
    actorDiscordId,
    details: { name: updated.name },
  });
  return updated;
}

export async function listCommunities(guildId: string): Promise<RobloxCommunity[]> {
  return prisma.robloxCommunity.findMany({ where: { guildId }, orderBy: { name: "asc" } });
}
