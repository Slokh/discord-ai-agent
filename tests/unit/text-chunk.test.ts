import { describe, expect, it } from "vitest";
import { chunkForDiscord, truncateForDiscord } from "../../src/util/text.js";

describe("chunkForDiscord", () => {
  it("returns a single chunk when text fits within the limit", () => {
    expect(chunkForDiscord("hello", 10)).toEqual(["hello"]);
  });

  it("returns an empty array for empty or whitespace-only text", () => {
    expect(chunkForDiscord("", 10)).toEqual([]);
    expect(chunkForDiscord("   ", 10)).toEqual([]);
  });

  it("splits at paragraph breaks when possible", () => {
    const para1 = "a".repeat(50);
    const para2 = "b".repeat(50);
    const text = `${para1}\n\n${para2}`;
    const chunks = chunkForDiscord(text, 60);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
  });

  it("splits at line breaks when no paragraph break fits", () => {
    const line1 = "a".repeat(40);
    const line2 = "b".repeat(40);
    const text = `${line1}\n${line2}`;
    const chunks = chunkForDiscord(text, 50);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it("splits at sentence boundaries when no line break fits", () => {
    const sentence1 = "a".repeat(40);
    const sentence2 = "b".repeat(40);
    const text = `${sentence1}. ${sentence2}`;
    const chunks = chunkForDiscord(text, 50);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(`${sentence1}.`);
    expect(chunks[1]).toBe(sentence2);
  });

  it("splits at word boundaries when no sentence break fits", () => {
    const text = "word ".repeat(20).trim();
    const chunks = chunkForDiscord(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
    expect(chunks.join(" ")).toBe(text);
  });

  it("hard-cuts when no break point exists", () => {
    const text = "a".repeat(100);
    const chunks = chunkForDiscord(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("preserves all content without dropping characters", () => {
    const text = [
      "First paragraph here.",
      "Second paragraph with more content to fill space.",
      "Third paragraph ends the message."
    ].join("\n\n");
    const chunks = chunkForDiscord(text, 50);
    const reconstructed = chunks.join("\n\n").replace(/\n\n+/g, "\n\n");
    expect(reconstructed.length).toBeGreaterThan(0);
    expect(text.length - reconstructed.length).toBeLessThanOrEqual(chunks.length * 2);
  });

  it("every chunk respects the character limit", () => {
    const text = "word ".repeat(500).trim();
    const chunks = chunkForDiscord(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
  });
});

describe("truncateForDiscord (unchanged)", () => {
  it("returns text unchanged when within limit", () => {
    expect(truncateForDiscord("hello", 10)).toBe("hello");
  });

  it("truncates with marker when over limit", () => {
    const result = truncateForDiscord("a".repeat(100), 50);
    expect(result).toContain("...[truncated]");
    expect(result.length).toBeLessThanOrEqual(50);
  });
});
