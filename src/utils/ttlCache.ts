/** Hard-bounded TTL cache, oldest insertion evicted when live entries fill it. */
export class TtlCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();
  constructor(private readonly maxEntries = 5000) {}
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) { this.entries.delete(key); return undefined; }
    return entry.value;
  }
  set(key: string, value: T, ttlMs: number): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}
