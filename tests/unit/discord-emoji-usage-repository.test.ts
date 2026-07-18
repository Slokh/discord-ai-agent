import { describe, expect, it } from "vitest";
import { usageExamplesFromRows } from "../../src/db/discordEmojiUsageRepository.js";

describe("Discord emoji usage examples", () => {
  it("learns human inline and reaction contexts while ignoring bot-authored inline usage", () => {
    const createdAt = "2026-07-18T00:00:00.000Z";
    const examples = usageExamplesFromRows([
      {
        id: "human-inline",
        content: "another perfect deployment <:party:1>",
        created_at: createdAt,
        author_is_bot: false,
        reactions: [],
      },
      {
        id: "reaction-target",
        content: "the build is red again",
        created_at: createdAt,
        author_is_bot: true,
        reactions: [{ emojiId: "2", emojiName: "pain", count: 4 }],
      },
      {
        id: "bot-inline",
        content: "I should not teach myself <:party:1>",
        created_at: createdAt,
        author_is_bot: true,
        reactions: [],
      },
    ], new Set(["1", "2"]));

    expect(examples).toEqual([
      expect.objectContaining({ emojiId: "1", kind: "inline", messageId: "human-inline" }),
      expect.objectContaining({ emojiId: "2", kind: "reaction", messageId: "reaction-target" }),
    ]);
  });

  it("caps each emoji and usage kind at two recent examples", () => {
    const rows = [1, 2, 3].map((index) => ({
      id: `message-${index}`,
      content: `<:party:1> use ${index}`,
      created_at: `2026-07-18T00:00:0${index}.000Z`,
      author_is_bot: false,
      reactions: [],
    }));

    expect(usageExamplesFromRows(rows, new Set(["1"]))).toHaveLength(2);
  });
});
