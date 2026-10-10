/** Respect upstream delay; reject huge delays instead of retrying early. */
export function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}
