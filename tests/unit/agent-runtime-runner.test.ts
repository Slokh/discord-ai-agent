import { describe, expect, it, vi } from "vitest";
import { createAgentRuntimeRunner } from "../../src/agent/runtimeRunner.js";
import { loadConfig, type AppConfig } from "../../src/config/env.js";
import { runQueuedAgentRuntimeExecution } from "../../src/discord/client.js";

vi.mock("../../src/discord/client.js", () => ({
  runQueuedAgentRuntimeExecution: vi.fn(async () => undefined)
}));

describe("agent runtime runner factory", () => {
  it("uses the in-process executor by default", async () => {
    const runner = createAgentRuntimeRunner(testInput("in-process"));

    await runner.run(agentJob(), { jobs: {} as never });

    expect(runQueuedAgentRuntimeExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        agentExecutor: expect.objectContaining({ name: "in-process" })
      }),
      expect.objectContaining({ runId: "message-1" })
    );
  });

  it("selects the warm-sandbox executor without throwing during startup", async () => {
    const runner = createAgentRuntimeRunner(testInput("warm-sandbox"));

    await runner.run(agentJob(), { jobs: {} as never });

    expect(runQueuedAgentRuntimeExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        agentExecutor: expect.objectContaining({ name: "warm-sandbox" })
      }),
      expect.objectContaining({ runId: "message-1" })
    );
  });
});

function testInput(executionBackend: AppConfig["agentRuntime"]["executionBackend"]) {
  return {
    config: {
      ...loadConfig(),
      agentRuntime: { ...loadConfig().agentRuntime, executionBackend }
    },
    repo: {} as never,
    agentRuntimeRepo: {} as never,
    openRouter: {} as never,
    client: {} as never
  };
}

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
