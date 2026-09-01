import { SlashCommandBuilder } from "@discordjs/builders";
import { ChannelType, GuildChannel, type GuildMember } from "discord.js";
import { ensureGuild, updateSettings, type GuildSettingsPatch } from "../../services/GuildSettingsService.js";
import { publishTicketPanel, type PanelKind } from "../../services/TicketService.js";
import { getBotClient } from "../../utils/botClient.js";
import { baseEmbed, COLORS, trunc } from "../../utils/embeds.js";
import { AppError } from "../../utils/errors.js";
import { sanitizeInput } from "../../utils/text.js";
import type { MarketplaceCommand } from "../../handlers/commandHandler.js";

const LOG_CHANNEL_KEYS = {
  "tickets": "ticketCategoryId",
  "panel": "orderPanelChannelId",
  "order-log": "orderLogChannelId",
  "ticket-log": "ticketLogChannelId",
  "eligibility-log": "eligibilityLogChannelId",
  "verification-log": "verificationLogChannelId",
  "error-log": "errorLogChannelId",
} as const;

type ChannelKey = keyof typeof LOG_CHANNEL_KEYS;

function validateTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    throw new AppError({ code: "INVALID_TIMEZONE", friendly: `❌ \`${tz}\` is not a valid IANA timezone (e.g. Asia/Manila).` });
  }
}

export const setupCommand: MarketplaceCommand = {
  requireAdmin: true,
  requireConfigured: false,
  allowWhenDisabled: true,
  data: new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Configure the marketplace for this server (admin)")
    .addSubcommand((sub) => sub.setName("view").setDescription("Show the current configuration"))
    .addSubcommand((sub) =>
      sub.setName("init").setDescription("Run full automatic setup — creates any missing roles, ticket category, and panel channel"),
    )
    .addSubcommand((sub) =>
      sub.setName("name").setDescription("Set the marketplace name").addStringOption((o) => o.setName("name").setDescription("Marketplace name").setRequired(true).setMaxLength(50)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("role")
        .setDescription("Set a role")
        .addStringOption((o) => o.setName("which").setDescription("Role to set").setRequired(true).addChoices({ name: "Staff", value: "staff" }, { name: "Administrator", value: "admin" }))
        .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("channel")
        .setDescription("Set a channel")
        .addStringOption((o) =>
          o
            .setName("which")
            .setDescription("Channel to set")
            .setRequired(true)
            .addChoices(
              { name: "Order panel channel", value: "panel" },
              { name: "Order log channel", value: "order-log" },
              { name: "Ticket log channel", value: "ticket-log" },
              { name: "Eligibility log channel", value: "eligibility-log" },
              { name: "Verification log channel", value: "verification-log" },
              { name: "Bot/error log channel", value: "error-log" },
            ),
        )
        .addChannelOption((o) => o.setName("channel").setDescription("Channel").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("tickets")
        .setDescription("Set the ticket category (created automatically if it does not exist)")
        .addStringOption((o) =>
          o.setName("name").setDescription("Category name (e.g. Tickets)").setRequired(true).setMaxLength(50),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("currency")
        .setDescription("Set currency code and symbol")
        .addStringOption((o) => o.setName("code").setDescription("e.g. PHP").setRequired(true).setMaxLength(8))
        .addStringOption((o) => o.setName("symbol").setDescription("e.g. ₱").setRequired(true).setMaxLength(4)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("timezone")
        .setDescription("Set guild timezone (IANA)")
        .addStringOption((o) => o.setName("timezone").setDescription("e.g. Asia/Manila").setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName("enable").setDescription("Enable the marketplace on this server"))
    .addSubcommand((sub) => sub.setName("disable").setDescription("Disable the marketplace on this server"))
    .addSubcommand((sub) =>
      sub
        .setName("publish")
        .setDescription("Publish a panel to the panel channel (or a specific channel)")
        .addStringOption((o) =>
          o
            .setName("panel")
            .setDescription("Which panel")
            .setRequired(true)
            .addChoices(
              { name: "Order panel", value: "order" },
              { name: "Ticket (support) panel", value: "ticket" },
              { name: "Verification panel", value: "verify" },
              { name: "Combined panel (all)", value: "all" },
            ),
        )
        .addChannelOption((o) => o.setName("channel").setDescription("Publish to this channel instead of the configured panel channel").addChannelTypes(ChannelType.GuildText)),
    ),
  execute: async (interaction) => {
    const guildId = interaction.guildId;
    if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This command requires a server." });
    const settings = await ensureGuild(guildId, interaction.guild?.name ?? "Guild");
    const sub = interaction.options.getSubcommand();

    if (sub === "view") {
      const lines = [
        `**Marketplace:** ${settings.marketplaceName}`,
        `**Enabled:** ${settings.enabled ? "✅" : "⏸️"}`,
        `**Staff role:** ${settings.staffRoleId ? `<@&${settings.staffRoleId}>` : "— not set"}`,
        `**Admin role:** ${settings.adminRoleId ? `<@&${settings.adminRoleId}>` : "— not set"}`,
        `**Ticket category:** ${settings.ticketCategoryId ? `<#${settings.ticketCategoryId}>` : "— not set"}`,
        `**Panel channel:** ${settings.orderPanelChannelId ? `<#${settings.orderPanelChannelId}>` : "— not set"}`,
        `**Order log:** ${settings.orderLogChannelId ? `<#${settings.orderLogChannelId}>` : "— not set"}`,
        `**Ticket log:** ${settings.ticketLogChannelId ? `<#${settings.ticketLogChannelId}>` : "— not set"}`,
        `**Eligibility log:** ${settings.eligibilityLogChannelId ? `<#${settings.eligibilityLogChannelId}>` : "— not set"}`,
        `**Verification log:** ${settings.verificationLogChannelId ? `<#${settings.verificationLogChannelId}>` : "— not set"}`,
        `**Error log:** ${settings.errorLogChannelId ? `<#${settings.errorLogChannelId}>` : "— not set"}`,
        `**Currency:** ${settings.currency} (${settings.currencySymbol})`,
        `**Timezone:** ${settings.timezone}`,
        `**Ticket counter:** ${settings.ticketCounter} • **Order counter:** ${settings.orderCounter}`,
      ];
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.info, settings.marketplaceName).setTitle("⚙️ Marketplace Configuration").setDescription(trunc(lines.join("\n"), 4000)),
        ],
        ephemeral: true,
      });
      return;
    }

    const patch: GuildSettingsPatch = {};
    let summary = "";

    if (sub === "init") {
      // One-shot automatic setup: fills in every missing piece, leaves
      // anything already configured untouched, then publishes the panel.
      const guild = interaction.guild;
      if (!guild) throw new AppError({ code: "NO_GUILD", friendly: "❌ This command requires a server." });
      const member = interaction.member as GuildMember;
      const lines: string[] = [];
      const all = await guild.channels.fetch();

      if (!settings.adminRoleId) {
        const role = await guild.roles.create({
          name: "Marketplace Admin",
          reason: "Marketplace auto-setup",
        });
        await member.roles.add(role.id).catch(() => undefined);
        patch.adminRoleId = role.id;
        lines.push(`**Admin role** — created **${role.name}** and assigned it to you.`);
      } else {
        lines.push(`**Admin role** — already set to <@&${settings.adminRoleId}>.`);
      }

      if (!settings.staffRoleId) {
        const role = await guild.roles.create({
          name: "Marketplace Staff",
          reason: "Marketplace auto-setup",
        });
        patch.staffRoleId = role.id;
        lines.push(`**Staff role** — created **${role.name}** (assign it to your helpers).`);
      } else {
        lines.push(`**Staff role** — already set to <@&${settings.staffRoleId}>.`);
      }

      if (settings.ticketCategoryId) {
        lines.push("**Ticket category** — already configured.");
      } else {
        const cat =
          (all.find((c) => !!c && c.type === ChannelType.GuildCategory && c.name.toLowerCase() === "tickets") as GuildChannel | undefined) ??
          ((await guild.channels.create({ name: "Tickets", type: ChannelType.GuildCategory, reason: "Marketplace auto-setup" })) as GuildChannel);
        patch.ticketCategoryId = cat.id;
        lines.push(`**Ticket category** — using **${cat.name}**.`);
      }

      if (settings.orderPanelChannelId) {
        lines.push("**Panel channel** — already configured.");
      } else {
        const ch =
          (all.find((c) => !!c && c.type === ChannelType.GuildText && c.name.toLowerCase() === "marketplace-panel") as GuildChannel | undefined) ??
          ((await guild.channels.create({ name: "marketplace-panel", type: ChannelType.GuildText, reason: "Marketplace auto-setup" })) as GuildChannel);
        patch.orderPanelChannelId = ch.id;
        lines.push(`**Panel channel** — using **${ch.name}**.`);
      }

      if (Object.keys(patch).length > 0) {
        await updateSettings(guildId, patch);
      }
      await publishTicketPanel(guildId, "all");
      lines.push("**Panel** — published in the panel channel.", "", "Next: add communities (`/community add`) and products (`/product add`), then click **Create Order** on the panel.");

      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.success, settings.marketplaceName)
            .setTitle("✅ Setup complete")
            .setDescription(trunc(lines.join("\n"), 4000)),
        ],
        ephemeral: true,
      });
      return;
    }

    if (sub === "name") {
      const name = sanitizeInput(interaction.options.getString("name") ?? "", 50);
      if (name.length < 2) throw new AppError({ code: "INVALID_NAME", friendly: "❌ Marketplace name is too short." });
      patch.marketplaceName = name;
      summary = `Marketplace name set to **${name}**.`;
    }

    if (sub === "role") {
      const which = interaction.options.getString("which") ?? "staff";
      const role = interaction.options.getRole("role");
      if (!role) throw new AppError({ code: "MISSING_ROLE", friendly: "❌ Please provide a role." });
      if (which === "admin") {
        patch.adminRoleId = role.id;
        summary = `Administrator role set to **${role.name}**.`;
      } else {
        patch.staffRoleId = role.id;
        summary = `Staff role set to **${role.name}**.`;
      }
    }

    if (sub === "channel") {
      const which = (interaction.options.getString("which") ?? "panel") as ChannelKey;
      const channelId = interaction.options.getChannel("channel")?.id;
      if (!channelId) throw new AppError({ code: "MISSING_CHANNEL", friendly: "❌ Please provide a channel." });
      const client = getBotClient();
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!(channel instanceof GuildChannel) || channel.guildId !== guildId) {
        throw new AppError({ code: "WRONG_GUILD_CHANNEL", friendly: "❌ Please provide a channel from this server." });
      }
      if (channel.type !== ChannelType.GuildText) {
        throw new AppError({ code: "NOT_A_TEXT_CHANNEL", friendly: "❌ That channel must be a text channel." });
      }
      patch[LOG_CHANNEL_KEYS[which]] = channel.id;
      summary = `${which} channel set to <#${channel.id}>.`;
    }

    if (sub === "tickets") {
      const name = sanitizeInput(interaction.options.getString("name") ?? "", 50);
      if (name.length < 2) throw new AppError({ code: "INVALID_CATEGORY_NAME", friendly: "❌ Category name is too short." });
      const guild = interaction.guild;
      if (!guild) throw new AppError({ code: "NO_GUILD", friendly: "❌ This command requires a server." });
      // The slash-command channel picker cannot select categories, so we look
      // the category up by name — and create it when it does not exist yet.
      const all = await guild.channels.fetch();
      const existing = all.find(
        (c) => !!c && c.type === ChannelType.GuildCategory && c.name.toLowerCase() === name.toLowerCase(),
      );
      const category: GuildChannel =
        existing ??
        (await guild.channels.create({ name, type: ChannelType.GuildCategory, reason: "Marketplace ticket category" }));
      patch.ticketCategoryId = category.id;
      summary = existing
        ? `Ticket category set to **${category.name}**.`
        : `Ticket category **${category.name}** created and set.`;
    }

    if (sub === "currency") {
      const code = sanitizeInput(interaction.options.getString("code") ?? "", 8).toUpperCase();
      const symbol = sanitizeInput(interaction.options.getString("symbol") ?? "", 4);
      if (!code || !symbol) throw new AppError({ code: "INVALID_CURRENCY", friendly: "❌ Both currency code and symbol are required." });
      patch.currency = code;
      patch.currencySymbol = symbol;
      summary = `Currency set to **${code}** (${symbol}).`;
    }

    if (sub === "timezone") {
      const tz = (interaction.options.getString("timezone") ?? "").trim();
      validateTimezone(tz);
      patch.timezone = tz;
      summary = `Timezone set to **${tz}**.`;
    }

    if (sub === "enable") {
      patch.enabled = true;
      summary = "Marketplace **enabled** on this server.";
    }
    if (sub === "disable") {
      patch.enabled = false;
      summary = "Marketplace **disabled** on this server. All commands are now blocked.";
    }

    if (sub === "publish") {
      const panel = (interaction.options.getString("panel") ?? "all") as PanelKind;
      let targetChannelId: string | undefined;
      const picked = interaction.options.getChannel("channel");
      if (picked) {
        if (!(picked instanceof GuildChannel) || picked.guildId !== guildId) {
          throw new AppError({ code: "WRONG_GUILD_CHANNEL", friendly: "❌ Please provide a channel from this server." });
        }
        if (picked.type !== ChannelType.GuildText) {
          throw new AppError({ code: "NOT_A_TEXT_CHANNEL", friendly: "❌ That channel must be a text channel." });
        }
        targetChannelId = picked.id;
      }
      const channelId = await publishTicketPanel(guildId, panel, targetChannelId);
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.success, settings.marketplaceName)
            .setTitle("✅ Panel published")
            .setDescription(`The panel is now live in <#${channelId}>.`),
        ],
      });
      return;
    }

    if (Object.keys(patch).length > 0) {
      await updateSettings(guildId, patch);
    }
    await interaction.reply({
      embeds: [baseEmbed(COLORS.success, settings.marketplaceName).setTitle("✅ Configuration updated").setDescription(summary || "No changes.")],
      ephemeral: true,
    });
  },
};
