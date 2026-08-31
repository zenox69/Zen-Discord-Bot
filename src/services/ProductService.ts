import { AuditCategory, Prisma, type Product } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import { audit } from "./AuditService.js";
import { findCommunityByName } from "./CommunityService.js";
import { AppError } from "../utils/errors.js";
import { sanitizeInput } from "../utils/text.js";

/**
 * ProductService — database-driven products. Nothing is hard-coded;
 * admins manage everything from Discord.
 */

export interface ProductInput {
  name?: string | null;
  description?: string | null;
  category?: string | null;
  price?: number | null;
  requiresEligibility?: boolean | null;
  minQuantity?: number | null;
  maxQuantity?: number | null;
  communityNames?: string[] | null;
}

export type ProductWithCommunities = Prisma.ProductGetPayload<{
  include: { communities: { include: { community: true } } };
}>;

async function assertAddable(input: ProductInput): Promise<void> {
  if (!input.name || sanitizeInput(input.name, 60).length < 2) {
    throw new AppError({ code: "INVALID_NAME", friendly: "❌ Product name is too short." });
  }
  if (!input.description || sanitizeInput(input.description, 1000).length < 2) {
    throw new AppError({ code: "INVALID_DESCRIPTION", friendly: "❌ Product description is required." });
  }
  if (input.price === undefined || input.price === null || !Number.isFinite(input.price) || input.price < 0) {
    throw new AppError({ code: "INVALID_PRICE", friendly: "❌ Price must be a number ≥ 0." });
  }
  const min = input.minQuantity ?? 1;
  if (!Number.isInteger(min) || min < 1) {
    throw new AppError({ code: "INVALID_QUANTITY", friendly: "❌ min-quantity must be a whole number ≥ 1." });
  }
  if (input.maxQuantity !== null && input.maxQuantity !== undefined) {
    if (!Number.isInteger(input.maxQuantity) || input.maxQuantity < min) {
      throw new AppError({
        code: "INVALID_QUANTITY_RANGE",
        friendly: "❌ max-quantity must be greater than or equal to min-quantity.",
      });
    }
  }
}

export async function addProduct(
  guildId: string,
  actorDiscordId: string,
  input: ProductInput,
  settings: { currency: string },
): Promise<Product> {
  await assertAddable(input);
  const name = sanitizeInput(input.name!, 60);
  const clash = await prisma.product.findUnique({ where: { guildId_name: { guildId, name } } });
  if (clash) throw new AppError({ code: "DUPLICATE_PRODUCT", friendly: `❌ A product named **${name}** already exists.` });

  const communityNames = input.communityNames ?? [];
  const communityIds: number[] = [];
  for (const raw of communityNames) {
    const c = await findCommunityByName(guildId, raw);
    communityIds.push(c.id);
  }

  const product = await prisma.product.create({
    data: {
      guildId,
      name,
      description: sanitizeInput(input.description!, 1000),
      category: sanitizeInput(input.category ?? "General", 60),
      price: input.price!,
      currency: settings.currency,
      requiresEligibility: input.requiresEligibility ?? true,
      minQuantity: Math.max(1, input.minQuantity ?? 1),
      maxQuantity: input.maxQuantity ?? null,
      communities: communityIds.length > 0 ? { create: communityIds.map((communityId) => ({ communityId })) } : undefined,
    },
  });

  await audit({
    category: AuditCategory.PRODUCT,
    action: "ADDED",
    guildId,
    actorDiscordId,
    details: { name: product.name, price: product.price.toString(), category: product.category },
  });
  return product;
}

export async function findProductByName(guildId: string, rawName: string): Promise<Product> {
  const needle = rawName.trim().toLowerCase();
  const all = await prisma.product.findMany({ where: { guildId } });
  const exact = all.find((p) => p.name.toLowerCase() === needle);
  if (exact) return exact;
  const starts = all.filter((p) => p.name.toLowerCase().startsWith(needle));
  if (starts.length === 1) return starts[0]!;
  if (starts.length > 1) {
    throw new AppError({ code: "AMBIGUOUS_PRODUCT", friendly: `❌ Multiple products match: ${starts.map((p) => `**${p.name}**`).join(", ")}.` });
  }
  throw new AppError({ code: "PRODUCT_NOT_FOUND", friendly: `❌ No product named “${rawName.trim()}”. Use \`/product list\`.` });
}

export async function editProduct(
  guildId: string,
  actorDiscordId: string,
  rawName: string,
  input: ProductInput,
): Promise<Product> {
  const target = await findProductByName(guildId, rawName);
  const data: Record<string, unknown> = {};

  if (input.name !== undefined && input.name !== null) {
    const name = sanitizeInput(input.name, 60);
    if (name.length >= 2 && name.toLowerCase() !== target.name.toLowerCase()) {
      const clash = await prisma.product.findUnique({ where: { guildId_name: { guildId, name } } });
      if (clash && clash.id !== target.id) {
        throw new AppError({ code: "DUPLICATE_PRODUCT", friendly: `❌ A product named **${name}** already exists.` });
      }
      data.name = name;
    }
  }
  if (input.description !== undefined && input.description !== null) {
    data.description = sanitizeInput(input.description, 1000);
  }
  if (input.category !== undefined && input.category !== null) {
    data.category = sanitizeInput(input.category, 60);
  }
  if (input.price !== undefined && input.price !== null) {
    if (!Number.isFinite(input.price) || input.price < 0) {
      throw new AppError({ code: "INVALID_PRICE", friendly: "❌ Price must be a number ≥ 0." });
    }
    data.price = input.price;
  }
  if (input.requiresEligibility !== undefined && input.requiresEligibility !== null) {
    data.requiresEligibility = input.requiresEligibility;
  }
  if (input.minQuantity !== undefined && input.minQuantity !== null) {
    if (!Number.isInteger(input.minQuantity) || input.minQuantity < 1) {
      throw new AppError({ code: "INVALID_QUANTITY", friendly: "❌ min-quantity must be ≥ 1." });
    }
    data.minQuantity = input.minQuantity;
  }
  if (input.maxQuantity !== undefined) {
    if (input.maxQuantity === null || input.maxQuantity === 0) {
      data.maxQuantity = null;
    } else if (Number.isInteger(input.maxQuantity) && input.maxQuantity > 0) {
      data.maxQuantity = input.maxQuantity;
    } else {
      throw new AppError({ code: "INVALID_QUANTITY", friendly: "❌ max-quantity must be a positive whole number (or 0 for unlimited)." });
    }
  }

  const finalMin = (data.minQuantity as number | undefined) ?? target.minQuantity;
  const finalMax =
    Object.prototype.hasOwnProperty.call(data, "maxQuantity")
      ? (data.maxQuantity as number | null)
      : target.maxQuantity;
  if (finalMax !== null && finalMax < finalMin) {
    throw new AppError({
      code: "INVALID_QUANTITY_RANGE",
      friendly: "❌ max-quantity must be greater than or equal to min-quantity.",
    });
  }

  if (input.communityNames) {
    await prisma.productCommunity.deleteMany({ where: { productId: target.id } });
    for (const raw of input.communityNames) {
      const c = await findCommunityByName(guildId, raw);
      await prisma.productCommunity.create({ data: { productId: target.id, communityId: c.id } });
    }
  }

  if (Object.keys(data).length === 0 && !input.communityNames) {
    throw new AppError({ code: "NO_CHANGES", friendly: "❌ Provide at least one field to change." });
  }

  const updated = await prisma.product.update({ where: { id: target.id }, data });
  await audit({
    category: AuditCategory.PRODUCT,
    action: "EDITED",
    guildId,
    actorDiscordId,
    details: { name: updated.name, changes: data },
  });
  return updated;
}

export async function setProductEnabled(
  guildId: string,
  actorDiscordId: string,
  rawName: string,
  enabled: boolean,
): Promise<Product> {
  const target = await findProductByName(guildId, rawName);
  const updated = await prisma.product.update({ where: { id: target.id }, data: { enabled } });
  await audit({
    category: AuditCategory.PRODUCT,
    action: enabled ? "ENABLED" : "DISABLED",
    guildId,
    actorDiscordId,
    details: { name: updated.name },
  });
  return updated;
}

export async function listProducts(guildId: string): Promise<ProductWithCommunities[]> {
  return prisma.product.findMany({
    where: { guildId },
    include: { communities: { include: { community: true } } },
    orderBy: { name: "asc" },
  });
}

export async function getProductForForm(guildId: string): Promise<ProductWithCommunities[]> {
  const products = await prisma.product.findMany({
    where: { guildId, enabled: true },
    include: { communities: { include: { community: true } } },
    orderBy: { name: "asc" },
  });
  return products;
}
