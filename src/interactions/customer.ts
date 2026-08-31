import { GuildMember } from "discord.js";
import { AppError } from "../utils/errors.js";
import { isStaff } from "../utils/permissions.js";
import { findSettings } from "../services/GuildSettingsService.js";
import { buildOrderHistory } from "../services/CustomerService.js";
import type { InteractionContext } from "../handlers/interactionHandler.js";

export async function showOrderHistory(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isButton()) {
    throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  }
  const guildId = interaction.guildId;
  const targetId = ctx.parts[0];
  const page = Number(ctx.parts[1] ?? 1);
  if (!guildId || !targetId) {
    throw new AppError({
      code: "INVALID_HISTORY_TARGET",
      friendly: "❌ This order-history control is invalid or expired.",
      expected: false,
    });
  }

  if (targetId !== interaction.user.id) {
    const settings = await findSettings(guildId);
    const member = interaction.member;
    if (!settings || !(member instanceof GuildMember) || !isStaff(member, settings)) {
      throw new AppError({
        code: "NOT_STAFF",
        friendly: "❌ Only staff can view another customer's order history.",
      });
    }
  }

  const view = await buildOrderHistory(
    guildId,
    targetId,
    Number.isFinite(page) ? page : 1,
  );
  await interaction.update(view);
}
