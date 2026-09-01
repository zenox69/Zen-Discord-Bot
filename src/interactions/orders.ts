import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GuildMember,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { CUSTOM_ID_PREFIX, cid } from "../config/constants.js";
import { prisma } from "../database/prisma.js";
import { findSettings } from "../services/GuildSettingsService.js";
import {
  buildOrderModal,
  buildReview,
  cancelOrder,
  claimOrder,
  handleBack,
  handleCommunitySelect,
  handleProductSelect,
  parsePriceInput,
  setOrderPrice,
  submitOrder,
  submitOrderModal,
  applyStatus,
  type EditableMessage,
  type FormCtx,
} from "../services/OrderService.js";
import { AppError } from "../utils/errors.js";
import { clearDefer, deferEphemeral } from "../utils/interactionReply.js";
import type { InteractionContext } from "../handlers/interactionHandler.js";

/**
 * Order form + staff control interactions.
 * All state is re-read from the database on every click (the custom id only
 * carries an opaque id, never business state).
 */

type FormInteraction = ButtonInteraction | StringSelectMenuInteraction;

function requiredPart(ctx: InteractionContext, index: number): string {
  const part = ctx.parts[index];
  if (!part) {
    throw new AppError({
      code: "INVALID_CUSTOM_ID",
      friendly: "❌ This control is invalid or expired. Reopen the current order view.",
      expected: false,
    });
  }
  return part;
}

async function getFormContext(interaction: FormInteraction): Promise<{ ctx: FormCtx; message: EditableMessage }> {
  const guildId = interaction.guildId;
  if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This can only be used in a server." });
  const channel = interaction.channel;
  if (!channel || channel.partial) throw new AppError({ code: "NO_CHANNEL", friendly: "❌ Channel context lost.", expected: false });
  const message = interaction.message;
  if (!message) throw new AppError({ code: "MSG_GONE", friendly: "❌ The form message no longer exists. Please open a new ticket.", expected: false });
  const member = interaction.member instanceof GuildMember ? interaction.member : undefined;
  const settings = await findSettings(guildId);
  const ctx: FormCtx = { guildId, channelId: channel.id, actorId: interaction.user.id, member, settings };
  const editable: EditableMessage = { edit: (o) => message.edit(o) };
  return { ctx, message: editable };
}

async function getStaffContext(interaction: ButtonInteraction | ModalSubmitInteraction): Promise<FormCtx> {
  const guildId = interaction.guildId;
  if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This can only be used in a server." });
  const channel = interaction.channel;
  if (!channel || channel.partial) throw new AppError({ code: "NO_CHANNEL", friendly: "❌ Channel context lost.", expected: false });
  const member = interaction.member instanceof GuildMember ? interaction.member : undefined;
  const settings = await findSettings(guildId);
  return { guildId, channelId: channel.id, actorId: interaction.user.id, member, settings };
}

// ---------------------------------------------------------------------------
// Form steps
// ---------------------------------------------------------------------------

export async function handleSelectProduct(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isStringSelectMenu()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const { ctx: formCtx, message } = await getFormContext(interaction);
  const value = interaction.values[0];
  if (!value) throw new AppError({ code: "NO_VALUE", friendly: "❌ No product selected." });
  await handleProductSelect(Number(ctx.parts[0]), value, formCtx, message);
}

export async function handleSelectCommunity(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isStringSelectMenu()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const { ctx: formCtx, message } = await getFormContext(interaction);
  const value = interaction.values[0];
  if (!value) throw new AppError({ code: "NO_VALUE", friendly: "❌ No community selected." });
  // Eligibility gate does a live Roblox sync — defer so the 3-second
  // window can't drop the response; the form message itself carries the UI.
  await deferEphemeral(interaction);
  try {
    await handleCommunitySelect(Number(ctx.parts[0]), value, formCtx, message);
  } finally {
    await clearDefer(interaction);
  }
}

export async function handleContinue(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isButton()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const { ctx: formCtx } = await getFormContext(interaction);
  const order = await prisma.order.findUnique({
    where: { id: Number(ctx.parts[0]) },
    include: { product: true, community: true, ticket: true },
  });
  if (!order || order.status !== "DRAFT") throw new AppError({ code: "ORDER_GONE", friendly: "❌ This order no longer exists in draft." });
  if (order.discordUserId !== formCtx.actorId) {
    throw new AppError({ code: "NOT_ALLOWED", friendly: "❌ Only the customer who opened this ticket can continue the order form." });
  }
  await interaction.showModal(buildOrderModal(order));
}

export async function handleOrderModal(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isModalSubmit()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const guildId = interaction.guildId;
  if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This can only be used in a server." });
  const channel = interaction.channel;
  if (!channel || channel.partial) throw new AppError({ code: "NO_CHANNEL", friendly: "❌ Channel context lost.", expected: false });
  const member = interaction.member instanceof GuildMember ? interaction.member : undefined;
  const settings = await findSettings(guildId);
  const formCtx: FormCtx = { guildId, channelId: channel.id, actorId: interaction.user.id, member, settings };

  const orderId = Number(ctx.parts[0]);
  const quantity = interaction.fields.getTextInputValue("quantity");
  const details = interaction.fields.getTextInputValue("details") || null;
  const preferred = interaction.fields.getTextInputValue("preferred") || null;
  const notes = interaction.fields.getTextInputValue("notes") || null;

  await submitOrderModal(orderId, { quantity, details, preferred, notes }, formCtx);
  const review = await buildReview(orderId);
  await interaction.reply({ content: "📝 **ORDER FORM**\n\n**Step 4 of 4:** Review your order.", embeds: review.embeds, components: review.components });
}

export async function handleBackOrder(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isButton()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const { ctx: formCtx, message } = await getFormContext(interaction);
  await handleBack(Number(ctx.parts[0]), ctx.parts[1] ?? "1", formCtx, message);
}

export async function handleSubmitOrder(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isButton()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const { ctx: formCtx, message } = await getFormContext(interaction);
  const orderId = Number(ctx.parts[0]);
  const result = await submitOrder(orderId, formCtx);
  if (!result.ok) {
    // Final revalidation failed — the draft is kept; offer recovery actions.
    await message.edit({
      content: [
        "📝 **ORDER FORM**",
        "",
        "❌ **ELIGIBILITY CHANGED**",
        "You are no longer currently eligible for this community.",
        "Your order has **not** been submitted.",
        "",
        `Community: **${result.communityName}**`,
        `Current status: **${result.detail}**`,
      ].join("\n"),
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(cid(CUSTOM_ID_PREFIX.order, "back", orderId, "2")).setLabel("Choose Another Community").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(cid(CUSTOM_ID_PREFIX.order, "cancel", orderId)).setLabel("Cancel Order").setStyle(ButtonStyle.Danger),
        ),
      ],
      embeds: [],
    });
    return;
  }
  await message.edit({
    content: "✅ **Order submitted!** A staff member will review it shortly. Track progress on the order card.",
    components: [],
    embeds: [],
  });
}

export async function handleCancelForm(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isButton()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const { ctx: formCtx, message } = await getFormContext(interaction);
  // Step-1 buttons embed a ticket ref ("ticket:<id>"), which the colon-split
  // custom-id grammar delivers as two parts; later steps pass a bare order id.
  const [kind, kindId] = ctx.parts;
  await cancelOrder(kind === "ticket" ? `ticket:${kindId}` : (kind ?? "ticket:0"), formCtx);
  await message.edit({ content: "❌ Order cancelled. If you need anything else, open a new ticket or ask staff.", components: [], embeds: [] });
}

// ---------------------------------------------------------------------------
// Staff controls
// ---------------------------------------------------------------------------

export async function handleClaim(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isButton()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const formCtx = await getStaffContext(interaction);
  await claimOrder(Number(ctx.parts[0]), formCtx);
  await interaction.reply({ content: "✅ Order claimed.", ephemeral: true });
}

export async function openSetPriceModal(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isButton()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(cid(CUSTOM_ID_PREFIX.order, "set-price", requiredPart(ctx, 0)))
      .setTitle("Set Order Price")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("price")
            .setLabel("New price")
            .setPlaceholder("e.g. 500")
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
      ),
  );
}

export async function submitSetPriceModal(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isModalSubmit()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const formCtx = await getStaffContext(interaction);
  const orderId = Number(ctx.parts[0]);
  const raw = interaction.fields.getTextInputValue("price") ?? "";
  const price = parsePriceInput(raw);
  await setOrderPrice(orderId, price, formCtx);
  await interaction.reply({ content: `✅ Price set to **${price}**.`, ephemeral: true });
}

const STATUS_TARGET = { paid: "PAID", await: "AWAITING_PAYMENT", start: "IN_PROGRESS", ready: "READY" } as const;

export async function handleStatus(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isButton()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const key = ctx.parts[0];
  const orderId = Number(ctx.parts[1]);
  const formCtx = await getStaffContext(interaction);

  if (key === "complete") {
    await interaction.reply({
      content: "Are you sure you want to **complete** this order? This is final.",
      ephemeral: true,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(cid(CUSTOM_ID_PREFIX.order, "confirm-complete", orderId))
            .setLabel("Yes, Complete")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(cid(CUSTOM_ID_PREFIX.order, "noop")).setLabel("No").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return;
  }

  const to = STATUS_TARGET[key as keyof typeof STATUS_TARGET];
  if (!to) throw new AppError({ code: "BAD_ACTION", friendly: "❌ Unknown status action." });
  await applyStatus(orderId, to, formCtx);
  await interaction.reply({ content: `✅ Order marked **${to}**.`, ephemeral: true });
}

export async function handleConfirmComplete(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isButton()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const formCtx = await getStaffContext(interaction);
  await applyStatus(Number(ctx.parts[0]), "COMPLETED", formCtx);
  await interaction.update({ content: "✅ Order completed. Nice work!", components: [] });
}

export async function openCancelOrderModal(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isButton()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(cid(CUSTOM_ID_PREFIX.order, "cancel-reason", requiredPart(ctx, 0)))
      .setTitle("Cancel Order")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("reason")
            .setLabel("Cancellation reason")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(200)
            .setRequired(true),
        ),
      ),
  );
}

export async function submitCancelOrderModal(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isModalSubmit()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const formCtx = await getStaffContext(interaction);
  const reason = (interaction.fields.getTextInputValue("reason") ?? "").trim().slice(0, 200);
  await cancelOrder(ctx.parts[0] ?? "", formCtx, reason);
  await interaction.reply({ content: `✅ Order cancelled — **${reason}**`, ephemeral: true });
}

export async function handleNoop(_ctx: InteractionContext): Promise<void> {
  const interaction = _ctx.interaction;
  if (!interaction.isButton()) return;
  await interaction.update({ content: "✅ Kept as is.", components: [] });
}
