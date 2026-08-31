import type { Channel } from "discord.js";

/**
 * Duck-typed sendable channel so this stays compatible across discord.js
 * channel-type reworks (the TextBasedChannel union includes partials that
 * lack send()).
 */
export interface SendableChannel {
  id: string;
  name: string;
  type: number;
  send: (options: { content?: string; embeds?: unknown[]; components?: unknown[] }) => Promise<unknown>;
  delete?: (reason?: string) => Promise<unknown>;
}

export function isSendableChannel(channel: Channel | null | undefined): channel is Channel & SendableChannel {
  return channel !== null && channel !== undefined && typeof (channel as { send?: unknown }).send === "function";
}
