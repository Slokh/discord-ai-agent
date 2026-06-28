import { describe, expect, it } from "vitest";
import { chunkText, normalizeMessageContent } from "../../src/memory/normalize.js";

describe("normalizeMessageContent", () => {
  it("normalizes Discord mentions and whitespace", () => {
    expect(normalizeMessageContent("hi   <@123> <@&456> <#789> <:blob:111>")).toBe(
      "hi @user:123 @role:456 #channel:789 :blob:"
    );
  });
});

describe("chunkText", () => {
  it("keeps small text as one chunk", () => {
    expect(chunkText("hello", 10)).toEqual(["hello"]);
  });

  it("splits long text without dropping content", () => {
    const chunks = chunkText("one two three four five six", 10);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe("one two three four five six");
    expect(chunks.length).toBeGreaterThan(1);
  });
});
