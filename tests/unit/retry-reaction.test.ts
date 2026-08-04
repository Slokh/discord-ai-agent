import { describe, expect, it } from "vitest";
import { DISCORD_RETRY_EMOJIS, isDiscordRetryReaction } from "../../src/discord/retryReaction.js";

describe("Discord retry reactions", () => {
  it.each([...DISCORD_RETRY_EMOJIS])("recognizes %s as a retry reaction", (name) => {
    expect(isDiscordRetryReaction({ id: null, name })).toBe(true);
  });

  it("rejects custom emoji and unrelated Unicode reactions", () => {
    expect(isDiscordRetryReaction({ id: "custom", name: "🔄" })).toBe(false);
    expect(isDiscordRetryReaction({ id: null, name: "🐛" })).toBe(false);
  });
});
