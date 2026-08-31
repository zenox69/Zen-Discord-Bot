/**
 * Discord timestamp helpers + money formatting.
 * Prefer <t:...> stamps so every viewer sees their own timezone.
 */

export function toUnix(value: Date | number): number {
  return Math.floor((value instanceof Date ? value.getTime() : value) / 1000);
}

export const tRel = (d: Date | number): string => `<t:${toUnix(d)}:R>`;
export const tDate = (d: Date | number): string => `<t:${toUnix(d)}:D>`;
export const tDateTime = (d: Date | number): string => `<t:${toUnix(d)}:F>`;
export const tShort = (d: Date | number): string => `<t:${toUnix(d)}:t>`;

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

/** Whole days between two dates (ceil so a partial final day still counts). */
export function daysUntil(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
}

/** Full calendar days elapsed (floor), for account age. */
export function daysSince(from: Date, to: Date = new Date()): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

export function formatMoney(amount: number | { toString(): string }, symbol = "₱"): string {
  const n = typeof amount === "number" ? amount : Number(amount.toString());
  if (!Number.isFinite(n)) return symbol + "0";
  const hasFraction = Math.abs(n % 1) > 1e-9;
  return (
    symbol +
    n.toLocaleString("en-US", {
      minimumFractionDigits: hasFraction ? 2 : 0,
      maximumFractionDigits: 2,
    })
  );
}
