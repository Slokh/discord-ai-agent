import { describe, expect, it } from "vitest";
import { EXCLUDED_CHANNEL_IDS, filterExcludedChannelIds, isExcludedChannelId } from "../../src/discord/excludedChannels.js";

describe("permanently excluded Discord channels", () => {
  it("includes the #trivia-sucks channel", () => {
    expect(EXCLUDED_CHANNEL_IDS).toContain("1172353113471074314");
  });

  it("detects excluded channel ids", () => {
    expect(isExcludedChannelId("1172353113471074314")).toBe(true);
    expect(isExcludedChannelId("999999999999999999")).toBe(false);
    expect(isExcludedChannelId(null)).toBe(false);
    expect(isExcludedChannelId(undefined)).toBe(false);
    expect(isExcludedChannelId("")).toBe(false);
  });

  it("strips excluded channel ids from lists", () => {
    expect(filterExcludedChannelIds(["a", "1172353113471074314", "b"])).toEqual(["a", "b"]);
    expect(filterExcludedChannelIds(["a", "b"])).toEqual(["a", "b"]);
    expect(filterExcludedChannelIds([])).toEqual([]);
  });
});
