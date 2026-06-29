import { describe, expect, it } from "vitest";
import { chunkForDiscord, DISCORD_MESSAGE_CHAR_LIMIT, truncateForDiscord } from "../../src/util/text.js";

describe("truncateForDiscord", () => {
  it("returns short text unchanged", () => {
    expect(truncateForDiscord("hello", 100)).toBe("hello");
  });

  it("truncates long text with a marker", () => {
    const result = truncateForDiscord("a".repeat(200), 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toContain("...[truncated]");
  });
});

describe("chunkForDiscord", () => {
  it("returns a single chunk for text within the limit", () => {
    expect(chunkForDiscord("hello world", 100)).toEqual(["hello world"]);
  });

  it("returns an empty array for empty or whitespace-only text", () => {
    expect(chunkForDiscord("")).toEqual([]);
    expect(chunkForDiscord("   ")).toEqual([]);
  });

  it("splits long text into multiple chunks without losing content", () => {
    const text = "a".repeat(2500);
    const chunks = chunkForDiscord(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("").length).toBe(2500);
  });

  it("every chunk is within the character limit", () => {
    const text = "word ".repeat(1000);
    const chunks = chunkForDiscord(text, DISCORD_MESSAGE_CHAR_LIMIT);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_CHAR_LIMIT);
    }
    const reassembled = chunks.join(" ").replace(/\s+/g, " ").trim();
    const expected = text.replace(/\s+/g, " ").trim();
    expect(reassembled).toBe(expected);
  });

  it("prefers splitting at newlines", () => {
    const line = "x".repeat(300);
    const text = `${line}\n${line}\n${line}`;
    const chunks = chunkForDiscord(text, 500);
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      expect(chunk.trim()).toBe(line);
    }
  });

  it("falls back to word boundaries when no newline or sentence boundary", () => {
    const text = "word ".repeat(300);
    const chunks = chunkForDiscord(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
  });

  it("preserves all content across chunks with multi-paragraph text", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `Paragraph ${i + 1}. ` + "Lorem ipsum ".repeat(40));
    const text = paragraphs.join("\n\n");
    const chunks = chunkForDiscord(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    const reassembled = chunks.join(" ").replace(/\s+/g, " ").trim();
    const expected = text.replace(/\s+/g, " ").trim();
    expect(reassembled).toBe(expected);
  });

  it("handles text with no spaces (hard splits)", () => {
    const text = "a".repeat(5000);
    const chunks = chunkForDiscord(text, 1000);
    expect(chunks).toHaveLength(5);
    for (const chunk of chunks) {
      expect(chunk.length).toBe(1000);
    }
  });

  it("uses default Discord limit when maxChars is not specified", () => {
    const text = "a".repeat(DISCORD_MESSAGE_CHAR_LIMIT + 1);
    const chunks = chunkForDiscord(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toBeLessThanOrEqual(DISCORD_MESSAGE_CHAR_LIMIT);
    expect(chunks[1].length).toBe(1);
  });
});
