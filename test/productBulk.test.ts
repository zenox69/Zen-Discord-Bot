import { describe, expect, it } from "vitest";
import { MAX_BULK_PRODUCTS, parseBulkLines } from "../src/services/ProductService.js";

describe("parseBulkLines", () => {
  it("parses a single valid line", () => {
    const { entries, failures } = parseBulkLines("Starter Pack: 4.99");
    expect(entries).toEqual([{ name: "Starter Pack", price: 4.99 }]);
    expect(failures).toEqual([]);
  });

  it("parses multiple lines and skips blank lines", () => {
    const { entries, failures } = parseBulkLines("A Pack: 1\n\nB Pack: 2.5\n   \nC Pack: 10");
    expect(entries).toEqual([
      { name: "A Pack", price: 1 },
      { name: "B Pack", price: 2.5 },
      { name: "C Pack", price: 10 },
    ]);
    expect(failures).toEqual([]);
  });

  it("splits on the last colon so names can contain colons", () => {
    const { entries } = parseBulkLines("Pro: Edition: 12");
    expect(entries).toEqual([{ name: "Pro: Edition", price: 12 }]);
  });

  it("accepts whole and decimal prices, rejects bad numbers", () => {
    expect(parseBulkLines("OK: 0").entries).toEqual([{ name: "OK", price: 0 }]);
    expect(parseBulkLines("OK: 1200").entries).toEqual([{ name: "OK", price: 1200 }]);
    expect(parseBulkLines("Bad: 4,99").failures[0]?.reason).toContain("Invalid price");
    expect(parseBulkLines("Bad: -5").failures[0]?.reason).toContain("Invalid price");
    expect(parseBulkLines("Bad: 1.2.3").failures[0]?.reason).toContain("Invalid price");
    expect(parseBulkLines("Bad: 12abc").failures[0]?.reason).toContain("Invalid price");
    expect(parseBulkLines("Bad: ").failures[0]?.reason).toContain("Invalid price");
  });

  it("rejects lines without a colon and reports the line number", () => {
    const { entries, failures } = parseBulkLines("NoColonHere\nGood: 1");
    expect(entries).toEqual([{ name: "Good", price: 1 }]);
    expect(failures).toEqual([
      { line: 1, raw: "NoColonHere", reason: expect.stringContaining("Missing") },
    ]);
  });

  it("rejects names that are too short after sanitization", () => {
    const { entries, failures } = parseBulkLines("A: 5");
    expect(entries).toEqual([]);
    expect(failures[0]?.reason).toContain("at least 2 characters");
  });

  it("truncates long names to 60 characters", () => {
    const long = "N".repeat(80);
    const { entries } = parseBulkLines(`${long}: 1`);
    expect(entries[0]?.name).toHaveLength(60);
  });

  it("flags duplicate names within the same list (case-insensitive)", () => {
    const { entries, failures } = parseBulkLines("Pack: 1\npack: 2\nOther: 3");
    expect(entries).toEqual([
      { name: "Pack", price: 1 },
      { name: "Other", price: 3 },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.line).toBe(2);
    expect(failures[0]?.reason).toContain("Duplicate");
  });

  it("rejects more than the max number of products", () => {
    const lines = Array.from({ length: MAX_BULK_PRODUCTS + 1 }, (_, i) => `Pack ${i}: 1`).join("\n");
    const { entries, failures } = parseBulkLines(lines);
    expect(entries).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain("Too many products");
  });

  it("returns nothing for empty input", () => {
    expect(parseBulkLines("")).toEqual({ entries: [], failures: [] });
    expect(parseBulkLines("  \n\n")).toEqual({ entries: [], failures: [] });
  });

  it("handles CRLF line endings", () => {
    const { entries } = parseBulkLines("Pack A: 1\r\nPack B: 2\r\n");
    expect(entries).toEqual([
      { name: "Pack A", price: 1 },
      { name: "Pack B", price: 2 },
    ]);
  });
});
