import { describe, expect, it, vi } from "vitest";
import { buildAgentRuntimeTurnEnvelope, loadAgentRuntimeTurnEnvelope, storeAgentRuntimeTurnEnvelope } from "../../src/agent/runtimeEnvelope.js";
import type { ConversationMessage } from "../../src/db/repositories.js";

describe("agent runtime envelope", () => {
  it("builds a replayable Discord turn envelope", () => {
    const envelope = buildAgentRuntimeTurnEnvelope({
      requestId: "message-1",
      threadKey: "discord:guild:channel",
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      userDisplayName: "Kartik",
      botUserId: "bot",
      botRoleIds: ["role-1"],
      text: "hello",
      rawContent: "<@bot> hello",
      discordUrl: "https://discord.com/channels/guild/channel/message-1",
      messageCreatedAt: new Date("2026-07-01T12:00:00Z"),
      visibleChannelIds: ["channel", "other-channel"],
      mentionedUserIds: ["friend"],
      mentionedChannelIds: ["other-channel"],
      replyContext: null,
      requestAttachments: [
        {
          id: "attachment-1",
          url: "https://cdn.discordapp.com/file.png",
          filename: "file.png",
          contentType: "image/png",
          sizeBytes: 123
        }
      ],
      sessionMessages: [conversationMessage()],
      statusChannelId: "channel",
      statusMessageId: "status-message",
      createdAt: new Date("2026-07-01T12:00:01Z")
    });

    expect(envelope).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        source: "discord",
        requestId: "message-1",
        threadKey: "discord:guild:channel",
        text: "hello",
        rawContent: "<@bot> hello",
        messageCreatedAt: "2026-07-01T12:00:00.000Z",
        visibleChannelIds: ["channel", "other-channel"],
        mentionedUserIds: ["friend"],
        mentionedChannelIds: ["other-channel"],
        delivery: { statusChannelId: "channel", statusMessageId: "status-message" },
        createdAt: "2026-07-01T12:00:01.000Z"
      })
    );
    expect(envelope.sessionMessages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "prior message",
        createdAt: "2026-06-30T12:00:00.000Z"
      })
    ]);
  });

  it("stores the envelope as an execution artifact and records a context event", async () => {
    let storedArtifactInput: { content: string } | undefined;
    const agentRuntime = {
      storeArtifact: vi.fn(async (input) => {
        storedArtifactInput = input;
        return { artifactId: "artifact-1", kind: "turn_envelope" };
      }),
      recordEvent: vi.fn(async () => undefined)
    };
    const session = {
      sessionId: "agent-session",
      traceId: "message-1"
    };
    const envelope = buildAgentRuntimeTurnEnvelope({
      requestId: "message-1",
      threadKey: "discord:guild:channel",
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      userDisplayName: "Kartik",
      botRoleIds: [],
      text: "hello",
      rawContent: "hello",
      discordUrl: "https://discord.com/channels/guild/channel/message-1",
      messageCreatedAt: new Date("2026-07-01T12:00:00Z"),
      visibleChannelIds: ["channel"],
      mentionedUserIds: [],
      mentionedChannelIds: [],
      requestAttachments: [],
      sessionMessages: [],
      createdAt: new Date("2026-07-01T12:00:01Z")
    });

    await expect(
      storeAgentRuntimeTurnEnvelope({
        agentRuntime: agentRuntime as never,
        session: session as never,
        executionId: "agent-execution",
        envelope
      })
    ).resolves.toBe("artifact-1");

    expect(agentRuntime.storeArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session",
        executionId: "agent-execution",
        kind: "turn_envelope",
        name: "Agent runtime turn envelope",
        contentType: "application/json",
        metadata: expect.objectContaining({
          requestId: "message-1",
          visibleChannelCount: 1,
          sessionMessageCount: 0
        })
      })
    );
    expect(storedArtifactInput).toBeDefined();
    expect(JSON.parse(storedArtifactInput?.content ?? "{}")).toEqual(expect.objectContaining({ requestId: "message-1" }));
    expect(agentRuntime.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session",
        executionId: "agent-execution",
        traceId: "message-1",
        kind: "artifact",
        eventName: "agent.execution.context_ready",
        metadata: expect.objectContaining({ artifactId: "artifact-1" })
      })
    );
  });

  it("loads a stored turn envelope from an artifact pointer", async () => {
    const envelope = buildAgentRuntimeTurnEnvelope({
      requestId: "message-1",
      threadKey: "discord:guild:channel",
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      userDisplayName: "Kartik",
      botRoleIds: [],
      text: "hello",
      rawContent: "hello",
      discordUrl: "https://discord.com/channels/guild/channel/message-1",
      messageCreatedAt: new Date("2026-07-01T12:00:00Z"),
      visibleChannelIds: ["channel"],
      mentionedUserIds: [],
      mentionedChannelIds: [],
      requestAttachments: [],
      sessionMessages: [],
      createdAt: new Date("2026-07-01T12:00:01Z")
    });
    const agentRuntime = {
      getArtifact: vi.fn(async () => ({
        artifactId: "artifact-1",
        content: JSON.stringify(envelope)
      }))
    };

    await expect(loadAgentRuntimeTurnEnvelope({ agentRuntime: agentRuntime as never, artifactId: "artifact-1" })).resolves.toEqual(envelope);
    expect(agentRuntime.getArtifact).toHaveBeenCalledWith({ artifactId: "artifact-1" });
  });
});

function conversationMessage(): ConversationMessage {
  return {
    id: 1,
    threadKey: "discord:guild:channel",
    discordMessageId: "prior",
    role: "user",
    authorId: "user",
    authorDisplayName: "Kartik",
    content: "prior message",
    parts: [],
    metadata: { discordUrl: "https://discord.com/channels/guild/channel/prior" },
    createdAt: new Date("2026-06-30T12:00:00Z")
  };
}
