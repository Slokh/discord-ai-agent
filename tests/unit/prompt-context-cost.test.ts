import { describe, expect, it } from "vitest";
import {
  chatMessages,
  toolResultContentForPrompt,
} from "../../src/agent/router.js";
import {
  REPLY_CHAIN_CONTEXT_MESSAGE_LIMIT,
  SESSION_CONTEXT_MESSAGE_LIMIT,
  sessionContextMessageLimitForReplyContext,
} from "../../src/discord/client.js";
import type { ConversationMessage } from "../../src/db/repositories.js";

function conversationMessage(overrides: Partial<ConversationMessage>): ConversationMessage {
  return {
    id: 1,
    threadKey: "guild:channel",
    discordMessageId: null,
    role: "user",
    authorId: "user-1",
    authorDisplayName: "User One",
    content: "hello",
    parts: [],
    metadata: {},
    createdAt: new Date("2026-07-09T00:00:00.000Z"),
    ...overrides,
  };
}

describe("prompt context cost controls", () => {
  it("keeps the large static system prompt first and byte-identical across per-turn inputs", () => {
    const first = chatMessages("hi", "skill A", [], undefined, [], undefined, {
      userId: "u1",
      userDisplayName: "Alice",
    });
    const second = chatMessages("hello", "skill B", [], undefined, [], undefined, {
      userId: "u2",
      userDisplayName: "Bob",
    });

    expect(first[0]?.role).toBe("system");
    expect(second[0]?.role).toBe("system");
    expect(first[0]?.content).toBe(second[0]?.content);
    expect(String(first[0]?.content)).toContain("You are Discord AI Agent");
    expect(first.findIndex((message) => String(message.content).includes("Current Discord requester"))).toBeGreaterThan(0);
  });

  it("omits prior tool-result bodies from default memory but includes them for reply follow-ups", () => {
    const toolMessage = conversationMessage({
      role: "tool",
      content: "VERY LARGE PRIOR TOOL BODY",
      metadata: { toolName: "searchDiscordHistory" },
    });

    const defaultMessages = chatMessages("what now", "", [toolMessage]);
    expect(defaultMessages.map((message) => String(message.content)).join("\n")).not.toContain("VERY LARGE PRIOR TOOL BODY");

    const replyMessages = chatMessages("what now", "", [toolMessage], {
      messageId: "parent",
      channelId: "channel",
      guildId: "guild",
      rootMessageId: "parent",
      authorId: "user-1",
      authorDisplayName: "User One",
      authorIsBot: false,
      content: "parent content",
      createdAt: "2026-07-09T00:00:00.000Z",
      url: null,
      attachmentSummaries: [],
      attachments: [],
      chain: [],
    });
    expect(replyMessages.map((message) => String(message.content)).join("\n")).toContain("VERY LARGE PRIOR TOOL BODY");
  });

  it("uses a smaller default session window and keeps the larger window for replies", () => {
    expect(SESSION_CONTEXT_MESSAGE_LIMIT).toBe(8);
    expect(REPLY_CHAIN_CONTEXT_MESSAGE_LIMIT).toBe(24);
    expect(sessionContextMessageLimitForReplyContext(undefined)).toBe(8);
    expect(sessionContextMessageLimitForReplyContext({} as never)).toBe(24);
  });

  it("caps large tool results before they re-enter the prompt", () => {
    const content = "x".repeat(20 * 1024);
    const promptContent = toolResultContentForPrompt("searchDiscordHistory", { content });
    expect(promptContent.length).toBeLessThan(content.length);
    expect(promptContent).toContain("result truncated before re-entering the model prompt");
    expect(promptContent).toContain("agent runtime transcript");
  });
});
