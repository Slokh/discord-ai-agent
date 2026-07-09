import { describe, expect, it } from "vitest";
import {
  agentRuntimeInputLinesFromEnvelope,
  conversationMessagesFromEnvelope,
  promptTextFromAgentRuntimeInputLines
} from "../../src/agent/runtimeEnvelope.js";

describe("runtime envelope input lines", () => {
  it("builds durable input lines from a Discord turn envelope", () => {
    const lines = agentRuntimeInputLinesFromEnvelope({
      schemaVersion: 1,
      source: "discord",
      requestId: "request-1",
      threadKey: "discord:guild:channel",
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      userDisplayName: "Kartik",
      botUserId: "bot",
      botRoleIds: ["role-1"],
      text: "what is in this image?",
      rawContent: "<@bot> what is in this image?",
      discordUrl: "https://discord.com/channels/guild/channel/request-1",
      messageCreatedAt: "2026-07-01T12:00:00.000Z",
      visibleChannelIds: ["channel", "other-channel"],
      mentionedUserIds: ["friend"],
      mentionedChannelIds: [],
      replyContext: null,
      requestAttachments: [
        {
          id: "image-1",
          url: "https://cdn.discordapp.com/image.png",
          filename: "image.png",
          contentType: "image/png",
          sizeBytes: 123,
          width: 640,
          height: 480
        },
        {
          id: "file-1",
          url: "https://cdn.discordapp.com/file.txt",
          filename: "file.txt",
          contentType: "text/plain"
        }
      ],
      sessionMessages: [],
      delivery: { statusChannelId: "channel", statusMessageId: "thinking-1" },
      createdAt: "2026-07-01T12:00:01.000Z"
    });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toEqual(
      expect.objectContaining({
        type: "user",
        thread_key: "discord:guild:channel",
        message: expect.objectContaining({
          role: "user",
          content: [
            { type: "text", text: "what is in this image?" },
            expect.objectContaining({
              type: "image",
              source: { type: "url", url: "https://cdn.discordapp.com/image.png", media_type: "image/png" },
              metadata: expect.objectContaining({ attachmentId: "image-1", width: 640, height: 480 })
            })
          ]
        }),
        metadata: expect.objectContaining({
          source: "discord",
          requestId: "request-1",
          discordUrl: "https://discord.com/channels/guild/channel/request-1",
          visibleChannelCount: 2,
          attachmentCount: 2
        })
      })
    );
    expect(promptTextFromAgentRuntimeInputLines(lines)).toBe("what is in this image?");
  });

  it("extracts the latest user text from durable input lines", () => {
    expect(
      promptTextFromAgentRuntimeInputLines([
        JSON.stringify({ type: "system", message: { content: "ignore" } }),
        JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hello" }] } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "old" }] } }),
        JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "new" }] } })
      ])
    ).toBe("new");
    expect(promptTextFromAgentRuntimeInputLines(["not json"])).toBeNull();
  });

  it("restores conversation messages from an envelope", () => {
    expect(
      conversationMessagesFromEnvelope({
        sessionMessages: [
          {
            id: 1,
            threadKey: "discord:guild:channel",
            discordMessageId: "message-1",
            role: "user",
            authorId: "user",
            authorDisplayName: "Kartik",
            content: "prior",
            parts: [],
            metadata: { ok: true },
            createdAt: "2026-07-01T12:00:00.000Z"
          }
        ]
      } as never)
    ).toEqual([
      expect.objectContaining({
        id: 1,
        content: "prior",
        createdAt: new Date("2026-07-01T12:00:00.000Z")
      })
    ]);
  });

});
