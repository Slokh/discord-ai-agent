import { describe, expect, it } from "vitest";
import {
  cultureProfilesFromRows,
  emojiUsageEntriesFromMessage,
} from "../../src/db/discordEmojiUsageRepository.js";

describe("Discord emoji culture indexing", () => {
  it("normalizes human inline usage and custom reactions while excluding bot self-reactions", () => {
    expect(emojiUsageEntriesFromMessage({
      authorIsBot: false,
      content: "we shipped <:party:1> twice <:party:1>",
      raw: {
        reactions: [
          { emojiId: "2", count: 4, me: true },
          { emojiId: "3", count: 1, me: true },
          { emojiId: null, emojiName: "👍", count: 5 },
        ],
      },
    })).toEqual([
      { emojiId: "1", kind: "inline", occurrenceCount: 2 },
      { emojiId: "2", kind: "reaction", occurrenceCount: 3 },
    ]);
  });

  it("does not learn inline phrasing from the bot itself", () => {
    expect(emojiUsageEntriesFromMessage({
      authorIsBot: true,
      content: "I should not teach myself <:party:1>",
      raw: { reactions: [{ emojiId: "2", count: 3, me: false }] },
    })).toEqual([{ emojiId: "2", kind: "reaction", occurrenceCount: 3 }]);
  });

  it("maps compact profiles with distinct inline and reaction examples", () => {
    const common = {
      emoji_id: "1",
      inline_uses: "7",
      reaction_uses: "10",
      message_count: "8",
      last_used_at: "2026-07-18T00:00:00.000Z",
    };
    expect(cultureProfilesFromRows([
      {
        ...common,
        example_kind: "inline",
        example_message_id: "inline",
        example_content: "we finally shipped it <:party:1>",
        example_created_at: "2026-07-17T00:00:00.000Z",
      },
      {
        ...common,
        example_kind: "reaction",
        example_message_id: "reaction",
        example_content: "the deploy actually worked",
        example_created_at: "2026-07-18T00:00:00.000Z",
      },
    ])).toEqual([
      expect.objectContaining({
        emojiId: "1",
        inlineUses: 7,
        reactionUses: 10,
        messageCount: 8,
        examples: [
          expect.objectContaining({ kind: "inline", messageId: "inline" }),
          expect.objectContaining({ kind: "reaction", messageId: "reaction" }),
        ],
      }),
    ]);
  });
});
