import { describe, expect, it } from "vitest";
import { chunkMessage, truncateForDiscord } from "../../src/util/text.js";

describe("chunkMessage", () => {
  it("returns a single chunk when text fits within the limit", () => {
    const text = "Hello, Discord!";
    expect(chunkMessage(text, 2000)).toEqual([text]);
    expect(chunkMessage(text, 100)).toEqual([text]);
  });

  it("returns a single trimmed chunk for short text", () => {
    expect(chunkMessage("  hi  ", 100)).toEqual(["hi"]);
  });

  it("returns Done-equivalent content unchanged when non-empty", () => {
    expect(chunkMessage("Done.", 100)).toEqual(["Done."]);
  });

  it("splits long text at paragraph boundaries", () => {
    const paragraph1 = "A".repeat(1000);
    const paragraph2 = "B".repeat(1000);
    const text = `${paragraph1}\n\n${paragraph2}`;
    const chunks = chunkMessage(text, 1500);

    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(paragraph1);
    expect(chunks[1]).toBe(paragraph2);
  });

  it("splits long text at line boundaries when no paragraph break", () => {
    const line1 = "A".repeat(1000);
    const line2 = "B".repeat(1000);
    const text = `${line1}\n${line2}`;
    const chunks = chunkMessage(text, 1500);

    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it("splits at word boundary when no line break available", () => {
    const words: string[] = [];
    for (let i = 0; i < 50; i++) words.push(`word${i}`);
    const text = words.join(" ");
    const chunks = chunkMessage(text, 100);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
    const reconstructed = chunks.join(" ");
    expect(reconstructed.split(" ").sort()).toEqual(words.sort());
  });

  it("hard-cuts when no break point is available", () => {
    const text = "A".repeat(5000);
    const chunks = chunkMessage(text, 2000);

    expect(chunks.length).toBe(3);
    expect(chunks[0]).toBe("A".repeat(2000));
    expect(chunks[1]).toBe("A".repeat(2000));
    expect(chunks[2]).toBe("A".repeat(1000));
  });

  it("preserves all content across chunks", () => {
    const parts: string[] = [];
    for (let i = 0; i < 10; i++) {
      parts.push(`Paragraph ${i + 1}. ` + "X".repeat(500));
    }
    const text = parts.join("\n\n");
    const chunks = chunkMessage(text, 2000);

    const totalChunkChars = chunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalChunkChars).toBeLessThanOrEqual(text.trim().length + chunks.length * 2);
  });

  it("every chunk is within the character limit", () => {
    const text =
      "First paragraph.\n\n" +
      "Second paragraph with more text. ".repeat(200) +
      "\n\nThird paragraph. " +
      "A".repeat(3000);
    const chunks = chunkMessage(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it("uses 2000 as default maxChars", () => {
    const text = "A".repeat(2500);
    const chunks = chunkMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(2000);
    expect(chunks[1].length).toBe(500);
  });
});

describe("truncateForDiscord (unchanged)", () => {
  it("still truncates with marker for internal summaries", () => {
    expect(truncateForDiscord("short", 100)).toBe("short");
    const long = "A".repeat(200);
    const result = truncateForDiscord(long, 100);
    expect(result).toMatch(/\.\.\.\[truncated\]$/);
    expect(result.length).toBeLessThanOrEqual(100);
  });
});
