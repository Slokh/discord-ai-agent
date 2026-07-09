import { describe, expect, it, vi } from "vitest";
import { createAgentRuntimeRunner } from "../../src/agent/runtimeRunner.js";
import { loadConfig } from "../../src/config/env.js";
import { runQueuedAgentRuntimeExecution } from "../../src/discord/client.js";

vi.mock("../../src/discord/client.js", () => ({
  runQueuedAgentRuntimeExecution: vi.fn(async () => undefined)
}));

describe("agent runtime runner factory", () => {
  it("uses the in-process executor and forwards delivery obligations", async () => {
    const deliveryObligations = { markDelivered: vi.fn() };
    const runner = createAgentRuntimeRunner({
      config: loadConfig(),
      repo: {} as never,
      agentRuntimeRepo: {} as never,
      deliveryObligations: deliveryObligations as never,
      openRouter: {} as never,
      client: {} as never
    });

    await runner.run(agentJob(), { jobs: {} as never });

    expect(runQueuedAgentRuntimeExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        agentExecutor: expect.objectContaining({ name: "in-process" }),
        deliveryObligations
      }),
      expect.objectContaining({ runId: "message-1" })
    );
  });
});

function agentJob() {
  return {
    runId: "message-1",
    traceId: "message-1",
    agentSessionId: "agent-session-1",
    agentExecutionId: "agent-execution-1",
    agentThreadKey: "discord:guild:channel",
    guildId: "guild",
    channelId: "channel",
    messageId: "message-1",
    userId: "user",
    text: "hello",
    rawContent: "<@bot> hello",
    mentionKind: "mention",
    botRoleIds: [],
    requesterDisplayName: "Kartik",
    enqueuedAt: "2026-07-01T12:00:00.000Z"
  };
}
