import { describe, expect, it, vi } from "vitest";
import { runQueuedAgentRuntimeExecution } from "../../src/discord/agentDelivery.js";

describe("queued Discord agent delivery", () => {
  it("does not rerun an execution whose Discord reply was already delivered", async () => {
    const getByExecutionId = vi.fn(async () => ({ state: "delivered" }));
    const getProcessRun = vi.fn();

    await runQueuedAgentRuntimeExecution(
      {
        client: {},
        deliveryObligations: { getByExecutionId },
        repo: { getProcessRun },
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
    expect(getProcessRun).not.toHaveBeenCalled();
  });
});
