import { describe, expect, it } from "vitest";
import { rateLimiter } from "../src/utils/rateLimiter.js";

const KEY = `test:${Date.now()}`;

describe("rateLimiter", () => {
  it("allows traffic under the limit and blocks over it", () => {
    for (let i = 0; i < 3; i++) {
      expect(rateLimiter.consume(KEY, 3, 60_000).ok).toBe(true);
    }
    const blocked = rateLimiter.consume(KEY, 3, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("clear() resets the bucket", () => {
    rateLimiter.clear(KEY);
    expect(rateLimiter.consume(KEY, 3, 60_000).ok).toBe(true);
    rateLimiter.clear(KEY);
  });

  it("uses independent keys", () => {
    rateLimiter.clear(`${KEY}:other`);
    expect(rateLimiter.consume(`${KEY}:other`, 1, 60_000).ok).toBe(true);
    expect(rateLimiter.consume(`${KEY}:other`, 1, 60_000).ok).toBe(false);
    rateLimiter.clear(`${KEY}:other`);
  });
});
