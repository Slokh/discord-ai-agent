import { describe, expect, it } from "vitest";
import { splitForDiscord, truncateForDiscord } from "../../src/util/text.js";

describe("splitForDiscord", () => {
  it("returns the input unchanged when it fits the limit", () => {
    expect(splitForDiscord("hello", 10)).toEqual(["hello"]);
  });

  it("never emits a chunk longer than the limit", () => {
    const limit = 40;
    const cases = [
      "x".repeat(200),
      "word ".repeat(100),
      "line one\nline two\nline three\nline four\nline five\nline six\n".repeat(5),
      "para one\n\npara two\n\npara three\n\npara four".repeat(10),
      "x".repeat(limit - 1) + "\n\n" + "y".repeat(limit),
      "x".repeat(limit) + "\n\n" + "y".repeat(limit),
      "x".repeat(limit + 1) + "\n\n" + "y".repeat(limit),
      "a".repeat(limit) + "\n" + "b".repeat(limit),
      "a".repeat(limit) + " " + "b".repeat(limit)
    ];
    for (const text of cases) {
      const chunks = splitForDiscord(text, limit);
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(limit);
      }
    }
  });

  it("regression: paragraph boundary at the limit edge does not overflow the chunk", () => {
    // Previously lastIndexOf("\n\n", limit) could match a paragraph starting at
    // `limit`, producing a chunk of length `limit + 2` and triggering Discord
    // truncation of the second message.
    const limit = 10;
    const text = "a".repeat(limit) + "\n\n" + "b".repeat(limit);
    const chunks = splitForDiscord(text, limit);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(limit);
    }
    expect(chunks.join("").replace(/\s+/g, "").length).toBe(2 * limit);
  });
});

describe("truncateForDiscord", () => {
  it("truncates with an explicit marker when content exceeds the limit", () => {
    const out = truncateForDiscord("x".repeat(100), 40);
    expect(out.endsWith("[truncated]")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(40);
  });
});
