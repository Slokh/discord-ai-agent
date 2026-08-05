import { describe, expect, it, vi } from "vitest";
import { runQueuedAgentRuntimeExecution } from "../../src/discord/agentDelivery.js";
import { fetchDiscordMessage } from "../../src/discord/requestContext.js";

describe("queued Discord agent delivery", () => {
  it("does not rerun an execution whose Discord reply was already delivered", async () => {
    const getByExecutionId = vi.fn(async () => ({ state: "delivered" }));
    await runQueuedAgentRuntimeExecution(
      {
        client: {},
        deliveryObligations: { getByExecutionId },
        repo: {},
      } as never,
      {
        runId: "run-1",
        agentExecutionId: "execution-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-1",
        userId: "user-1",
        text: "hello",
        rawContent: "@ai hello",
        mentionKind: "mention",
        botRoleIds: [],
        requesterDisplayName: "Kartik",
        enqueuedAt: "2026-07-17T12:00:00.000Z",
      },
    );

    expect(getByExecutionId).toHaveBeenCalledWith("execution-1");
  });

  it("can force-refresh a queued source message so delayed Discord previews are visible", async () => {
    const message = { id: "message-1" };
    const fetch = vi.fn(async () => message);
    const client = {
      channels: { fetch: vi.fn(async () => ({ messages: { fetch } })) },
    };

    await expect(fetchDiscordMessage(client as never, "channel-1", "message-1", true)).resolves.toBe(message);
    expect(fetch).toHaveBeenCalledWith({ message: "message-1", force: true });
  });
});
