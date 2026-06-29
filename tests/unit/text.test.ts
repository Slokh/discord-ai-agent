import { describe, expect, it } from "vitest";
import { chunkForDiscord, slugify, summarizeForAudit, truncateForDiscord } from "../../src/util/text.js";

describe("truncateForDiscord", () => {
  it("returns short strings unchanged", () => {
    expect(truncateForDiscord("hello", 100)).toBe("hello");
  });

  it("appends a truncation marker when the string is too long", () => {
    const result = truncateForDiscord("a".repeat(120), 100);
    expect(result.endsWith("[truncated]")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(100);
  });
});

describe("slugify", () => {
  it("lowercases and separates words", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
  });
});

describe("summarizeForAudit", () => {
  it("truncates long objects", () => {
    const result = summarizeForAudit({ key: "a".repeat(600) }, 100);
    expect(result.endsWith("[truncated]")).toBe(true);
  });
});

describe("chunkForDiscord", () => {
  it("returns a single chunk when the text fits", () => {
    expect(chunkForDiscord("short message", 100)).toEqual(["short message"]);
  });

  it("returns a single chunk with trimmed whitespace when under the limit", () => {
    expect(chunkForDiscord("  spaced  ", 100)).toEqual(["spaced"]);
  });

  it("returns the original text (truncated) when input is empty", () => {
    expect(chunkForDiscord("", 100)).toEqual([""]);
  });

  it("splits on paragraph boundaries", () => {
    const partA = "a".repeat(50);
    const partB = "b".repeat(50);
    const partC = "c".repeat(40);
    const text = `${partA}\n\n${partB}\n\n${partC}`;
    const chunks = chunkForDiscord(text, 100);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(partA);
    expect(chunks[1]).toBe(`${partB}\n\n${partC}`);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it("splits on newline when no paragraph break fits", () => {
    const lineA = "x".repeat(80);
    const lineB = "y".repeat(80);
    const text = `${lineA}\n${lineB}`;
    const chunks = chunkForDiscord(text, 100);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(lineA);
    expect(chunks[1]).toBe(lineB);
  });

  it("splits on word boundaries when no newline fits", () => {
    const words = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkForDiscord(words, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });

  it("hard-splits when a single token exceeds the limit", () => {
    const longToken = "a".repeat(300);
    const chunks = chunkForDiscord(longToken, 100);
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toBe("a".repeat(100));
    expect(chunks[1]).toBe("a".repeat(100));
    expect(chunks[2]).toBe("a".repeat(100));
  });

  it("uses a default limit of 2000", () => {
    const text = "a".repeat(2500);
    const chunks = chunkForDiscord(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(2000);
    expect(chunks[1].length).toBe(500);
  });

  it("never produces empty chunks", () => {
    const text = `${"a".repeat(50)}\n\n\n\n${"b".repeat(50)}`;
    const chunks = chunkForDiscord(text, 100);
    expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
  });
});
