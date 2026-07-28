import { describe, expect, it } from "vitest";
import { shouldRetryFalseReplyContextRefusal } from "../../src/agent/replyContextEvidenceGuard.js";

const replyContext = {
  messageId: "parent",
  rootMessageId: "root",
  channelId: "channel",
  guildId: "guild",
  authorId: "bot",
  authorDisplayName: "AI",
  authorIsBot: true,
  content: "The visible parent contains the answer needed for the follow-up.",
  attachmentSummaries: [],
  attachments: [],
  createdAt: "2026-07-28T00:00:00.000Z",
  url: null,
  chain: [
    {
      messageId: "root",
      channelId: "channel",
      guildId: "guild",
      authorId: "member",
      authorDisplayName: "Member",
      authorIsBot: false,
      content: "A synthetic member asked for an opinion about another member.",
      attachmentSummaries: [],
      attachments: [],
      createdAt: "2026-07-28T00:00:00.000Z",
      url: null,
    },
    {
      messageId: "parent",
      channelId: "channel",
      guildId: "guild",
      authorId: "bot",
      authorDisplayName: "AI",
      authorIsBot: true,
      content: "The visible parent contains the answer needed for the follow-up.",
      attachmentSummaries: [],
      attachments: [],
      createdAt: "2026-07-28T00:01:00.000Z",
      url: null,
    },
  ],
};

describe("shouldRetryFalseReplyContextRefusal", () => {
  it("retries a draft that denies visible Discord context and asks for it again", () => {
    expect(shouldRetryFalseReplyContextRefusal({
      userText: "give a brief opinion",
      content:
        "I can't access Discord member messages, so provide the relevant context before I can answer.",
      replyContext,
    })).toBe(true);
  });

  it("does not convert an unavailable Discord mutation into a context answer", () => {
    expect(shouldRetryFalseReplyContextRefusal({
      userText: "send that message to the Discord channel",
      content:
        "I can't send Discord messages there, so provide another way to deliver it.",
      replyContext,
    })).toBe(false);
  });
});
