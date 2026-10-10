import { describe, expect, it } from "vitest";
import { parseGuildAllowlist } from "../src/config/guildAllowlist.js";

describe("parseGuildAllowlist", () => {
  it("parses a comma-separated list, trimming whitespace and dropping empties", () => {
    expect(parseGuildAllowlist("1111111111111111111, 2222222222222222222 ,, 3333333333333333333")).toEqual(
      new Set(["1111111111111111111", "2222222222222222222", "3333333333333333333"]),
    );
  });

  it("returns an empty set for empty or unset values", () => {
    expect(parseGuildAllowlist("")).toEqual(new Set());
    expect(parseGuildAllowlist("  ")).toEqual(new Set());
  });

  it("rejects malformed entries instead of silently widening access", () => {
    for (const value of ["not-an-id", "not-an-id,4444444444444444444", ", ,", "00000000000000000"]) {
      expect(() => parseGuildAllowlist(value)).toThrow(/GUILD_ID/);
    }
  });

  it("parses a single id", () => {
    expect(parseGuildAllowlist("1506662473493909684")).toEqual(
      new Set(["1506662473493909684"]),
    );
  });
});
