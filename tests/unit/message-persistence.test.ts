import { describe, expect, it } from "vitest";
import {
  indexableMessageText,
  indexableStoredMessageText,
  reactionSummariesFromMessage,
} from "../../src/discord/messagePersistence.js";
import {
  discordEmbedContexts,
  discordEmbedIndexText,
  MAX_DISCORD_EMBED_CONTEXT_CHARS,
  MAX_DISCORD_EMBED_CONTEXTS,
} from "../../src/discord/embedContext.js";

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

  it("indexes bounded Discord link preview fields with a safe canonical URL", () => {
    const text = indexableMessageText({
      content: "Worth reading",
      embeds: [{
        title: "An article title",
        description: "A useful summary.",
        provider: { name: "Example News" },
        url: "https://reader:secret@example.test/story?edition=1#comments",
      }],
    } as any);

    expect(text).toBe([
      "Worth reading",
      "Link preview 1:",
      "Title: An article title",
      "Description: A useful summary.",
      "Provider: Example News",
      "URL: https://example.test/story?edition=1",
    ].join("\n"));
    expect(text).not.toContain("secret");
    expect(text).not.toContain("comments");
  });

  it("ignores unsupported preview URLs and enforces aggregate count and text bounds", () => {
    const contexts = discordEmbedContexts([
      { url: "javascript:alert(1)" },
      ...Array.from({ length: 8 }, (_, index) => ({
        title: `Preview ${index}`,
        description: "x".repeat(1_200),
        url: `https://example.test/${index}`,
      })),
    ]);
    const rendered = discordEmbedIndexText(contexts);
    const countLimited = discordEmbedContexts(Array.from({ length: 8 }, (_, index) => ({
      title: `Short preview ${index}`,
      url: `https://example.test/short/${index}`,
    })));

    expect(contexts.length).toBeLessThanOrEqual(MAX_DISCORD_EMBED_CONTEXTS);
    expect(rendered.length).toBeLessThanOrEqual(MAX_DISCORD_EMBED_CONTEXT_CHARS);
    expect(rendered).not.toContain("javascript:");
    expect(rendered).toContain("Link preview 1:");
    expect(countLimited).toHaveLength(MAX_DISCORD_EMBED_CONTEXTS);
    expect(discordEmbedIndexText(countLimited)).toContain("Link preview 4:");
  });

  it("derives the same searchable text from retained Discord payloads during backfill", () => {
    const raw = {
      poll: { question: { text: "Pick one" }, answers: [{ poll_media: { text: "A" } }] },
      embeds: [{ title: "Context", url: "https://example.test/context#section" }],
    };

    expect(indexableStoredMessageText("See this", raw)).toBe(indexableMessageText({
      content: "See this",
      poll: raw.poll,
      embeds: raw.embeds,
    } as any));
  });
});
