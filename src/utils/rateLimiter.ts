/**
 * Centralized in-memory sliding-window rate limiter.
 * Keys are stable per (action, user) pairs; state is intentionally RAM-only —
 * it protects RoProxy and Discord, not business data (which lives in Postgres).
 */

interface Bucket {
  timestamps: number[];
}

export interface RateLimitResult {
  ok: boolean;
  retryAfterMs: number;
}

class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private readonly sweepMs = 10 * 60_000) {
    const timer = setInterval(() => this.sweep(), this.sweepMs);
    timer.unref();
  }

  /** Returns ok=false when the key has hit its limit inside the window. */
  consume(key: string, limit: number, windowMs: number): RateLimitResult {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.buckets.set(key, bucket);
    }
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);
    if (bucket.timestamps.length >= limit) {
      const oldest = bucket.timestamps[0] ?? now;
      return { ok: false, retryAfterMs: Math.max(0, windowMs - (now - oldest)) };
    }
    bucket.timestamps.push(now);
    return { ok: true, retryAfterMs: 0 };
  }

  clear(key: string): void {
    this.buckets.delete(key);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.timestamps.length === 0 || now - bucket.timestamps[bucket.timestamps.length - 1]! > 10 * 60_000) {
        this.buckets.delete(key);
      }
    }
  }
}

export const rateLimiter = new RateLimiter();

/** Human-friendly "try again in Xs" phrase. */
export function retryPhrase(retryAfterMs: number): string {
  const secs = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return `⏳ You are using this too quickly — try again in **${secs}s**.`;
}
