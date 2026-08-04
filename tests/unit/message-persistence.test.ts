import { describe, expect, it } from "vitest";
import { indexableMessageText, reactionSummariesFromMessage } from "../../src/discord/messagePersistence.js";

describe("reactionSummariesFromMessage", () => {
  it("extracts stable reaction metadata without user lists", () => {
    const message = {
      reactions: {
        cache: new Map([
          [
            "custom",
            {
              emoji: { id: "emoji-1", name: "party", animated: true },
              count: 3,
              me: false,
              countDetails: { normal: 2, burst: 1 }
            }
          ],
          [
            "unicode",
            {
              emoji: { id: null, name: "👍", animated: false },
              count: 5,
              me: true
            }
          ]
        ])
      }
    };

    expect(reactionSummariesFromMessage(message as any)).toEqual([
      {
        emojiId: "emoji-1",
        emojiName: "party",
        animated: true,
        count: 3,
        me: false,
        countDetails: { normal: 2, burst: 1 }
      },
      {
        emojiId: null,
        emojiName: "👍",
        animated: false,
        count: 5,
        me: true,
        countDetails: null
      }
    ]);
  });

  it("returns an empty list when reactions are not cached", () => {
    expect(reactionSummariesFromMessage({ reactions: {} } as any)).toEqual([]);
  });
});

describe("indexableMessageText", () => {
  it("indexes native poll questions and answer text when Discord message content is empty", () => {
    expect(indexableMessageText({
      content: "",
      poll: {
        question: { text: "When should we meet?" },
        answers: [{ poll_media: { text: "7 PM" } }, { poll_media: { text: "8 PM" } }]
      }
    } as any)).toBe("Poll: When should we meet?\nOptions: 7 PM | 8 PM");
  });
});
