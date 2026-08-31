import type { BaseInteraction, InteractionReplyOptions } from "discord.js";
import type { Channel } from "discord.js";
import { AuditCategory } from "@prisma/client";
import { prisma } from "../database/prisma.js";
import { getBotClient } from "./botClient.js";
import { errorEmbed, warnEmbed } from "./embeds.js";
import { AppError, isAppError, isRobloxApiError } from "./errors.js";
import { log } from "./logger.js";

/**
 * Centralized error handling.
 *
 *  - AppError (expected): friendly ephemeral reply, warn-level log.
 *  - Anything else (unexpected):
 *      • user sees a friendly message + a short reference code (ERR-XXXXXX)
 *      • full stack is logged to console, stored in an in-memory registry,
 *        written to the audit table, and posted to the guild's error channel.
 *      • internals (stacks, env, DB URLs) are never shown to end users.
 */

const MAX_MEMORY_REFS = 100;
const errorRefs = new Map<string, string>();

export function makeErrorRef(): string {
  return `ERR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function rememberError(ref: string, details: string): void {
  errorRefs.set(ref, details);
  if (errorRefs.size > MAX_MEMORY_REFS) {
    const oldest = errorRefs.keys().next().value;
    if (oldest) errorRefs.delete(oldest);
  }
}

export function lookupErrorRef(ref: string): string | undefined {
  return errorRefs.get(ref);
}

/** Duck-typed guard so this compiles across discord.js channel-type reworks. */
function isSendableChannel(
  channel: Channel | null,
): channel is Channel & { send: (opts: { embeds: unknown[] }) => Promise<unknown> } {
  return channel !== null && typeof (channel as { send?: unknown }).send === "function";
}

export interface ErrorContext {
  interaction?: BaseInteraction;
  guildId?: string;
}

async function replyEphemeral(
  interaction: BaseInteraction,
  embeds: InteractionReplyOptions["embeds"],
): Promise<void> {
  const options: InteractionReplyOptions = { embeds, ephemeral: true };
  if (!interaction.isRepliable()) return;
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(options);
    // Clear the "thinking" placeholder left behind by a deferred interaction.
    if (interaction.deferred && !interaction.replied) {
      await interaction.deleteReply().catch(() => undefined);
    }
  } else {
    await interaction.reply(options);
  }
}

export async function reportError(err: unknown, ctx: ErrorContext): Promise<void> {
  const e = err instanceof Error ? err : new Error(String(err));

  if (isRobloxApiError(err)) {
    // Third-party infrastructure failure: warn-log it, but the user must
    // never see this rendered as "not a member" or a failed check.
    log.warn(`[RobloxApi:${err.kind}] ${err.endpoint}${err.status ? ` (${err.status})` : ""} ${err.message}`);
    if (ctx.interaction) {
      try {
        await replyEphemeral(ctx.interaction, [
          warnEmbed(
            "⚠️ Roblox services unavailable",
            "Roblox services are temporarily unavailable. Please try again shortly.",
          ),
        ]);
      } catch (replyErr) {
        log.error("Failed to deliver RobloxApiError reply", replyErr);
      }
    }
    return;
  }

  if (isAppError(err)) {
    log.warn(`[AppError:${err.code}] ${e.message}${ctx.guildId ? ` (guild ${ctx.guildId})` : ""}`);
    if (ctx.interaction) {
      try {
        await replyEphemeral(ctx.interaction, [errorEmbed("⚠️ Unable to complete", err.friendly)]);
      } catch (replyErr) {
        log.error("Failed to deliver AppError reply", replyErr);
      }
    }
    return;
  }

  const ref = makeErrorRef();
  const details = e.stack ?? e.message;
  log.error(`${ref} ${details}`);
  rememberError(ref, details);

  if (ctx.interaction) {
    try {
      await replyEphemeral(ctx.interaction, [
        errorEmbed(
          "❌ Something went wrong",
          "Something went wrong while processing this request.\n\nReference:\n" + `\`${ref}\``,
        ),
      ]);
    } catch (replyErr) {
      log.error("Failed to deliver error reply", replyErr);
    }
  }

  if (ctx.guildId) {
    try {
      const settings = await prisma.guildSettings.findUnique({ where: { guildId: ctx.guildId } });
      await prisma.auditLog.create({
        data: {
          guildId: ctx.guildId,
          category: AuditCategory.SYSTEM,
          action: "ERROR",
          details: { ref, message: e.message, stack: String(details).slice(0, 4000) },
        },
      });
      const channelId = settings?.errorLogChannelId;
      if (channelId) {
        const client = getBotClient();
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel && isSendableChannel(channel)) {
          const stackSnippet = String(details)
            .split("\n")
            .slice(0, 12)
            .join("\n")
            .slice(0, 3000);
          await channel
            .send({
              embeds: [
                errorEmbed(`❌ Bot error \`${ref}\``, [
                  `**Message:** ${e.message.slice(0, 300)}`,
                  "",
                  "```",
                  stackSnippet,
                  "```",
                ].join("\n")),
              ],
            })
            .catch(() => undefined);
        }
      }
    } catch (dbErr) {
      log.error("Failed to record error in database", dbErr);
    }
  }
}

/** Run a command/interaction body, converting any throw into reportError. */
export async function handleFatal(fn: () => Promise<unknown>, ctx: ErrorContext): Promise<void> {
  try {
    await fn();
  } catch (err) {
    await reportError(err, ctx);
  }
}

export function appError(opts: ConstructorParameters<typeof AppError>[0]): AppError {
  return new AppError(opts);
}
