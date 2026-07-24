import { describe, expect, it } from "vitest";
import { requiresPublicUrlEvidence } from "../../src/agent/publicUrlEvidenceGuard.js";
import type { DiscordReplyContext } from "../../src/tools/types.js";

function replyContext(content: string, authorIsBot = false): DiscordReplyContext {
  const message = {
    messageId: "parent",
    channelId: "channel",
    guildId: "guild",
    authorId: authorIsBot ? "bot" : "user",
    authorDisplayName: authorIsBot ? "Bot" : "User",
    authorIsBot,
    content,
    attachmentSummaries: [],
    attachments: [],
    createdAt: null,
    url: null,
  };
  return { ...message, rootMessageId: "parent", chain: [message] };
}

describe("public URL evidence guard", () => {
  it("requires evidence when the current request targets its own public URL", () => {
    expect(requiresPublicUrlEvidence(
      undefined,
      "What is https://example.com/public-post about?",
    )).toBe(true);
  });

  it("requires evidence for deictic and explicit reply-link inspection", () => {
    const context = replyContext("https://example.com/public-post");
    expect(requiresPublicUrlEvidence(context, "What is this term?")).toBe(true);
    expect(requiresPublicUrlEvidence(context, "Please summarize this link.")).toBe(true);
  });

  it("does not inherit URL intent for an unrelated model-identity question", () => {
    const context = replyContext("Previous answer: https://example.com/reference", true);
    expect(requiresPublicUrlEvidence(context, "What model is this?")).toBe(false);
    expect(requiresPublicUrlEvidence(context, "Explain the model you are using.")).toBe(false);
  });
});
