import { describe, expect, it } from "vitest";
import { extractDiscordEmojiResponseIntent } from "../../src/agent/emojiResponseIntent.js";

describe("Discord emoji response intent", () => {
  it("extracts an allowed custom reaction without exposing the private directive", () => {
    expect(extractDiscordEmojiResponseIntent(
      "That deployment was cursed.\n<!-- discord-reaction:<:pain:123> -->",
      ["<:pain:123>"],
    )).toEqual({
      content: "That deployment was cursed.",
      sourceMessageReaction: "<:pain:123>",
    });
  });

  it("supports animated custom reactions", () => {
    expect(extractDiscordEmojiResponseIntent(
      "We are so back.\n<!-- discord-reaction:<a:party:456> -->",
      ["<a:party:456>"],
    )).toEqual({
      content: "We are so back.",
      sourceMessageReaction: "<a:party:456>",
    });
  });

  it("allows a natural short reply that happens to say Done", () => {
    expect(extractDiscordEmojiResponseIntent(
      "Done.\n<!-- discord-reaction:<:party:456> -->",
      ["<:party:456>"],
    )).toEqual({
      content: "Done.",
      sourceMessageReaction: "<:party:456>",
    });
  });

  it("strips invented directives without reacting", () => {
    expect(extractDiscordEmojiResponseIntent(
      "Nice try.\n<!-- discord-reaction:<:invented:999> -->",
      ["<:pain:123>"],
    )).toEqual({ content: "Nice try.", sourceMessageReaction: undefined });
  });

  it("suppresses the reaction when the visible reply already uses a custom emote", () => {
    expect(extractDiscordEmojiResponseIntent(
      "We are so back <:party:456>\n<!-- discord-reaction:<:pain:123> -->",
      ["<:pain:123>"],
    )).toEqual({ content: "We are so back <:party:456>", sourceMessageReaction: undefined });
  });

  it("does not allow a directive-only response", () => {
    expect(extractDiscordEmojiResponseIntent(
      "<!-- discord-reaction:<:pain:123> -->",
      ["<:pain:123>"],
    )).toEqual({ content: "Done.", sourceMessageReaction: undefined });
  });
});
