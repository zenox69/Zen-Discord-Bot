import type {
  ButtonInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import { parseCustomId } from "../config/constants.js";
import { handleFatal } from "../utils/errorBoundary.js";
import { log } from "../utils/logger.js";

export type ComponentInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;

export type InteractionKind = "button" | "select" | "modal";

export interface InteractionContext {
  interaction: ComponentInteraction;
  /** Custom-id segments after "prefix:action" (e.g. ids, pages). */
  parts: string[];
}

interface HandlerRegistration {
  prefix: string;
  action: string;
  kinds: InteractionKind[];
  run: (ctx: InteractionContext) => Promise<void>;
}

const handlers: HandlerRegistration[] = [];

/**
 * Register a persistent interaction handler.
 * customId grammar: "<prefix>:<action>[:arg1][:arg2]..."
 * Registrations live for the whole process, so all buttons/selects/modals
 * keep working across restarts — workflow state itself lives in Postgres.
 */
export function registerInteraction(
  prefix: string,
  action: string,
  kinds: InteractionKind[],
  run: (ctx: InteractionContext) => Promise<void>,
): void {
  handlers.push({ prefix, action, kinds, run });
}

function kindOf(interaction: ComponentInteraction): InteractionKind {
  if (interaction.isButton()) return "button";
  if (interaction.isModalSubmit()) return "modal";
  return "select";
}

export async function routeInteraction(interaction: ComponentInteraction): Promise<void> {
  const { prefix, action, parts } = parseCustomId(interaction.customId);
  const kind = kindOf(interaction);
  const registration = handlers.find(
    (h) => h.prefix === prefix && h.action === action && h.kinds.includes(kind),
  );
  if (!registration) {
    log.warn(`No handler registered for customId "${interaction.customId}"`);
    return;
  }
  // Ensure guild.ownerId is known so owner-based permission checks work on
  // component interactions too (GUILD_CREATE omits owner_id).
  const guild = interaction.guild;
  if (guild && !guild.ownerId) await guild.fetch().catch(() => undefined);
  await handleFatal(() => registration.run({ interaction, parts }), {
    interaction,
    guildId: interaction.guildId ?? undefined,
  });
}
