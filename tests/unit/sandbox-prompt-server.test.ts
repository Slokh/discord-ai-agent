import { afterEach, describe, expect, it, vi } from "vitest";
import { startSandboxPromptServer, type SandboxPromptServerRuntime } from "../../src/agent/sandboxPromptServer.js";
import { handleAgentRequest } from "../../src/agent/router.js";
import { loadConfig } from "../../src/config/env.js";

vi.mock("../../src/agent/router.js", () => ({
  handleAgentRequest: vi.fn()
}));

describe("sandbox prompt server", () => {
  let runtime: SandboxPromptServerRuntime | undefined;

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    vi.clearAllMocks();
  });

  it("serves health checks and executes serialized prompt envelopes", async () => {
    vi.mocked(handleAgentRequest).mockResolvedValue({ content: "server response" });
    const baseConfig = loadConfig();
    runtime = await startSandboxPromptServer({
      config: {
        ...baseConfig,
        agentRuntime: {
          ...baseConfig.agentRuntime,
          warmSandboxHost: "127.0.0.1",
          warmSandboxPort: 0
        }
      },
      repo: { marker: "repo" } as never,
      openRouter: { marker: "open-router" } as never,
      jobs: { marker: "jobs", stop: vi.fn(async () => undefined) } as never
    });

    await expect(fetch(`${runtime.url}/healthz`).then((response) => response.json())).resolves.toEqual({ status: "ok" });

    const executeResponse = await fetch(`${runtime.url}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelope: minimalEnvelope() })
    });

    expect(executeResponse.status).toBe(200);
    await expect(executeResponse.json()).resolves.toEqual({ content: "server response" });
    expect(handleAgentRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.any(Object),
        repo: { marker: "repo" },
        openRouter: { marker: "open-router" },
        jobs: { marker: "jobs", stop: expect.any(Function) },
        requestId: "request-1",
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        sessionMessages: []
      }),
      "hello"
    );
  });
});

function minimalEnvelope() {
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
