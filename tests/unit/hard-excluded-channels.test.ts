import { describe, expect, it } from "vitest";
import {
  HARD_EXCLUDED_CHANNEL_IDS,
  isHardExcludedChannel,
  withoutHardExcludedChannels
} from "../../src/db/hardExcludedChannels.js";

const TRIVIA_SUCKS_CHANNEL_ID = "1172353113471074314";

describe("hardExcludedChannels", () => {
  describe("HARD_EXCLUDED_CHANNEL_IDS", () => {
    it("includes the #trivia-sucks channel id", () => {
      expect(HARD_EXCLUDED_CHANNEL_IDS.has(TRIVIA_SUCKS_CHANNEL_ID)).toBe(true);
    });

    it("is a readonly set containing at least the trivia-sucks channel id", () => {
      expect(HARD_EXCLUDED_CHANNEL_IDS.size).toBeGreaterThanOrEqual(1);
      expect([...HARD_EXCLUDED_CHANNEL_IDS]).toContain(TRIVIA_SUCKS_CHANNEL_ID);
    });
  });

  describe("isHardExcludedChannel", () => {
    it("returns true for the #trivia-sucks channel id", () => {
      expect(isHardExcludedChannel(TRIVIA_SUCKS_CHANNEL_ID)).toBe(true);
    });

    it("returns false for unrelated channel ids", () => {
      expect(isHardExcludedChannel("999999999999999999")).toBe(false);
      expect(isHardExcludedChannel("")).toBe(false);
      expect(isHardExcludedChannel(null)).toBe(false);
      expect(isHardExcludedChannel(undefined)).toBe(false);
    });
  });

  describe("withoutHardExcludedChannels", () => {
    it("strips the #trivia-sucks channel id while preserving order of other ids", () => {
      const filtered = withoutHardExcludedChannels([
        "111111111111111111",
        TRIVIA_SUCKS_CHANNEL_ID,
        "222222222222222222"
      ]);
      expect(filtered).toEqual(["111111111111111111", "222222222222222222"]);
    });

    it("returns an empty array when only the excluded channel is provided", () => {
      expect(withoutHardExcludedChannels([TRIVIA_SUCKS_CHANNEL_ID])).toEqual([]);
    });

    it("handles duplicate excluded entries", () => {
      expect(
        withoutHardExcludedChannels([TRIVIA_SUCKS_CHANNEL_ID, TRIVIA_SUCKS_CHANNEL_ID])
      ).toEqual([]);
    });

    it("returns a new array, not a mutation of the input", () => {
      const input = [TRIVIA_SUCKS_CHANNEL_ID, "111111111111111111"];
      const filtered = withoutHardExcludedChannels(input);
      expect(filtered).toEqual(["111111111111111111"]);
      expect(input).toEqual([TRIVIA_SUCKS_CHANNEL_ID, "111111111111111111"]);
    });
  });
});
