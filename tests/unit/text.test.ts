import { describe, expect, it } from "vitest";
import { chunkMessageForDiscord, slugify, summarizeForAudit, truncateForDiscord } from "../../src/util/text.js";

describe("truncateForDiscord", () => {
  it("returns short text unchanged", () => {
    expect(truncateForDiscord("hello", 100)).toBe("hello");
  });

  it("truncates long text with a marker", () => {
    const result = truncateForDiscord("a".repeat(200), 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.endsWith("...[truncated]")).toBe(true);
  });
});

describe("summarizeForAudit", () => {
  it("stringifies non-string values", () => {
    expect(summarizeForAudit({ a: 1 }, 500)).toBe('{"a":1}');
  });

  it("truncates long string values", () => {
    const result = summarizeForAudit("a".repeat(600), 100);
    expect(result.endsWith("...[truncated]")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(100);
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
  });
});

describe("chunkMessageForDiscord", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkMessageForDiscord("hello world", 100)).toEqual(["hello world"]);
  });

  it("returns empty array for empty/whitespace text", () => {
    expect(chunkMessageForDiscord("   ", 100)).toEqual([]);
    expect(chunkMessageForDiscord("", 100)).toEqual([]);
  });

  it("splits long text into chunks that respect maxChars", () => {
    const longText = "word ".repeat(500).trim();
    const chunks = chunkMessageForDiscord(longText, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
    const recombined = chunks.join(" ");
    const originalWords = longText.split(/\s+/);
    const chunkWords = recombined.split(/\s+/);
    expect(chunkWords).toEqual(originalWords);
  });

  it("prefers splitting on newlines", () => {
    const text = `${"a".repeat(50)}\n${"b".repeat(50)}`;
    const chunks = chunkMessageForDiscord(text, 60);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("a".repeat(50));
    expect(chunks[1]).toBe("b".repeat(50));
  });

  it("handles single very long word by hard-splitting", () => {
    const text = "a".repeat(300);
    const chunks = chunkMessageForDiscord(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
    expect(chunks.join("")).toBe(text);
  });
});
