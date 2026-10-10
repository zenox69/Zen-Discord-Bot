import { AppError } from "./errors.js";

// The supported deployment is one replica. Reject concurrent clicks instead
// of queueing unbounded work; every key is released even when a request fails.
const running = new Set<string>();
export async function withWorkflowLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  if (running.has(key)) throw new AppError({ code: "WORKFLOW_BUSY", friendly: "⏳ This action is already being processed. Please try again shortly." });
  running.add(key);
  try { return await action(); } finally { running.delete(key); }
}
