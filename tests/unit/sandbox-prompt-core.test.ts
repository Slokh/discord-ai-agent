import { describe, expect, it, vi } from "vitest";
import { executeSandboxPromptRequest } from "../../src/agent/sandboxPromptCore.js";
import { handleAgentRequest } from "../../src/agent/router.js";
import type { AgentRuntimeTurnEnvelope } from "../../src/agent/runtimeEnvelope.js";
import { loadConfig } from "../../src/config/env.js";

vi.mock("../../src/agent/router.js", () => ({
  handleAgentRequest: vi.fn()
}));

describe("sandbox prompt core", () => {
  it("rebuilds tool context with the exact runtime session and execution from the protocol request", async () => {
    vi.mocked(handleAgentRequest).mockResolvedValue({ content: "ok" });
    const session = {
      sessionId: "agent-session-1",
      threadKey: "discord:guild:channel"
    };
    const agentRuntime = {
      getSession: vi.fn(async () => session)
    };

    await expect(
      executeSandboxPromptRequest({
        request: {
          envelope: minimalEnvelope(),
          agentSessionId: "agent-session-1",
          agentExecutionId: "agent-execution-1",
          inputLinesArtifactId: "input-lines-1",
          inputLines: [JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "from input lines" }] } })]
        },
        config: loadConfig(),
        repo: { marker: "repo" } as never,
        agentRuntime: agentRuntime as never,
        openRouter: { marker: "open-router" } as never,
        jobs: { marker: "jobs" } as never
      })
    ).resolves.toEqual({ content: "ok" });

    expect(agentRuntime.getSession).toHaveBeenCalledWith({ sessionId: "agent-session-1" });
    expect(handleAgentRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRuntime,
        agentRuntimeSession: session,
        agentRuntimeExecutionId: "agent-execution-1",
        requestId: "request-1",
        threadKey: "discord:guild:channel"
      }),
      "from input lines"
    );
  });

  it("falls back to thread-key session lookup for older sandbox prompt requests", async () => {
    vi.mocked(handleAgentRequest).mockResolvedValue({ content: "ok" });
    const agentRuntime = {
      getSession: vi.fn(async () => null)
    };

    await executeSandboxPromptRequest({
      request: { envelope: minimalEnvelope() },
      config: loadConfig(),
      repo: {} as never,
      agentRuntime: agentRuntime as never,
      openRouter: {} as never
    });

    expect(agentRuntime.getSession).toHaveBeenCalledWith({ threadKey: "discord:guild:channel" });
    expect(handleAgentRequest).toHaveBeenCalledWith(expect.objectContaining({ agentRuntimeExecutionId: null }), "hello");
  });
});

function minimalEnvelope(): AgentRuntimeTurnEnvelope {
  return {
    schemaVersion: 1,
    source: "discord",
    requestId: "request-1",
    threadKey: "discord:guild:channel",
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    userDisplayName: "Kartik",
    botUserId: null,
    botRoleIds: [],
    text: "hello",
    rawContent: "<@bot> hello",
    discordUrl: "https://discord.com/channels/guild/channel/request-1",
    messageCreatedAt: "2026-07-01T12:00:00.000Z",
    visibleChannelIds: ["channel"],
    mentionedUserIds: [],
    mentionedChannelIds: [],
    replyContext: null,
    requestAttachments: [],
    sessionMessages: [],
    delivery: {
      statusChannelId: null,
      statusMessageId: null
    },
    createdAt: "2026-07-01T12:00:00.000Z"
  };
}
