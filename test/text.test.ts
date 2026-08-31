import { describe, expect, it } from "vitest";
import {
  parseCustomId,
  cid,
  CUSTOM_ID_PREFIX,
} from "../src/config/constants.js";
import {
  parseDateLenient,
  randomVerificationCode,
  sanitizeInput,
  slugify,
  zeroPad,
} from "../src/utils/text.js";

describe("custom id grammar", () => {
  it("round-trips prefix, action, and parts", () => {
    const customId = cid(CUSTOM_ID_PREFIX.order, "claim", 123);
    expect(customId).toBe("order:claim:123");
    expect(parseCustomId(customId)).toEqual({
      prefix: "order",
      action: "claim",
      parts: ["123"],
    });
  });

  it("keeps the full part list in order", () => {
    expect(parseCustomId(cid("customer", "history", "42", 7))).toEqual({
      prefix: "customer",
      action: "history",
      parts: ["42", "7"],
    });
  });
});

describe("sanitizeInput", () => {
  it("strips role mentions and @everyone/@here", () => {
    expect(sanitizeInput("hi <@&123> @everyone @HERE there")).toBe("hi there");
  });

  it("removes control characters but keeps whitespace", () => {
    expect(sanitizeInput("a\x00b\u000bc\nd\te")).toBe("abc\nd\te");
  });

  it("trims and caps length", () => {
    expect(sanitizeInput("  x  ")).toBe("x");
    expect(sanitizeInput("a".repeat(1000)).length).toBeLessThanOrEqual(500);
  });

  it("collapses runs of 5+ newlines to 4", () => {
    expect(sanitizeInput("a\n\n\n\n\n\nb")).toBe("a\n\n\n\nb");
  });
});

describe("randomVerificationCode", () => {
  it("matches the unambiguous BB-XXXXXX format", () => {
    for (let i = 0; i < 50; i++) {
      const code = randomVerificationCode();
      expect(code).toMatch(/^[A-Z0-9]{2}-[A-Z0-9]{6}$/);
      for (const ch of code) {
        if (ch === "-") continue;
        expect("01ILO".includes(ch)).toBe(false);
      }
    }
  });
});

describe("slugify", () => {
  it("lowercases and keeps alphanumerics", () => {
    expect(slugify("Bob Smith!!")).toBe("bob-smith");
    expect(slugify("")).toBe("user");
  });

  it("respects max length", () => {
    expect(slugify("a".repeat(50)).length).toBeLessThanOrEqual(20);
  });
});

describe("zeroPad", () => {
  it("zero-pads to the requested width", () => {
    expect(zeroPad(7, 6)).toBe("000007");
    expect(zeroPad(0)).toBe("000000");
    expect(zeroPad(-3)).toBe("000000");
  });
});

describe("parseDateLenient", () => {
  it("parses valid dates and rejects garbage", () => {
    expect(parseDateLenient("2026-01-02T03:04:05.000Z")?.getDate()).toBe(2);
    expect(parseDateLenient("not-a-date")).toBeNull();
  });
});
