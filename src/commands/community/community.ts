import { SlashCommandBuilder } from "@discordjs/builders";
import { LeavePolicy } from "@prisma/client";
import {
  addCommunity,
  editCommunity,
  listCommunities,
  removeCommunity,
  setCommunityEnabled,
} from "../../services/CommunityService.js";
import { AppError } from "../../utils/errors.js";
import { baseEmbed, COLORS, trunc } from "../../utils/embeds.js";
import type { MarketplaceCommand } from "../../handlers/commandHandler.js";

export const communityCommand: MarketplaceCommand = {
  requireAdmin: true,
  data: new SlashCommandBuilder()
    .setName("community")
    .setDescription("Manage tracked Roblox communities (admin)")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Add a Roblox community to track")
        .addStringOption((o) => o.setName("name").setDescription("Community name").setRequired(true))
        .addStringOption((o) => o.setName("roblox-group-id").setDescription("Roblox group ID").setRequired(true))
        .addIntegerOption((o) => o.setName("required-days").setDescription("Membership days required").setRequired(true).setMinValue(0).setMaxValue(3650))
        .addStringOption((o) => o.setName("emoji").setDescription("Optional emoji"))
        .addStringOption((o) => o.setName("invite-url").setDescription("Optional invite URL"))
        .addStringOption((o) => o.setName("notes").setDescription("Optional notes (staff only)"))
        .addStringOption((o) =>
          o
            .setName("leave-policy")
            .setDescription("What happens when a member leaves")
            .addChoices(
              { name: "Reset on leave (default)", value: "RESET_ON_LEAVE" },
              { name: "Keep original date", value: "KEEP_ORIGINAL" },
              { name: "Staff review", value: "STAFF_REVIEW" },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("edit")
        .setDescription("Edit a community")
        .addStringOption((o) => o.setName("community").setDescription("Community name").setRequired(true))
        .addStringOption((o) => o.setName("name").setDescription("New name"))
        .addStringOption((o) => o.setName("roblox-group-id").setDescription("New Roblox group ID"))
        .addIntegerOption((o) => o.setName("required-days").setDescription("New required days").setMinValue(0).setMaxValue(3650))
        .addStringOption((o) => o.setName("emoji").setDescription("New emoji (empty to clear)"))
        .addStringOption((o) => o.setName("invite-url").setDescription("New invite URL (empty to clear)"))
        .addStringOption((o) => o.setName("notes").setDescription("New notes (empty to clear)"))
        .addStringOption((o) =>
          o
            .setName("leave-policy")
            .setDescription("New leave policy")
            .addChoices(
              { name: "Reset on leave", value: "RESET_ON_LEAVE" },
              { name: "Keep original date", value: "KEEP_ORIGINAL" },
              { name: "Staff review", value: "STAFF_REVIEW" },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove a community (and its tracking history)")
        .addStringOption((o) => o.setName("community").setDescription("Community name").setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("List all tracked communities"))
    .addSubcommand((sub) =>
      sub
        .setName("enable")
        .setDescription("Enable a community")
        .addStringOption((o) => o.setName("community").setDescription("Community name").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("disable")
        .setDescription("Disable a community")
        .addStringOption((o) => o.setName("community").setDescription("Community name").setRequired(true)),
    ),
  execute: async (interaction) => {
    const guildId = interaction.guildId;
    if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This command requires a server." });
    const sub = interaction.options.getSubcommand();

    if (sub === "add") {
      const c = await addCommunity(guildId, interaction.user.id, {
        name: interaction.options.getString("name") ?? "",
        robloxGroupId: interaction.options.getString("roblox-group-id") ?? "",
        requiredDays: interaction.options.getInteger("required-days") ?? 0,
        emoji: interaction.options.getString("emoji"),
        inviteUrl: interaction.options.getString("invite-url"),
        notes: interaction.options.getString("notes"),
        leavePolicy: (interaction.options.getString("leave-policy") as LeavePolicy | null) ?? "RESET_ON_LEAVE",
      });
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.success).setTitle("✅ Community added").setDescription(
            [
              `**${c.emoji ? `${c.emoji} ` : ""}${c.name}**`,
              `Group ID: \`${c.robloxGroupId}\``,
              `Required: **${c.requiredDays} days**`,
              `Leave policy: \`${c.leavePolicy}\``,
            ].join("\n"),
          ),
        ],
      });
      return;
    }

    if (sub === "edit") {
      const c = await editCommunity(guildId, interaction.user.id, interaction.options.getString("community") ?? "", {
        name: interaction.options.getString("name") ?? null,
        robloxGroupId: interaction.options.getString("roblox-group-id"),
        requiredDays: interaction.options.getInteger("required-days"),
        emoji: interaction.options.getString("emoji"),
        inviteUrl: interaction.options.getString("invite-url"),
        notes: interaction.options.getString("notes"),
        leavePolicy: (interaction.options.getString("leave-policy") as LeavePolicy | null) ?? undefined,
      });
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.success)
            .setTitle("✅ Community updated")
            .setDescription(
              `**${c.name}** — group \`${c.robloxGroupId}\`, **${c.requiredDays} days**, policy \`${c.leavePolicy}\`, ${c.enabled ? "enabled" : "disabled"}.`,
            ),
        ],
      });
      return;
    }

    if (sub === "remove") {
      await removeCommunity(guildId, interaction.user.id, interaction.options.getString("community") ?? "");
      await interaction.reply({ embeds: [baseEmbed(COLORS.success).setTitle("✅ Community removed").setDescription("Its tracking history was removed as well.")] });
      return;
    }

    if (sub === "enable" || sub === "disable") {
      const c = await setCommunityEnabled(guildId, interaction.user.id, interaction.options.getString("community") ?? "", sub === "enable");
      await interaction.reply({
        embeds: [
          baseEmbed(c.enabled ? COLORS.success : COLORS.warning)
            .setTitle(c.enabled ? "✅ Community enabled" : "⏸️ Community disabled")
            .setDescription(`**${c.name}** is now ${c.enabled ? "enabled" : "disabled"}.`),
        ],
      });
      return;
    }

    // list
    const communities = await listCommunities(guildId);
    const embed = baseEmbed(COLORS.info).setTitle("🏘️ Tracked Communities");
    if (communities.length === 0) {
      embed.setDescription("None yet. Use `/community add` to track your first Roblox group.");
    } else {
      embed.setDescription(
        trunc(
          communities
            .map(
              (c) =>
                `${c.enabled ? "✅" : "⏸️"} ${c.emoji ? `${c.emoji} ` : ""}${c.name} — \`group:${c.robloxGroupId}\`, **${c.requiredDays}d**, \`${c.leavePolicy}\``,
            )
            .join("\n"),
          4000,
        ),
      );
    }
    await interaction.reply({ embeds: [embed] });
  },
};
