import {
  AuditCategory,
  OrderStatus,
  Prisma,
  type GuildSettings,
  type Order,
  type Product,
  type RobloxCommunity,
  type Ticket,
} from "@prisma/client";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type GuildMember,
  type Message,
} from "discord.js";
import { CUSTOM_ID_PREFIX, LIMITS, cid } from "../config/constants.js";
import { prisma } from "../database/prisma.js";
import { audit } from "./AuditService.js";
import { findSettings } from "./GuildSettingsService.js";
import { getCommunityEligibility, eligibilityStatusLabel, type EligibilityEntry } from "./EligibilityService.js";
import { isSendableChannel, type SendableChannel } from "../utils/channel.js";
import { baseEmbed, COLORS, type EmbedColor } from "../utils/embeds.js";
import { AppError, isRobloxApiError } from "../utils/errors.js";
import { formatMoney, tDate, tDateTime } from "../utils/discordTime.js";
import { getBotClient } from "../utils/botClient.js";
import { isAdmin, isStaff } from "../utils/permissions.js";
import { rateLimiter, retryPhrase } from "../utils/rateLimiter.js";
import { sanitizeInput, zeroPad } from "../utils/text.js";

/**
 * OrderService — order form state machine + order lifecycle.
 *
 * A DRAFT order row is created the moment a customer picks a product; every
 * later step mutates that row, so the form survives bot restarts (the DB is
 * the source of truth). The persistent order embed is EDITED in place on
 * every status change via orderMessageId.
 */

export type OrderWithRelations = Order & {
  product: Product;
  community: RobloxCommunity | null;
  ticket: Ticket | null;
};

export interface FormCtx {
  guildId: string;
  channelId: string;
  actorId: string;
  member?: GuildMember;
  settings: GuildSettings | null;
}

export interface EditableMessage {
  edit: (options: {
    content?: string;
    embeds?: EmbedBuilder[];
    components?: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
  }) => Promise<unknown>;
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  DRAFT: "📝 DRAFT",
  SUBMITTED: "📨 SUBMITTED",
  STAFF_REVIEW: "🔍 STAFF REVIEW",
  QUOTED: "💬 QUOTED",
  AWAITING_PAYMENT: "💳 AWAITING PAYMENT",
  PAID: "✅ PAID",
  IN_PROGRESS: "🔨 IN PROGRESS",
  READY: "📦 READY",
  COMPLETED: "✅ COMPLETED",
  CANCELLED: "❌ CANCELLED",
  REFUNDED: "↩️ REFUNDED",
};

export { canTransition, TRANSITIONS } from "./orderTransitions.js";
import { ACTIVE_ORDER_STATUSES, canTransition } from "./orderTransitions.js";

async function fetchOrder(orderId: number): Promise<OrderWithRelations | null> {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: { product: true, community: true, ticket: true },
  });
}

function isStaffActor(ctx: FormCtx): boolean {
  return !!ctx.member && !!ctx.settings && isStaff(ctx.member, ctx.settings);
}

function isActorAdmin(ctx: FormCtx): boolean {
  return !!ctx.member && !!ctx.settings && isAdmin(ctx.member, ctx.settings);
}

/** Customer-form permission: ticket owner only — staff must not order for a customer. */
function assertFormAccess(order: OrderWithRelations, ctx: FormCtx): void {
  if (order.guildId !== ctx.guildId) {
    throw new AppError({ code: "WRONG_GUILD", friendly: "❌ This order belongs to a different server.", expected: false });
  }
  if (order.ticket?.channelId && order.ticket.channelId !== ctx.channelId) {
    throw new AppError({ code: "WRONG_CHANNEL", friendly: "❌ Use the buttons in your own ticket.", expected: false });
  }
  if (order.discordUserId !== ctx.actorId) {
    throw new AppError({ code: "NOT_ALLOWED", friendly: "❌ Only the customer who opened this ticket can fill this form." });
  }
}

/**
 * Claim ownership: once an order is claimed, only the ASSIGNED staff member
 * or an administrator may modify it (price, status, cancel). Other staff are
 * blocked. Orders are claimed via claimOrder; unassigned SUBMITTED orders
 * accept a claim from any staff member there.
 */
function assertStaffCanManage(order: OrderWithRelations, ctx: FormCtx): void {
  if (!isStaffActor(ctx)) throw new AppError({ code: "NOT_STAFF", friendly: "❌ Only staff can modify orders." });
  if (isActorAdmin(ctx)) return;
  if (order.assignedStaffId === ctx.actorId) return;
  if (order.assignedStaffId) {
    throw new AppError({
      code: "NOT_ASSIGNED",
      friendly: `❌ This order is assigned to <@${order.assignedStaffId}>. Only they (or an administrator) can modify it.`,
    });
  }
  throw new AppError({ code: "NOT_ASSIGNED", friendly: "❌ Claim the order before modifying it." });
}

/**
 * Strict money input: digits with at most 2 decimals, plain and unsigned.
 * Accepts 500, 500.00, 0, 0.50, 1250.5 — rejects abc, 500abc, ₱500, "..",
 * 1.2.3, "-", empty, and anything Number() cannot represent finitely.
 * Capped at the Decimal(10,2) column limit.
 */
export const MAX_ORDER_PRICE = 99_999_999.99;

export function parsePriceInput(raw: string): number {
  const text = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new AppError({ code: "INVALID_PRICE", friendly: "❌ Invalid price. Enter a plain number like **500** or **500.50** (no currency symbols, at most 2 decimals)." });
  }
  const price = Number(text);
  if (!Number.isFinite(price) || price < 0) {
    throw new AppError({ code: "INVALID_PRICE", friendly: "❌ Invalid price. Enter a plain number like **500** or **500.50**." });
  }
  if (price > MAX_ORDER_PRICE) {
    throw new AppError({ code: "INVALID_PRICE", friendly: `❌ Price is too large — the maximum is **${MAX_ORDER_PRICE.toLocaleString("en-US", { minimumFractionDigits: 2 })}**.` });
  }
  return price;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function orderStatusColor(status: OrderStatus): EmbedColor {
  if (status === "COMPLETED" || status === "PAID") return COLORS.success;
  if (status === "CANCELLED" || status === "REFUNDED") return COLORS.error;
  if (status === "SUBMITTED" || status === "DRAFT") return COLORS.info;
  return COLORS.warning;
}

function eligibilitySummary(order: OrderWithRelations): string {
  const snap = (order.eligibilitySnapshot ?? null) as { status?: string; eligibleAt?: string } | null;
  if (!snap) return order.product.requiresEligibility ? "⚪ Not checked" : "➖ Not required";
  if (snap.status === "ELIGIBLE") return "✅ Verified";
  if (snap.status === "NOT_ELIGIBLE") return `⏳ Pending (${snap.eligibleAt ? tDate(new Date(snap.eligibleAt)) : ""})`;
  return "❓ " + snap.status;
}

export async function renderOrderEmbed(order: OrderWithRelations): Promise<EmbedBuilder> {
  const settings = await findSettings(order.guildId);
  const symbol = settings?.currencySymbol ?? "₱";
  const embed = baseEmbed(orderStatusColor(order.status), settings?.marketplaceName).setTitle(`📦 ORDER #${order.number || "—"}`);
  const lines: Array<[string, string]> = [
    ["Customer", `<@${order.discordUserId}>`],
    ["Roblox", order.robloxUsername ? `@${order.robloxUsername}` : "—"],
    ["Product", order.product.name],
    ["Community", order.community?.name ?? "—"],
    ["Eligibility", eligibilitySummary(order)],
    ["Quantity", String(order.quantity)],
    ["Price", formatMoney(Number(order.price), symbol)],
    ["Status", STATUS_LABEL[order.status]],
  ];
  if (order.assignedStaffId) lines.push(["Assigned Staff", `<@${order.assignedStaffId}>`]);
  lines.push(["Created", tDateTime(order.createdAt)]);
  if (order.cancelReason) lines.push(["Cancel Reason", order.cancelReason]);
  embed.addFields(...lines.map(([name, value]) => ({ name, value, inline: false })));
  return embed;
}

/**
 * State-aware staff controls: only valid actions for the current status.
 * Backend validation in the service layer remains the authority — hidden
 * buttons are UX, not security.
 *
 * SUBMITTED        [Claim] [Cancel]
 * STAFF_REVIEW     [Set Price] [Cancel]
 * QUOTED           [Edit Price] [Await Payment] [Cancel]
 * AWAITING_PAYMENT [Edit Price] [Mark Paid] [Cancel]
 * PAID             [Start] [Cancel]
 * IN_PROGRESS      [Ready] [Cancel]
 * READY            [Complete] [Cancel]
 * COMPLETED / CANCELLED / REFUNDED — no order workflow buttons (Close only)
 */
export function buildOrderStaffControls(order: OrderWithRelations): ActionRowBuilder<ButtonBuilder>[] {
  const b = (action: string, label: string, emoji: string, style: ButtonStyle) =>
    new ButtonBuilder()
      .setCustomId(cid(CUSTOM_ID_PREFIX.order, action, order.id))
      .setLabel(label)
      .setEmoji(emoji)
      .setStyle(style);

  const workflow: ButtonBuilder[] = (() => {
    const cancel = () => b("cancel-order", "Cancel", "❌", ButtonStyle.Danger);
    switch (order.status) {
      case "SUBMITTED":
        return [b("claim", "Claim", "👤", ButtonStyle.Primary), cancel()];
      case "STAFF_REVIEW":
        return [b("set-price", "Set Price", "💰", ButtonStyle.Secondary), cancel()];
      case "QUOTED":
        return [b("set-price", "Edit Price", "💰", ButtonStyle.Secondary), b("status:await", "Await Payment", "💳", ButtonStyle.Secondary), cancel()];
      case "AWAITING_PAYMENT":
        return [b("set-price", "Edit Price", "💰", ButtonStyle.Secondary), b("status:paid", "Mark Paid", "✅", ButtonStyle.Success), cancel()];
      case "PAID":
        return [b("status:start", "Start", "🔨", ButtonStyle.Secondary), cancel()];
      case "IN_PROGRESS":
        return [b("status:ready", "Ready", "📦", ButtonStyle.Secondary), cancel()];
      case "READY":
        return [b("status:complete", "Complete", "✅", ButtonStyle.Success), cancel()];
      default:
        return [];
    }
  })();

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (workflow.length > 0) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...workflow));
  }
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      order.ticket
        ? new ButtonBuilder()
            .setCustomId(cid(CUSTOM_ID_PREFIX.ticket, "close", order.ticket.id))
            .setLabel(ACTIVE_ORDER_STATUSES.has(order.status) ? "Admin Close" : "Close")
            .setEmoji("🔒")
            .setStyle(ButtonStyle.Danger)
        : new ButtonBuilder().setCustomId(cid(CUSTOM_ID_PREFIX.order, "noop", "0")).setLabel("Close").setEmoji("🔒").setStyle(ButtonStyle.Danger).setDisabled(true),
    ),
  );
  return rows;
}

async function refreshOrderMessage(order: OrderWithRelations): Promise<void> {
  if (!order.orderMessageId || !order.ticket?.channelId) return;
  const client = getBotClient();
  const fetched = await client.channels.fetch(order.ticket.channelId).catch(() => null);
  if (!isSendableChannel(fetched)) return;
  const channel = fetched as typeof fetched & {
    messages?: { fetch: (id: string) => Promise<Message | null> };
  };
  if (!channel.messages) return;
  const message = await channel.messages.fetch(order.orderMessageId).catch(() => null);
  if (!message) return;
  await message.edit({ embeds: [await renderOrderEmbed(order)], components: buildOrderStaffControls(order) }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Step 1 — product selection
// ---------------------------------------------------------------------------

export async function startOrderForm(channel: SendableChannel, ticket: Ticket): Promise<void> {
  const settings = await findSettings(ticket.guildId);
  if (!settings) return;

  const products = await prisma.product.findMany({
    where: { guildId: ticket.guildId, enabled: true },
    orderBy: { name: "asc" },
  });
  if (products.length === 0) {
    await channel
      .send({ content: "📝 **ORDER FORM**\n\nNo products are available right now. Please check back later or ping a staff member." })
      .catch(() => undefined);
    return;
  }

  await prisma.order.deleteMany({ where: { ticketId: ticket.id, status: "DRAFT" } });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(cid(CUSTOM_ID_PREFIX.order, "select-product", ticket.id))
    .setPlaceholder("Select Product")
    .addOptions(
      products.slice(0, 25).map((p) => ({
        label: p.name.slice(0, 100),
        value: String(p.id),
        description: `${p.category} • ${formatMoney(Number(p.price), settings.currencySymbol)}`.slice(0, 100),
      })),
    );

  await channel
    .send({
      content: "📝 **ORDER FORM**\n\n**Step 1 of 4:** Select a product below.",
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(cid(CUSTOM_ID_PREFIX.order, "cancel", `ticket:${ticket.id}`))
            .setLabel("Cancel Order")
            .setStyle(ButtonStyle.Danger),
        ),
      ],
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Step 2 — community selection (creates the DRAFT order)
// ---------------------------------------------------------------------------

async function productMenuRowFor(ticketId: number, guildId: string): Promise<ActionRowBuilder<StringSelectMenuBuilder>> {
  const products = await prisma.product.findMany({ where: { guildId, enabled: true }, orderBy: { name: "asc" } });
  const settings = await findSettings(guildId);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(cid(CUSTOM_ID_PREFIX.order, "select-product", ticketId))
    .setPlaceholder("Select Product")
    .addOptions(
      products.slice(0, 25).map((p) => ({
        label: p.name.slice(0, 100),
        value: String(p.id),
        description: `${p.category} • ${formatMoney(Number(p.price), settings?.currencySymbol ?? "₱")}`.slice(0, 100),
      })),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export async function renderStep1(ticket: Ticket, message: EditableMessage): Promise<void> {
  await message.edit({
    content: "📝 **ORDER FORM**\n\n**Step 1 of 4:** Select a product below.",
    components: [
      await productMenuRowFor(ticket.id, ticket.guildId),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(cid(CUSTOM_ID_PREFIX.order, "cancel", `ticket:${ticket.id}`))
          .setLabel("Cancel Order")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

export async function handleProductSelect(ticketId: number, productValue: string, ctx: FormCtx, message: EditableMessage): Promise<void> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket || ticket.guildId !== ctx.guildId || ticket.channelId !== ctx.channelId) {
    throw new AppError({ code: "WRONG_CHANNEL", friendly: "❌ Use the form in your own ticket.", expected: false });
  }
  if (ticket.discordUserId !== ctx.actorId) {
    throw new AppError({ code: "NOT_ALLOWED", friendly: "❌ Only the customer who opened this ticket can select products." });
  }

  const product = await prisma.product.findUnique({ where: { id: Number(productValue) } });
  if (!product || product.guildId !== ctx.guildId || !product.enabled) {
    throw new AppError({ code: "PRODUCT_GONE", friendly: "❌ That product is no longer available. Pick another." });
  }

  await prisma.order.deleteMany({ where: { ticketId: ticket.id, status: "DRAFT" } });
  const account = await prisma.robloxAccount.findUnique({ where: { discordUserId: ticket.discordUserId } });
  const draft = await prisma.order.create({
    data: {
      guildId: ctx.guildId,
      number: null,
      ticketId: ticket.id,
      discordUserId: ticket.discordUserId,
      robloxUserId: account?.robloxUserId ?? null,
      robloxUsername: account?.robloxUsername ?? null,
      productId: product.id,
      quantity: product.minQuantity,
      price: product.price,
      currency: product.currency,
      status: "DRAFT",
    },
  });

  const links = await prisma.productCommunity.findMany({ where: { productId: product.id } });
  const communities = await prisma.robloxCommunity.findMany({
    where: {
      guildId: ctx.guildId,
      enabled: true,
      ...(links.length > 0 ? { id: { in: links.map((l) => l.communityId) } } : {}),
    },
    orderBy: { name: "asc" },
  });
  if (communities.length === 0) {
    await prisma.order.delete({ where: { id: draft.id } });
    throw new AppError({
      code: "NO_COMMUNITIES",
      friendly: "❌ No communities are currently available for that product. Please choose another product.",
    });
  }

  await message.edit({
    content: `📝 **ORDER FORM**\n\n**Step 2 of 4:** Product selected — **${product.name}**\nSelect a Roblox community below.`,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(cid(CUSTOM_ID_PREFIX.order, "select-community", draft.id))
          .setPlaceholder("Select Roblox Community")
          .addOptions(
            communities.slice(0, 25).map((c) => ({
              label: `${c.emoji ? `${c.emoji} ` : ""}${c.name}`.slice(0, 100),
              value: String(c.id),
              description: `${c.requiredDays} days required`,
            })),
          ),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(cid(CUSTOM_ID_PREFIX.order, "back", draft.id, "1")).setLabel("Back").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(cid(CUSTOM_ID_PREFIX.order, "cancel", String(draft.id))).setLabel("Cancel Order").setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

// ---------------------------------------------------------------------------
// Step 3 — eligibility gate
// ---------------------------------------------------------------------------

export async function handleCommunitySelect(orderId: number, communityValue: string, ctx: FormCtx, message: EditableMessage): Promise<void> {
  const order = await fetchOrder(orderId);
  if (!order) throw new AppError({ code: "ORDER_GONE", friendly: "❌ This order no longer exists." });
  if (order.status !== "DRAFT") throw new AppError({ code: "NOT_DRAFT", friendly: "❌ This order is no longer in draft." });
  assertFormAccess(order, ctx);

  const community = await prisma.robloxCommunity.findUnique({ where: { id: Number(communityValue) } });
  if (!community || community.guildId !== ctx.guildId || !community.enabled) {
    throw new AppError({ code: "COMMUNITY_GONE", friendly: "❌ That community is no longer available. Pick another." });
  }

  const links = await prisma.productCommunity.findMany({ where: { productId: order.productId } });
  if (links.length > 0 && !links.some((l) => l.communityId === community.id)) {
    throw new AppError({
      code: "COMMUNITY_NOT_ALLOWED",
      friendly: `❌ **${order.product.name}** is not available in **${community.name}**. Pick another community.`,
    });
  }

  await prisma.order.update({ where: { id: order.id }, data: { communityId: community.id } });

  // Products that do not require eligibility skip straight to details.
  if (!order.product.requiresEligibility) {
    await prisma.order.update({
      where: { id: order.id },
      data: {
        eligibilitySnapshot: {
          status: "NOT_REQUIRED",
          checkedAt: new Date().toISOString(),
        },
      },
    });
    await message.edit({
      content: [
        "📝 **ORDER FORM**",
        "",
        "**Step 3 of 4:** Eligibility check",
        "",
        "✅ **ELIGIBILITY NOT REQUIRED**",
        `Community: **${community.name}**`,
      ].join("\n"),
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(cid(CUSTOM_ID_PREFIX.order, "continue", order.id))
            .setLabel("Continue")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(cid(CUSTOM_ID_PREFIX.order, "back", order.id, "2"))
            .setLabel("Back")
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(cid(CUSTOM_ID_PREFIX.order, "cancel", order.id))
            .setLabel("Cancel Order")
            .setStyle(ButtonStyle.Danger),
        ),
      ],
    });
    return;
  }

  if (!order.robloxUserId) {
    await message.edit({
      content: "📝 **ORDER FORM**\n\n**Step 3 of 4:** Eligibility check\n\n❌ You must verify your Roblox account before ordering.",
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(cid(CUSTOM_ID_PREFIX.verify, "start"))
            .setLabel("Verify Roblox Account")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(cid(CUSTOM_ID_PREFIX.order, "cancel", order.id)).setLabel("Cancel Order").setStyle(ButtonStyle.Danger),
        ),
      ],
    });
    return;
  }

  // Live RoProxy sync happens inside getCommunityEligibility. A RoProxy
  // failure propagates as RobloxApiError → "services unavailable". It is
  // NEVER rendered as "not eligible".
  const entry: EligibilityEntry | null = await getCommunityEligibility(ctx.guildId, order.robloxUserId, community.id);
  const eligible = entry?.status === "ELIGIBLE";

  await prisma.order.update({
    where: { id: order.id },
    data: {
      eligibilitySnapshot: eligible
        ? { status: "ELIGIBLE", checkedAt: new Date().toISOString() }
        : entry
          ? { status: entry.status, eligibleAt: entry.eligibleAt?.toISOString() ?? null, checkedAt: new Date().toISOString() }
          : Prisma.JsonNull,
    },
  });

  if (eligible) {
    await message.edit({
      content: [
        "📝 **ORDER FORM**",
        "",
        "**Step 3 of 4:** Eligibility check",
        "",
        "✅ **ELIGIBILITY VERIFIED**",
        `Community: **${community.name}**`,
        "Status: **Eligible**",
      ].join("\n"),
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(cid(CUSTOM_ID_PREFIX.order, "continue", order.id)).setLabel("Continue").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(cid(CUSTOM_ID_PREFIX.order, "back", order.id, "2")).setLabel("Back").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(cid(CUSTOM_ID_PREFIX.order, "cancel", order.id)).setLabel("Cancel Order").setStyle(ButtonStyle.Danger),
        ),
      ],
    });
    return;
  }

  const lines = [
    "📝 **ORDER FORM**",
    "",
    "**Step 3 of 4:** Eligibility check",
    "",
    "❌ **NOT YET ELIGIBLE**",
    `Community: **${community.name}**`,
    `Required Membership: **${community.requiredDays} days**`,
  ];
  if (entry && entry.status === "NOT_ELIGIBLE" && entry.eligibleAt && entry.daysRemaining !== null) {
    lines.push(`Remaining: **${entry.daysRemaining} days**`, `Eligible: ${tDate(entry.eligibleAt)}`);
  } else if (entry && entry.status === "NOT_MEMBER") {
    lines.push("You are not a member of this community. Join it first — eligibility is tracked from your first observed membership date.");
  } else if (entry && entry.status === "STAFF_REVIEW") {
    lines.push("Staff must verify your membership start date before you can order.");
  }
  lines.push("", "The order **cannot proceed** until eligibility is met.");

  await message.edit({
    content: lines.join("\n"),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(cid(CUSTOM_ID_PREFIX.order, "back", order.id, "2")).setLabel("Choose Another Community").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(cid(CUSTOM_ID_PREFIX.order, "cancel", order.id)).setLabel("Cancel Order").setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

// ---------------------------------------------------------------------------
// Step 4 — details modal + review
// ---------------------------------------------------------------------------

export async function buildReview(orderId: number): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }> {
  const o = await fetchOrder(orderId);
  if (!o) throw new AppError({ code: "ORDER_GONE", friendly: "❌ This order no longer exists." });
  const settings = await findSettings(o.guildId);
  const symbol = settings?.currencySymbol ?? "₱";

  const notes = [o.details, o.preferredOption ? `Preferred: ${o.preferredOption}` : null, o.notes].filter(Boolean).join("\n");
  const embed = baseEmbed(COLORS.info, settings?.marketplaceName)
    .setTitle("🧾 ORDER REVIEW")
    .addFields(
      { name: "Product", value: o.product.name, inline: true },
      { name: "Community", value: o.community?.name ?? "—", inline: true },
      { name: "Quantity", value: String(o.quantity), inline: true },
      { name: "Customer", value: `<@${o.discordUserId}>`, inline: true },
      { name: "Roblox Account", value: o.robloxUsername ? `@${o.robloxUsername}` : "—", inline: true },
      { name: "Eligibility", value: o.product.requiresEligibility ? eligibilitySummary(o) : "➖ Not required", inline: true },
      { name: "Price", value: formatMoney(Number(o.price), symbol), inline: true },
      { name: "Notes", value: notes.slice(0, 1024) || "—", inline: false },
    );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(cid(CUSTOM_ID_PREFIX.order, "submit", o.id)).setLabel("Submit Order").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(cid(CUSTOM_ID_PREFIX.order, "back", o.id, "3")).setLabel("Go Back").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(cid(CUSTOM_ID_PREFIX.order, "cancel", o.id)).setLabel("Cancel").setStyle(ButtonStyle.Danger),
      ),
    ],
  };
}

export function buildOrderModal(order: OrderWithRelations): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(cid(CUSTOM_ID_PREFIX.order, "modal", order.id))
    .setTitle("Order Details")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("quantity")
          .setLabel(`Quantity (${order.product.minQuantity}-${order.product.maxQuantity ?? "unlimited"})`)
          .setPlaceholder(String(order.product.minQuantity))
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("details")
          .setLabel("Details / specifications")
          .setPlaceholder("e.g. Roblox account, server, specifics")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("preferred")
          .setLabel("Preferred option")
          .setPlaceholder("Optional — e.g. preferred variant or time")
          .setStyle(TextInputStyle.Short)
          .setRequired(false),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("notes")
          .setLabel("Notes")
          .setPlaceholder("Optional")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false),
      ),
    );
}

export async function submitOrderModal(
  orderId: number,
  values: { quantity: string; details: string | null; preferred: string | null; notes: string | null },
  ctx: FormCtx,
): Promise<void> {
  const order = await fetchOrder(orderId);
  if (!order) throw new AppError({ code: "ORDER_GONE", friendly: "❌ This order no longer exists." });
  if (order.status !== "DRAFT") throw new AppError({ code: "NOT_DRAFT", friendly: "❌ This order is no longer in draft." });
  assertFormAccess(order, ctx);

  const qty = Number(values.quantity);
  if (
    !Number.isInteger(qty) ||
    qty < order.product.minQuantity ||
    (order.product.maxQuantity !== null && qty > order.product.maxQuantity)
  ) {
    throw new AppError({
      code: "BAD_QUANTITY",
      friendly: `❌ Quantity must be a whole number between **${order.product.minQuantity}** and **${order.product.maxQuantity ?? "unlimited"}**.`,
    });
  }

  await prisma.order.update({
    where: { id: order.id },
    data: {
      quantity: qty,
      price: Number(order.product.price) * qty,
      details: values.details ? sanitizeInput(values.details, 1000) : null,
      preferredOption: values.preferred ? sanitizeInput(values.preferred, 300) : null,
      notes: values.notes ? sanitizeInput(values.notes, 500) : null,
    },
  });
}

// ---------------------------------------------------------------------------
// Back navigation
// ---------------------------------------------------------------------------

export async function handleBack(orderId: number, step: string, ctx: FormCtx, message: EditableMessage): Promise<void> {
  const order = await fetchOrder(orderId);
  if (!order) throw new AppError({ code: "ORDER_GONE", friendly: "❌ This order no longer exists." });
  if (order.status !== "DRAFT") throw new AppError({ code: "NOT_DRAFT", friendly: "❌ This order is no longer in draft." });
  assertFormAccess(order, ctx);

  if (step === "1" && order.ticket) {
    await renderStep1(order.ticket, message);
    return;
  }
  if (step === "2") {
    const links = await prisma.productCommunity.findMany({ where: { productId: order.productId } });
    const communities = await prisma.robloxCommunity.findMany({
      where: {
        guildId: ctx.guildId,
        enabled: true,
        ...(links.length > 0 ? { id: { in: links.map((l) => l.communityId) } } : {}),
      },
      orderBy: { name: "asc" },
    });
    if (communities.length === 0) {
      throw new AppError({ code: "NO_COMMUNITIES", friendly: "❌ No communities are available for that product." });
    }
    await message.edit({
      content: `📝 **ORDER FORM**\n\n**Step 2 of 4:** Product selected — **${order.product.name}**\nSelect a Roblox community below.`,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(cid(CUSTOM_ID_PREFIX.order, "select-community", order.id))
            .setPlaceholder("Select Roblox Community")
            .addOptions(
              communities.slice(0, 25).map((c) => ({
                label: `${c.emoji ? `${c.emoji} ` : ""}${c.name}`.slice(0, 100),
                value: String(c.id),
                description: `${c.requiredDays} days required`,
              })),
            ),
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(cid(CUSTOM_ID_PREFIX.order, "back", order.id, "1")).setLabel("Back").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(cid(CUSTOM_ID_PREFIX.order, "cancel", order.id)).setLabel("Cancel Order").setStyle(ButtonStyle.Danger),
        ),
      ],
    });
    return;
  }
  if (step === "3") {
    const { embeds, components } = await buildReview(order.id);
    await message.edit({ content: "📝 **ORDER FORM**\n\n**Step 4 of 4:** Review your order.", embeds, components });
  }
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

export type SubmitResult =
  | { ok: true }
  | { ok: false; reason: "ELIGIBILITY_CHANGED"; communityName: string; detail: string };

/**
 * Final eligibility revalidation: the snapshot taken at community-select can
 * be minutes (or hours) old, and membership can change in between. The stored
 * snapshot stays useful for audit/history but is NOT the final authority —
 * we re-sync live memberships (forceRefresh) before DRAFT → SUBMITTED.
 *
 * Outcomes:
 *  - still eligible  → fresh snapshot returned; caller persists it in the
 *                      submit transaction
 *  - no longer eligible → order stays DRAFT, caller renders the retry UI
 *  - RoProxy unavailable → AppError (NOT treated as ineligible), draft kept
 *
 * The snapshot is HISTORICAL: it describes the eligibility state that allowed
 * this order to be submitted. It never replaces future live checks.
 */
type RevalidationOutcome = {
  /** Fresh snapshot to persist (null when eligibility is not required). */
  snapshot: Prisma.InputJsonValue | null;
  /** Non-null = do not submit; render this result instead. */
  blocked: SubmitResult | null;
};

function buildEligibilitySnapshot(order: OrderWithRelations, entry: EligibilityEntry): Prisma.InputJsonValue {
  return {
    status: entry.status,
    eligibleAt: entry.eligibleAt?.toISOString() ?? null,
    checkedAt: new Date().toISOString(),
    communityId: order.community?.id ?? null,
    robloxUserId: order.robloxUserId,
    membershipStartedAt: entry.membership?.membershipStartedAt.toISOString() ?? null,
    membershipDateSource: entry.membership?.membershipDateSource ?? null,
    requiredDays: order.community?.requiredDays ?? null,
  };
}

async function revalidateEligibility(order: OrderWithRelations, ctx: FormCtx): Promise<RevalidationOutcome> {
  if (!order.product.requiresEligibility) return { snapshot: null, blocked: null };

  if (!order.product.enabled) {
    throw new AppError({ code: "PRODUCT_GONE", friendly: "❌ This product is no longer available. Choose another one." });
  }
  if (!order.community || !order.community.enabled) {
    throw new AppError({ code: "COMMUNITY_GONE", friendly: "❌ The selected community is no longer available. Choose another community." });
  }
  if (!order.robloxUserId) {
    throw new AppError({ code: "NOT_VERIFIED", friendly: "❌ You must verify your Roblox account before ordering." });
  }

  let entry: EligibilityEntry | null;
  try {
    entry = await getCommunityEligibility(ctx.guildId, order.robloxUserId, order.community.id, { forceRefresh: true });
  } catch (err) {
    if (isRobloxApiError(err)) {
      throw new AppError({
        code: "ROBLOX_UNAVAILABLE",
        friendly: "❌ Roblox services are unavailable right now, so we could not confirm your eligibility.\nYour order is still a draft — please try again in a few minutes.",
      });
    }
    throw err;
  }

  const snapshot = entry ? buildEligibilitySnapshot(order, entry) : null;

  if (entry?.status === "ELIGIBLE") {
    return { snapshot, blocked: null };
  }

  // No longer eligible: keep the draft, but record the current truth.
  if (snapshot) {
    await prisma.order.update({ where: { id: order.id }, data: { eligibilitySnapshot: snapshot } });
  }
  let detail = entry ? eligibilityStatusLabel(entry.status) : "Community membership not found";
  if (entry?.status === "NOT_ELIGIBLE" && entry.daysRemaining !== null) {
    detail = `${detail} — ${entry.daysRemaining} days remaining`;
  }
  return {
    snapshot: null,
    blocked: { ok: false, reason: "ELIGIBILITY_CHANGED", communityName: order.community.name, detail },
  };
}

export async function submitOrder(orderId: number, ctx: FormCtx): Promise<SubmitResult> {
  const rl = rateLimiter.consume(`order:submit:${ctx.actorId}`, LIMITS.orderSubmit.limit, LIMITS.orderSubmit.windowMs);
  if (!rl.ok) throw new AppError({ code: "RATE_LIMITED", friendly: retryPhrase(rl.retryAfterMs) });

  const order = await fetchOrder(orderId);
  if (!order) throw new AppError({ code: "ORDER_GONE", friendly: "❌ This order no longer exists." });
  if (order.status !== "DRAFT") throw new AppError({ code: "NOT_DRAFT", friendly: "❌ This order has already been submitted." });
  assertFormAccess(order, ctx);

  const revalidation = await revalidateEligibility(order, ctx);
  if (revalidation.blocked) return revalidation.blocked;

  const submitted = await prisma.$transaction(async (tx) => {
    const incremented = await tx.guildSettings.update({
      where: { guildId: order.guildId },
      data: { orderCounter: { increment: 1 } },
    });
    // Conditional update: a duplicate/concurrent submit sees count 0 and the
    // whole transaction (including the counter bump) rolls back.
    const updated = await tx.order.updateMany({
      where: { id: order.id, status: "DRAFT", updatedAt: order.updatedAt },
      data: {
        status: "SUBMITTED",
        number: zeroPad(incremented.orderCounter),
        submittedAt: new Date(),
        ...(revalidation.snapshot ? { eligibilitySnapshot: revalidation.snapshot } : {}),
      },
    });
    if (updated.count === 0) {
      throw new AppError({ code: "NOT_DRAFT", friendly: "❌ This order has already been submitted." });
    }
    const final = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: "SUBMITTED",
        fromStatus: "DRAFT",
        toStatus: "SUBMITTED",
        actorDiscordId: ctx.actorId,
        data: { number: final.number, quantity: final.quantity, price: final.price.toString() },
      },
    });
    return final;
  });

  await audit({
    category: AuditCategory.ORDER,
    action: "SUBMITTED",
    guildId: order.guildId,
    actorDiscordId: ctx.actorId,
    targetDiscordId: order.discordUserId,
    details: { number: submitted.number, product: order.product.name, community: order.community?.name ?? null },
  });

  // Post the persistent order embed — edited in place for the rest of its life.
  const withRelations = (await fetchOrder(order.id))!;
  let orderMessageId: string | null = null;
  if (order.ticket?.channelId) {
    const channel = await getBotClient().channels.fetch(order.ticket.channelId).catch(() => null);
    if (isSendableChannel(channel)) {
      const sent = (await channel
        .send({
          content: `<@${order.discordUserId}>`,
          embeds: [await renderOrderEmbed(withRelations)],
          components: buildOrderStaffControls(withRelations),
        })
        .catch(() => null)) as { id?: string } | null;
      if (sent?.id) {
        orderMessageId = sent.id;
        await prisma.order.update({ where: { id: order.id }, data: { orderMessageId: sent.id } });
      }
    }
  }

  await prisma.orderEvent.create({
    data: {
      orderId: order.id,
      type: "ORDER_EMBED_POSTED",
      actorDiscordId: "system",
      data: { messageId: orderMessageId },
    },
  }).catch(() => undefined);

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export async function cancelOrder(orderIdOrTicketRef: string, ctx: FormCtx, reason?: string | null): Promise<void> {
  if (orderIdOrTicketRef.startsWith("ticket:")) {
    const ticketId = Number(orderIdOrTicketRef.slice(7));
    await prisma.order.deleteMany({ where: { ticketId, status: "DRAFT" } });
    return;
  }
  const orderId = Number(orderIdOrTicketRef);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw new AppError({ code: "BAD_TARGET", friendly: "❌ Invalid order reference in this interaction." });
  }
  const order = await fetchOrder(orderId);
  if (!order) return;
  if (!canTransition(order.status, "CANCELLED")) {
    throw new AppError({ code: "BAD_TRANSITION", friendly: `❌ This order (**${STATUS_LABEL[order.status]}**) can no longer be cancelled.` });
  }
  const staff = isStaffActor(ctx);
  if (order.discordUserId !== ctx.actorId && !staff) {
    throw new AppError({ code: "NOT_ALLOWED", friendly: "❌ Only staff can cancel someone else's order." });
  }
  // Staff cancelling someone else's order must own it (assigned or admin).
  // Customer-side cancellation of their own order is unchanged.
  if (order.discordUserId !== ctx.actorId) {
    assertStaffCanManage(order, ctx);
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Conditional update (expected status + updatedAt): a duplicate/concurrent
    // cancel sees count 0.
    const u = await tx.order.updateMany({
      where: { id: order.id, status: order.status, updatedAt: order.updatedAt },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason ?? null },
    });
    if (u.count === 0) {
      throw new AppError({ code: "STALE_ORDER", friendly: "❌ Order was modified by another staff member. Refresh and try again." });
    }
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: "CANCELLED",
        fromStatus: order.status,
        toStatus: "CANCELLED",
        actorDiscordId: ctx.actorId,
        data: { reason: reason ?? null },
      },
    });
    return tx.order.findUniqueOrThrow({ where: { id: order.id } });
  });

  await audit({
    category: AuditCategory.ORDER,
    action: "CANCELLED",
    guildId: order.guildId,
    actorDiscordId: ctx.actorId,
    targetDiscordId: order.discordUserId,
    details: { number: updated.number, reason: reason ?? null },
  });
  const withRelations = await fetchOrder(order.id);
  if (withRelations) await refreshOrderMessage(withRelations);
}

// ---------------------------------------------------------------------------
// Staff lifecycle
// ---------------------------------------------------------------------------

export async function claimOrder(orderId: number, ctx: FormCtx): Promise<void> {
  const order = await fetchOrder(orderId);
  if (!order) throw new AppError({ code: "ORDER_GONE", friendly: "❌ Order not found." });
  if (!isStaffActor(ctx)) throw new AppError({ code: "NOT_STAFF", friendly: "❌ Only staff can claim orders." });
  if (order.status !== "SUBMITTED" && order.status !== "STAFF_REVIEW" && order.status !== "QUOTED") {
    throw new AppError({ code: "BAD_TRANSITION", friendly: `❌ Orders in **${STATUS_LABEL[order.status]}** cannot be claimed.` });
  }
  if (order.assignedStaffId === ctx.actorId) {
    throw new AppError({ code: "ALREADY_CLAIMED", friendly: "❌ You are already assigned to this order." });
  }
  // Reassignment of an order claimed by someone else is admin-only.
  if (order.assignedStaffId && order.assignedStaffId !== ctx.actorId && !isActorAdmin(ctx)) {
    throw new AppError({ code: "ALREADY_CLAIMED", friendly: `❌ Already claimed by <@${order.assignedStaffId}>.` });
  }

  await prisma.$transaction(async (tx) => {
    // Conditional update: two simultaneous claims — only one wins.
    const updated = await tx.order.updateMany({
      where: { id: order.id, status: order.status, assignedStaffId: order.assignedStaffId },
      data: {
        assignedStaffId: ctx.actorId,
        ...(order.status === "SUBMITTED" ? { status: "STAFF_REVIEW" as const } : {}),
      },
    });
    if (updated.count === 0) {
      throw new AppError({ code: "ALREADY_CLAIMED", friendly: "❌ This order was just claimed or updated by another staff member." });
    }
    if (order.assignedStaffId) {
      await tx.staffAssignment.updateMany({
        where: { orderId: order.id, staffDiscordId: order.assignedStaffId, unassignedAt: null },
        data: { unassignedAt: new Date() },
      });
    }
    await tx.staffAssignment.create({ data: { orderId: order.id, staffDiscordId: ctx.actorId } });
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: "CLAIMED",
        fromStatus: order.status,
        toStatus: order.status === "SUBMITTED" ? "STAFF_REVIEW" : order.status,
        actorDiscordId: ctx.actorId,
      },
    });
  });

  await audit({
    category: AuditCategory.ORDER,
    action: "CLAIMED",
    guildId: order.guildId,
    actorDiscordId: ctx.actorId,
    targetDiscordId: order.discordUserId,
    details: { number: order.number },
  });
  const withRelations = await fetchOrder(order.id);
  if (withRelations) await refreshOrderMessage(withRelations);
}

/**
 * Set (or adjust) the order price.
 *
 * expectedUpdatedAt is the order's updatedAt AT THE MOMENT THE PRICE MODAL
 * WAS OPENED (carried in the modal custom id). Locking on it — not on the
 * freshly fetched row — means a modal submitted after another staff member
 * already changed the order cannot silently overwrite their edit.
 */
export async function setOrderPrice(
  orderId: number,
  newPrice: number,
  ctx: FormCtx,
  expectedUpdatedAt: Date,
): Promise<void> {
  if (!Number.isFinite(newPrice) || newPrice < 0) {
    throw new AppError({ code: "INVALID_PRICE", friendly: "❌ Price must be a number ≥ 0." });
  }
  const order = await fetchOrder(orderId);
  if (!order) throw new AppError({ code: "ORDER_GONE", friendly: "❌ Order not found." });
  assertStaffCanManage(order, ctx);
  // Intended flow: SUBMITTED → Claim → STAFF_REVIEW → Set Price → QUOTED.
  // QUOTED / AWAITING_PAYMENT → QUOTED / AWAITING_PAYMENT is a price
  // adjustment (recorded in order events + audit); the status is preserved.
  if (order.status !== "STAFF_REVIEW" && order.status !== "QUOTED" && order.status !== "AWAITING_PAYMENT") {
    throw new AppError({
      code: "BAD_TRANSITION",
      friendly: `❌ Claim the order first. Price can be set during **${STATUS_LABEL.STAFF_REVIEW}** or adjusted during **${STATUS_LABEL.QUOTED}** / **${STATUS_LABEL.AWAITING_PAYMENT}**.`,
    });
  }

  // STAFF_REVIEW advances to QUOTED when priced; later states keep theirs.
  const targetStatus: OrderStatus = order.status === "STAFF_REVIEW" ? "QUOTED" : order.status;

  await prisma.$transaction(async (tx) => {
    // Optimistic lock on the updatedAt captured when the modal opened: a
    // stale modal or a concurrent edit sees count 0 instead of overwriting
    // another staff member's change.
    const updated = await tx.order.updateMany({
      where: { id: order.id, status: order.status, updatedAt: expectedUpdatedAt },
      data: { price: newPrice, status: targetStatus },
    });
    if (updated.count === 0) {
      throw new AppError({
        code: "STALE_ORDER",
        friendly: "❌ Order was modified by another staff member. Refresh and try again.",
      });
    }
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: "PRICE_SET",
        fromStatus: order.status,
        toStatus: targetStatus,
        actorDiscordId: ctx.actorId,
        data: { oldPrice: order.price.toString(), newPrice: String(newPrice) },
      },
    });
  });

  await audit({
    category: AuditCategory.ORDER,
    action: "PRICE_CHANGED",
    guildId: order.guildId,
    actorDiscordId: ctx.actorId,
    targetDiscordId: order.discordUserId,
    details: { number: order.number, oldPrice: order.price.toString(), newPrice: String(newPrice) },
  });
  const withRelations = await fetchOrder(order.id);
  if (withRelations) await refreshOrderMessage(withRelations);
}

export async function applyStatus(orderId: number, to: OrderStatus, ctx: FormCtx): Promise<void> {
  const order = await fetchOrder(orderId);
  if (!order) throw new AppError({ code: "ORDER_GONE", friendly: "❌ Order not found." });
  assertStaffCanManage(order, ctx);
  if (!canTransition(order.status, to)) {
    throw new AppError({
      code: "BAD_TRANSITION",
      friendly: `❌ Cannot move from **${STATUS_LABEL[order.status]}** to **${STATUS_LABEL[to]}**.\nCheck the order state or use **Claim** / **Set Price** first.`,
    });
  }

  await prisma.$transaction(async (tx) => {
    // Optimistic lock: expected-status + updatedAt — a duplicate button press
    // or a concurrent status change sees count 0 and fails instead of
    // double-transitioning.
    const updated = await tx.order.updateMany({
      where: { id: order.id, status: order.status, updatedAt: order.updatedAt },
      data: { status: to, ...(to === "COMPLETED" ? { completedAt: new Date() } : {}) },
    });
    if (updated.count === 0) {
      throw new AppError({ code: "STALE_ORDER", friendly: "❌ Order was modified by another staff member. Refresh and try again." });
    }
    await tx.orderEvent.create({
      data: { orderId: order.id, type: to, fromStatus: order.status, toStatus: to, actorDiscordId: ctx.actorId },
    });
  });

  await audit({
    category: AuditCategory.ORDER,
    action: `STATUS_${to}`,
    guildId: order.guildId,
    actorDiscordId: ctx.actorId,
    targetDiscordId: order.discordUserId,
    details: { number: order.number, from: order.status, to },
  });
  const withRelations = await fetchOrder(order.id);
  if (withRelations) await refreshOrderMessage(withRelations);
}
