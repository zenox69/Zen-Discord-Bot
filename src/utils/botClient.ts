import type { Client } from "discord.js";

let client: Client | null = null;

/** Register the live client (called once from index.ts after construction). */
export function setBotClient(c: Client): void {
  client = c;
}

export function getBotClient(): Client {
  if (!client) throw new Error("Bot client is not initialized yet");
  return client;
}
