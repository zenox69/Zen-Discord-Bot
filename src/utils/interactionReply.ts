import {
  MessageFlags,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type RepliableInteraction,
} from "discord.js";

/**
 * Discord only gives an interaction 3 seconds before it drops the response
 * (10062 — the user sees nothing). Any handler that does slow work (live
 * Roblox API syncs, retries) must defer first and finish with editReply.
 */
export async function deferEphemeral(interaction: RepliableInteraction): Promise<void> {
  if (interaction.deferred || interaction.replied) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
}

/**
 * Reply, or edit the deferred placeholder when the interaction already has
 * one. Callers that defer first always land in editReply (ephemality is
 * inherited from the defer).
 */
export async function smartReply(
  interaction: RepliableInteraction,
  payload: InteractionEditReplyOptions,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
    return;
  }
  // Fast path (no defer): reply directly. Callers in this codebase always
  // defer first, so this is only a safety net; edit-only fields are dropped.
  const { flags: _flags, message: _message, content, ...rest } = payload;
  await interaction.reply({
    ...rest,
    ...(content !== null ? { content: content ?? undefined } : {}),
  } as InteractionReplyOptions);
}

/** Remove the "thinking" placeholder after a deferred interaction finished in another message. */
export async function clearDefer(interaction: RepliableInteraction): Promise<void> {
  if (interaction.deferred && !interaction.replied) {
    await interaction.deleteReply().catch(() => undefined);
  }
}
