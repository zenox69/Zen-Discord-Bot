import { AuditCategory } from "@prisma/client";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type RepliableInteraction,
} from "discord.js";
import { CUSTOM_ID_PREFIX, LIMITS, VERIFY_TTL_MS, cid } from "../config/constants.js";
import { findSettings } from "./GuildSettingsService.js";
import { prisma } from "../database/prisma.js";
import { roblox } from "./RobloxService.js";
import { audit } from "./AuditService.js";
import { errorEmbed, successEmbed, warnEmbed } from "../utils/embeds.js";
import { AppError } from "../utils/errors.js";
import { deferEphemeral, smartReply } from "../utils/interactionReply.js";
import { tDateTime, tRel } from "../utils/discordTime.js";
import { rateLimiter, retryPhrase } from "../utils/rateLimiter.js";
import { randomVerificationCode } from "../utils/text.js";
import type { InteractionContext } from "../handlers/interactionHandler.js";
import type { RobloxUserRef } from "../types/roblox.js";

/**
 * Roblox account verification — profile-description challenge.
 *
 * The user must prove ownership by placing a random code into their Roblox
 * profile About/Description, which only the account owner can do. One
 * Discord account = one verified Roblox account (and vice versa), enforced
 * by unique constraints.
 */

const USERNAME_RE = /^[A-Za-z0-9_]{2,20}$/;

function verifyButtonRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid(CUSTOM_ID_PREFIX.verify, "check"))
      .setLabel("Verify Account")
      .setStyle(ButtonStyle.Primary),
  );
}

function challengeEmbed(user: RobloxUserRef, code: string, marketplaceName?: string) {
  return warnEmbed(
    "ROBLOX VERIFICATION",
    [
      `**Roblox Account:**`,
      `${user.displayName} (@${user.name})`,
      "",
      "**To prove this account belongs to you:**",
      `1. Open your Roblox profile.`,
      `2. Edit your About/Description.`,
      `3. Add: \`${code}\``,
      `4. Save the profile.`,
      `5. Return here and press **Verify Account** below.`,
      "",
      "Code expires in 15 minutes.",
    ].join("\n"),
    marketplaceName,
  );
}

/**
 * Begin the verification challenge. Works from /verify roblox, from the
 * "Verify Roblox Account" button (via modal), or programmatically.
 */
async function start(interaction: RepliableInteraction, usernameRaw: string): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This can only be used in a server." });

  const rl = rateLimiter.consume(
    `verify:start:${interaction.user.id}`,
    LIMITS.verifyStart.limit,
    LIMITS.verifyStart.windowMs,
  );
  if (!rl.ok) throw new AppError({ code: "RATE_LIMITED", friendly: retryPhrase(rl.retryAfterMs) });

  const username = usernameRaw.trim();
  if (!USERNAME_RE.test(username)) {
    throw new AppError({
      code: "INVALID_USERNAME",
      friendly: "❌ That does not look like a valid Roblox username (2-20 letters, numbers, underscores).",
    });
  }

  // Live Roblox username resolution can exceed the 3-second window.
  await deferEphemeral(interaction);
  const user = await roblox.resolveUsername(username);
  if (!user) {
    throw new AppError({
      code: "ROBLOX_NOT_FOUND",
      friendly: `❌ Could not find a Roblox account for **${username}**. Double-check the exact spelling and try again.`,
    });
  }

  const existingLink = await prisma.robloxAccount.findUnique({
    where: { discordUserId: interaction.user.id },
  });
  if (existingLink) {
    throw new AppError({
      code: "ALREADY_VERIFIED",
      friendly: `You are already verified as **@${existingLink.robloxUsername}**.\nUse \`/verify unlink\` first if you want to switch accounts.`,
    });
  }

  const takenByOther = await prisma.robloxAccount.findUnique({ where: { robloxUserId: user.id } });
  if (takenByOther) {
    throw new AppError({
      code: "ROBLOX_ALREADY_LINKED",
      friendly: "❌ This Roblox account is already linked to a different Discord account.",
    });
  }

  // One pending challenge per (user, guild) — replace any stale one.
  await prisma.robloxVerification.deleteMany({
    where: { guildId, discordUserId: interaction.user.id },
  });

  const code = randomVerificationCode();
  await prisma.robloxVerification.create({
    data: {
      guildId,
      discordUserId: interaction.user.id,
      robloxUserId: user.id,
      robloxUsername: user.name,
      code,
      expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
    },
  });

  await audit({
    category: AuditCategory.VERIFICATION,
    action: "CHALLENGE_ISSUED",
    guildId,
    actorDiscordId: interaction.user.id,
    details: { robloxUserId: user.id, robloxUsername: user.name },
  });

  const settings = await findSettings(guildId);
  await smartReply(interaction, {
    embeds: [challengeEmbed(user, code, settings?.marketplaceName)],
    components: [verifyButtonRow()],
  });
}

async function check(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isButton()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const guildId = interaction.guildId;
  if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This can only be used in a server." });

  const rl = rateLimiter.consume(
    `verify:check:${interaction.user.id}`,
    LIMITS.verifyCheck.limit,
    LIMITS.verifyCheck.windowMs,
  );
  if (!rl.ok) throw new AppError({ code: "RATE_LIMITED", friendly: retryPhrase(rl.retryAfterMs) });

  const pending = await prisma.robloxVerification.findFirst({
    where: { guildId, discordUserId: interaction.user.id },
    orderBy: { createdAt: "desc" },
  });
  if (!pending) {
    throw new AppError({
      code: "NO_ACTIVE_VERIFICATION",
      friendly: "You have no active verification.\nRun `/verify roblox username:YourName` first.",
    });
  }
  const now = new Date();
  if (pending.expiresAt < now) {
    await prisma.robloxVerification.delete({ where: { id: pending.id } });
    throw new AppError({
      code: "VERIFICATION_EXPIRED",
      friendly: "Your verification code has expired.\nRun `/verify roblox username:YourName` to start over.",
    });
  }

  // Infrastructure failure must NEVER look like a failed challenge.
  await deferEphemeral(interaction);
  const profile = await roblox.getProfile(pending.robloxUserId);
  if (profile === null) {
    await prisma.robloxVerification.delete({ where: { id: pending.id } });
    throw new AppError({
      code: "ROBLOX_GONE",
      friendly: "❌ That Roblox account no longer appears to exist. Please start a new verification.",
    });
  }
  if (profile.isBanned) {
    await prisma.robloxVerification.delete({ where: { id: pending.id } });
    throw new AppError({
      code: "ROBLOX_BANNED",
      friendly: "❌ That Roblox account is banned and cannot be linked.",
    });
  }

  if (profile.description.toUpperCase().includes(pending.code)) {
    const verifiedAt = now;
    await prisma.$transaction(async (tx) => {
      await tx.robloxAccount.upsert({
        where: { discordUserId: interaction.user.id },
        update: {
          robloxUserId: profile.id,
          robloxUsername: profile.name,
          robloxDisplayName: profile.displayName,
          verifiedAt,
        },
        create: {
          discordUserId: interaction.user.id,
          robloxUserId: profile.id,
          robloxUsername: profile.name,
          robloxDisplayName: profile.displayName,
          verifiedAt,
          linkedByDiscordId: interaction.user.id,
        },
      });
      await tx.robloxVerification.delete({ where: { id: pending.id } });
    });
    await audit({
      category: AuditCategory.VERIFICATION,
      action: "LINKED",
      guildId,
      actorDiscordId: interaction.user.id,
      targetDiscordId: interaction.user.id,
      details: { robloxUserId: profile.id, robloxUsername: profile.name },
    });

    await smartReply(interaction, {
      embeds: [
        successEmbed(
          "✅ VERIFICATION SUCCESSFUL",
          `**${profile.displayName}** (@${profile.name}) is now linked to this Discord account.\n\nYou can now remove the code from your Roblox profile description.`,
        ),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setURL(roblox.profileUrl(profile.id))
            .setLabel("View Roblox Profile")
            .setStyle(ButtonStyle.Link),
        ),
      ],
    });
  } else {
    await smartReply(interaction, {
      embeds: [
        warnEmbed(
          "❌ Code not found",
          `We could not find \`${pending.code}\` in your Roblox profile description.\n\nMake sure you **saved** the edit on Roblox, then press **Verify Account** again.\n\nCode expires ${tRel(pending.expiresAt)}.`,
        ),
      ],
      components: [verifyButtonRow()],
    });
  }
}

async function status(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This command requires a server." });

  const [account, pending] = await Promise.all([
    prisma.robloxAccount.findUnique({ where: { discordUserId: interaction.user.id } }),
    prisma.robloxVerification.findFirst({
      where: { guildId, discordUserId: interaction.user.id },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  if (!account && !pending) {
    await interaction.reply({
      embeds: [errorEmbed("🔍 Verification Status", "You are not verified and have no pending verification.\nStart with `/verify roblox username:YourName`.", "Marketplace")],
      ephemeral: true,
    });
    return;
  }

  const lines: string[] = [];
  if (account) {
    lines.push(
      "✅ **Verified Roblox Account**",
      `User: **${account.robloxDisplayName}** (@${account.robloxUsername})`,
      `Roblox ID: \`${account.robloxUserId}\``,
      `Verified: ${tDateTime(account.verifiedAt)}`,
    );
  }
  if (pending) {
    const expired = pending.expiresAt < new Date();
    lines.push(
      "",
      expired
        ? "⌛ You have an **expired** pending verification — run `/verify roblox` again."
        : `⏳ Pending verification for **@${pending.robloxUsername}** — code expires ${tRel(pending.expiresAt)}.`,
    );
  }
  await interaction.reply({
    embeds: [successEmbed("🔍 Verification Status", lines.join("\n"))],
    ephemeral: true,
  });
}

async function unlinkSelf(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This command requires a server." });

  const account = await prisma.robloxAccount.findUnique({
    where: { discordUserId: interaction.user.id },
  });
  if (!account) {
    throw new AppError({ code: "NOT_VERIFIED", friendly: "You have no verified Roblox account to unlink." });
  }

  await prisma.$transaction([
    prisma.robloxAccount.delete({ where: { id: account.id } }),
    prisma.robloxVerification.deleteMany({
      where: { guildId, discordUserId: interaction.user.id },
    }),
  ]);
  await audit({
    category: AuditCategory.VERIFICATION,
    action: "UNLINKED",
    guildId,
    actorDiscordId: interaction.user.id,
    targetDiscordId: interaction.user.id,
    details: { robloxUserId: account.robloxUserId, robloxUsername: account.robloxUsername },
  });

  await interaction.reply({
    embeds: [successEmbed("✅ Unlinked", `Your Roblox account **@${account.robloxUsername}** has been unlinked from this Discord account.`)],
    ephemeral: true,
  });
}

/** Staff-only unlink of another member. */
async function unlinkTarget(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) throw new AppError({ code: "NO_GUILD", friendly: "❌ This command requires a server." });

  const target = interaction.options.getUser("user");
  if (!target) throw new AppError({ code: "MISSING_USER", friendly: "❌ Please provide a user." });
  if (target.bot) throw new AppError({ code: "BOT_TARGET", friendly: "❌ Bots cannot be unlinked." });

  const account = await prisma.robloxAccount.findUnique({ where: { discordUserId: target.id } });
  if (!account) {
    throw new AppError({ code: "NOT_VERIFIED", friendly: `❌ ${target} has no verified Roblox account.` });
  }

  await prisma.$transaction([
    prisma.robloxAccount.delete({ where: { id: account.id } }),
    prisma.robloxVerification.deleteMany({ where: { discordUserId: target.id } }),
  ]);
  await audit({
    category: AuditCategory.VERIFICATION,
    action: "UNLINKED_BY_STAFF",
    guildId,
    actorDiscordId: interaction.user.id,
    targetDiscordId: target.id,
    details: { robloxUserId: account.robloxUserId, robloxUsername: account.robloxUsername },
  });

  await interaction.reply({
    embeds: [
      successEmbed(
        "✅ Unlinked",
        `Unlinked **@${account.robloxUsername}** from ${target}.\nThis action has been logged.`,
      ),
    ],
  });
}

export const VerificationService = {
  start,
  check,
  status,
  unlinkSelf,
  unlinkTarget,
  openStartModal,
  submitStartModal,
};

// ---------------------------------------------------------------------------
// "Verify Roblox Account" button -> modal -> start
// ---------------------------------------------------------------------------

function startModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(cid(CUSTOM_ID_PREFIX.verify, "start"))
    .setTitle("Roblox Verification")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("username")
          .setLabel("Roblox username")
          .setPlaceholder("e.g. Meyyyy")
          .setStyle(TextInputStyle.Short)
          .setMinLength(2)
          .setMaxLength(20)
          .setRequired(true),
      ),
    );
}

async function openStartModal(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isButton()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  await interaction.showModal(startModal());
}

async function submitStartModal(ctx: InteractionContext): Promise<void> {
  const interaction = ctx.interaction;
  if (!interaction.isModalSubmit()) throw new AppError({ code: "BAD_INTERACTION", friendly: "❌ Invalid interaction." });
  const username = interaction.fields.getTextInputValue("username") ?? "";
  await start(interaction, username);
}
