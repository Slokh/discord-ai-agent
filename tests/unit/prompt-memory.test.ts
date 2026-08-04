import { describe, expect, it, vi } from "vitest";
import { persistLocalPromptTurn } from "../../scripts/promptMemory.js";

describe("local prompt memory", () => {
  it("persists successful prompts as completed turns for follow-up continuity", async () => {
    const appendConversationMessage = vi.fn(async () => undefined);
    const appendConversationTurn = vi.fn(async () => undefined);

    await persistLocalPromptTurn({
      repo: { appendConversationMessage, appendConversationTurn } as never,
      threadKey: "local-prompt:guild:channel:user",
      requestId: "local-turn-1",
      userId: "user",
      userDisplayName: "Post-deploy canary",
      botId: "bot",
      botDisplayName: "ai",
      prompt: "Remember the exact phrase continuity-1234.",
      response: {
        content: "POST_DEPLOY_CONTEXT_STORED",
        memoryEvents: [{
          role: "tool",
          content: "supporting context",
          metadata: { toolName: "exampleTool" },
        }],
      },
      savedFiles: [],
      channelId: "channel",
      channelName: "general",
    });

    expect(appendConversationTurn).toHaveBeenCalledWith({
      threadKey: "local-prompt:guild:channel:user",
      turnId: "local-turn-1",
      user: expect.objectContaining({
        discordMessageId: "local-turn-1",
        authorId: "user",
        content: "Remember the exact phrase continuity-1234.",
      }),
      assistant: expect.objectContaining({
        discordMessageId: "local-turn-1-reply",
        authorId: "bot",
        content: "POST_DEPLOY_CONTEXT_STORED",
      }),
    });
    expect(appendConversationMessage).toHaveBeenCalledWith(expect.objectContaining({
      threadKey: "local-prompt:guild:channel:user",
      role: "tool",
      metadata: expect.objectContaining({
        toolName: "exampleTool",
        turnId: "local-turn-1",
        turnStatus: "completed",
      }),
    }));
  });
});
