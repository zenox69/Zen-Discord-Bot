import { SlashCommandBuilder } from "@discordjs/builders";
import {
  addProduct,
  editProduct,
  listProducts,
  setProductEnabled,
} from "../../services/ProductService.js";
import { openBulkModal } from "../../interactions/product.js";
import { findSettings } from "../../services/GuildSettingsService.js";
import { baseEmbed, COLORS, trunc } from "../../utils/embeds.js";
import { formatMoney } from "../../utils/discordTime.js";
import { AppError } from "../../utils/errors.js";
import type { MarketplaceCommand } from "../../handlers/commandHandler.js";

export const productCommand: MarketplaceCommand = {
  requireAdmin: true,
  data: new SlashCommandBuilder()
    .setName("product")
    .setDescription("Manage marketplace products (admin)")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Add a product")
        .addStringOption((o) => o.setName("name").setDescription("Product name").setRequired(true).setMaxLength(60))
        .addStringOption((o) => o.setName("description").setDescription("What the product includes").setRequired(true).setMaxLength(1000))
        .addNumberOption((o) => o.setName("price").setDescription("Base price").setRequired(true).setMinValue(0))
        .addStringOption((o) => o.setName("category").setDescription("Category (e.g. Services)").setMaxLength(60))
        .addBooleanOption((o) => o.setName("requires-eligibility").setDescription("Require community eligibility (default true)"))
        .addIntegerOption((o) => o.setName("min-quantity").setDescription("Minimum quantity (default 1)").setMinValue(1))
        .addIntegerOption((o) => o.setName("max-quantity").setDescription("Maximum quantity (default unlimited)").setMinValue(1))
        .addStringOption((o) => o.setName("communities").setDescription("Restrict to communities (comma-separated names, optional)")),
    )
    .addSubcommand((sub) =>
      sub
        .setName("bulk")
        .setDescription("Add many products at once via a form (one per line: Name: price, max 25)")
        .addStringOption((o) => o.setName("category").setDescription("Category for all added (default General)").setMaxLength(60))
        .addBooleanOption((o) => o.setName("requires-eligibility").setDescription("Require community eligibility for all added (default true)"))
        .addStringOption((o) => o.setName("communities").setDescription("Restrict all added to communities (comma-separated, optional)")),
    )
    .addSubcommand((sub) =>
      sub
        .setName("edit")
        .setDescription("Edit a product")
        .addStringOption((o) => o.setName("product").setDescription("Product name").setRequired(true))
        .addStringOption((o) => o.setName("name").setDescription("New name").setMaxLength(60))
        .addStringOption((o) => o.setName("description").setDescription("New description").setMaxLength(1000))
        .addStringOption((o) => o.setName("category").setDescription("New category").setMaxLength(60))
        .addNumberOption((o) => o.setName("price").setDescription("New price").setMinValue(0))
        .addBooleanOption((o) => o.setName("requires-eligibility").setDescription("New eligibility requirement"))
        .addIntegerOption((o) => o.setName("min-quantity").setDescription("New minimum quantity").setMinValue(1))
        .addIntegerOption((o) => o.setName("max-quantity").setDescription("New maximum quantity (0 = unlimited)").setMinValue(0))
        .addStringOption((o) => o.setName("communities").setDescription("Replace community restrictions (comma-separated, empty = all)")),
    )
    .addSubcommand((sub) =>
      sub
        .setName("enable")
        .setDescription("Enable a product")
        .addStringOption((o) => o.setName("product").setDescription("Product name").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("disable")
        .setDescription("Disable a product")
        .addStringOption((o) => o.setName("product").setDescription("Product name").setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("List all products")),
  execute: async (interaction) => {
    const guildId = interaction.guildId;
    if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This command requires a server." });
    const settings = await findSettings(guildId);
    if (!settings) throw new AppError({ code: "NOT_CONFIGURED", friendly: "❌ This server is not set up yet." });
    const sub = interaction.options.getSubcommand();

    if (sub === "add") {
      const communitiesRaw = interaction.options.getString("communities");
      const communities = communitiesRaw
        ? communitiesRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
      const p = await addProduct(
        guildId,
        interaction.user.id,
        {
          name: interaction.options.getString("name") ?? "",
          description: interaction.options.getString("description") ?? "",
          category: interaction.options.getString("category"),
          price: interaction.options.getNumber("price") ?? 0,
          requiresEligibility: interaction.options.getBoolean("requires-eligibility"),
          minQuantity: interaction.options.getInteger("min-quantity"),
          maxQuantity: interaction.options.getInteger("max-quantity"),
          communityNames: communities,
        },
        settings,
      );
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.success, settings.marketplaceName)
            .setTitle("✅ Product added")
            .setDescription(
              `**${p.name}** (${p.category}) — ${formatMoney(Number(p.price), settings.currencySymbol)} • ${p.requiresEligibility ? "eligibility required" : "no eligibility required"}${communities.length ? ` • restricted to ${communities.length} community(ies)` : " • all communities"}`,
            ),
        ],
      });
      return;
    }

    if (sub === "bulk") {
      const communitiesRaw = interaction.options.getString("communities");
      const communities = communitiesRaw ? communitiesRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
      await openBulkModal(interaction, {
        category: interaction.options.getString("category"),
        requiresEligibility: interaction.options.getBoolean("requires-eligibility"),
        communityNames: communities,
      });
      return;
    }

    if (sub === "edit") {
      const p = await editProduct(guildId, interaction.user.id, interaction.options.getString("product") ?? "", {
        name: interaction.options.getString("name"),
        description: interaction.options.getString("description"),
        category: interaction.options.getString("category"),
        price: interaction.options.getNumber("price"),
        requiresEligibility: interaction.options.getBoolean("requires-eligibility"),
        minQuantity: interaction.options.getInteger("min-quantity"),
        maxQuantity: interaction.options.getInteger("max-quantity") ?? undefined,
        communityNames: interaction.options.getString("communities")
          ? interaction.options
              .getString("communities")!
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
      });
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.success, settings.marketplaceName)
            .setTitle("✅ Product updated")
            .setDescription(`**${p.name}** — ${formatMoney(Number(p.price), settings.currencySymbol)} • ${p.enabled ? "enabled" : "disabled"}`),
        ],
      });
      return;
    }

    if (sub === "enable" || sub === "disable") {
      const p = await setProductEnabled(guildId, interaction.user.id, interaction.options.getString("product") ?? "", sub === "enable");
      await interaction.reply({
        embeds: [
          baseEmbed(p.enabled ? COLORS.success : COLORS.warning, settings.marketplaceName)
            .setTitle(p.enabled ? "✅ Product enabled" : "⏸️ Product disabled")
            .setDescription(`**${p.name}** is now ${p.enabled ? "enabled" : "disabled"}.`),
        ],
      });
      return;
    }

    const products = await listProducts(guildId);
    const embed = baseEmbed(COLORS.info, settings.marketplaceName).setTitle("🛒 Products");
    if (products.length === 0) {
      embed.setDescription("None yet. Use `/product add` to create your first product.");
    } else {
      embed.setDescription(
        trunc(
          products
            .map((p) => {
              const c = p.communities;
              return `${p.enabled ? "✅" : "⏸️"} **${p.name}** (${p.category}) — ${formatMoney(Number(p.price), settings.currencySymbol)} • ${p.requiresEligibility ? "eligibility" : "no eligibility"}${c.length ? ` • ${c.map((x) => x.community.name).join(", ")}` : " • all communities"}`;
            })
            .join("\n"),
          4000,
        ),
      );
    }
    await interaction.reply({ embeds: [embed] });
  },
};
