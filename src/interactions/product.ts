import { randomBytes } from "node:crypto";
import {
  ActionRowBuilder,
  type ChatInputCommandInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { CUSTOM_ID_PREFIX, cid } from "../config/constants.js";
import { registerInteraction, type InteractionContext } from "../handlers/interactionHandler.js";
import { findSettings } from "../services/GuildSettingsService.js";
import { addProductsBulk, parseBulkLines } from "../services/ProductService.js";
import { baseEmbed, COLORS, trunc } from "../utils/embeds.js";
import { formatMoney } from "../utils/discordTime.js";
import { AppError } from "../utils/errors.js";
import { getInteractionMember, requireAdmin } from "../utils/permissions.js";

/**
 * /product bulk opens a modal (multi-line text input) because slash-command
 * string options are single-line. The command's extra options are carried in
 * a short-lived in-memory state keyed by a random token embedded in the
 * modal's custom id; the list of products themselves comes from the modal.
 */

interface BulkPending {
  guildId: string;
  actorId: string;
  createdAt: number;
  category: string | null;
  requiresEligibility: boolean | null;
  communityNames: string[];
}

const PENDING_TTL_MS = 15 * 60_000;
const pendingBulk = new Map<string, BulkPending>();

function sweepPending(): void {
  const now = Date.now();
  for (const [token, entry] of pendingBulk) {
    if (now - entry.createdAt > PENDING_TTL_MS) pendingBulk.delete(token);
  }
}

export async function openBulkModal(
  interaction: ChatInputCommandInteraction,
  options: { category: string | null; requiresEligibility: boolean | null; communityNames: string[] },
): Promise<void> {
  sweepPending();
  const token = randomBytes(8).toString("hex");
  if (!interaction.guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This action requires a server." });
  pendingBulk.set(token, { createdAt: Date.now(), guildId: interaction.guildId, actorId: interaction.user.id, ...options });
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(cid(CUSTOM_ID_PREFIX.product, "bulk", token))
      .setTitle("Bulk Add Products")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("lines")
            .setLabel("Products (one per line)")
            .setPlaceholder("Starter Pack: 4.99\nPro Pack: 12.99\nCustom Avatar: 25")
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(4000)
            .setRequired(true),
        ),
      ),
  );
}

export async function submitBulkModal(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isModalSubmit()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const guildId = interaction.guildId;
  if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This can only be used in a server." });

  sweepPending();
  const pending = pendingBulk.get(ctx.parts[0] ?? "");
  if (!pending) {
    await interaction.reply({
      content: "❌ That bulk form has expired or was already submitted. Run `/product bulk` again.",
      ephemeral: true,
    });
    return;
  }
  const settings = await findSettings(guildId);
  if (!settings) throw new AppError({ code: "NOT_CONFIGURED", friendly: "❌ This server is not set up yet." });
  if (!settings.enabled) throw new AppError({ code: "MARKETPLACE_DISABLED", friendly: "❌ The marketplace is disabled." });
  if (pending.guildId !== guildId || pending.actorId !== interaction.user.id) {
    throw new AppError({ code: "NOT_ALLOWED", friendly: "❌ This form belongs to another user or server." });
  }
  requireAdmin(await getInteractionMember(interaction), settings);
  // Recheck after the REST permission request: concurrent submissions may
  // both have read the pending form before the first one consumed it.
  if (!pendingBulk.delete(ctx.parts[0]!)) throw new AppError({ code: "STALE_MODAL", friendly: "❌ This form was already submitted." });

  const lines = interaction.fields.getTextInputValue("lines") ?? "";
  const { entries, failures: parseFailures } = parseBulkLines(lines);
  if (entries.length === 0) {
    const shown = parseFailures.slice(0, 10);
    const detail = [
      "No valid products found. Use one product per line: `Name: price` (e.g. `Starter Pack: 4.99`).",
      ...shown.map((f) => (f.line > 0 ? `Line ${f.line}: ${f.reason}` : f.reason)),
      parseFailures.length > 10 ? `…and ${parseFailures.length - 10} more.` : "",
    ]
      .filter(Boolean)
      .join("\n");
    await interaction.reply({
      embeds: [baseEmbed(COLORS.error, settings.marketplaceName).setTitle("❌ Nothing to add").setDescription(detail)],
    });
    return;
  }

  const { added, failed } = await addProductsBulk(guildId, interaction.user.id, entries, pending, settings);
  const addedList = trunc(
    added.map((p) => `✅ **${p.name}** — ${formatMoney(Number(p.price), settings.currencySymbol)}`).join("\n"),
    3000,
  );
  const failedList = failed.length
    ? `\n\n**Skipped (${failed.length}):**\n${trunc(failed.map((f) => `⚠️ Line ${f.line}: ${f.reason}`).join("\n"), 1000)}`
    : "";
  await interaction.reply({
    embeds: [
      baseEmbed(COLORS.success, settings.marketplaceName)
        .setTitle(`✅ Added ${added.length} product${added.length === 1 ? "" : "s"}`)
        .setDescription(`${addedList}${failedList}`),
    ],
  });
}

export function registerProductInteractions(): void {
  registerInteraction(CUSTOM_ID_PREFIX.product, "bulk", ["modal"], submitBulkModal);
}
