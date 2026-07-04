import { describe, expect, it, vi } from "vitest";
import { ensureAgentRuntimePromptExecution, finishAgentRuntimePromptExecution } from "../../src/agent/runtimeLedger.js";

describe("agent runtime ledger", () => {
  it("records prompt executions using stable session and execution ids", async () => {
    const agentRuntime = fakeAgentRuntime();

    const ref = await ensureAgentRuntimePromptExecution({
      agentRuntime: agentRuntime as never,
      agentSessionId: "agent-session-channel",
      agentExecutionId: "agent-execution-message",
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      userDisplayName: "Kartik",
      threadKey: "discord:guild:channel",
      requestId: "message",
      text: "hello",
      rawContent: "<@bot> hello",
      discordUrl: "https://discord.com/channels/guild/channel/message",
      status: "queued",
      source: "test",
      executorName: "warm-sandbox"
    });

    expect(ref).toEqual(expect.objectContaining({ executionId: "agent-execution-message" }));
    expect(agentRuntime.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-channel",
        threadKey: "discord:guild:channel",
        status: "queued",
        harness: "warm-sandbox",
        metadata: expect.objectContaining({ source: "test", executor: "warm-sandbox" })
      })
    );
    expect(agentRuntime.createExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "agent-execution-message",
        sessionId: "agent-session-channel",
        status: "queued",
        harness: "warm-sandbox",
        metadata: expect.objectContaining({ executor: "warm-sandbox" })
      })
    );
    expect(agentRuntime.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "user",
        metadata: expect.objectContaining({
          traceId: "message",
          promptMessageId: "message",
          executionId: "agent-execution-message"
        })
      })
    );
    expect(agentRuntime.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "agent.execution.queued",
        metadata: expect.objectContaining({ executor: "warm-sandbox" })
      })
    );

    await finishAgentRuntimePromptExecution({
      agentRuntime: agentRuntime as never,
      session: ref?.session,
      executionId: ref?.executionId,
      traceId: "message",
      status: "succeeded",
      replyMessageId: "reply",
      replyUrl: "https://discord.com/channels/guild/channel/reply",
      responseContent: "hi",
      durationMs: 42,
      executorName: "warm-sandbox"
    });

    expect(agentRuntime.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "assistant",
        clientMessageId: "reply",
        metadata: expect.objectContaining({
          traceId: "message",
          promptMessageId: "message",
          executionId: "agent-execution-message"
        })
      })
    );
    expect(agentRuntime.updateExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "agent-execution-message",
        status: "succeeded",
        metadata: expect.objectContaining({ replyMessageId: "reply", durationMs: 42, executor: "warm-sandbox" })
      })
    );
    expect(agentRuntime.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "agent.execution.succeeded",
        traceId: "message",
        durationMs: 42,
        metadata: expect.objectContaining({ executor: "warm-sandbox" })
      })
    );
  });
});

function fakeAgentRuntime() {
  const session = {
    sessionId: "agent-session-channel",
    traceId: "old-message",
    threadKey: "discord:guild:channel",
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    title: "hello",
    request: "hello",
    requestedBy: "Kartik (user)",
    status: "queued",
    harness: "in-process",
    model: null,
    provider: null,
    codexThreadId: null,
    metadata: {},
    createdAt: new Date("2026-07-01T12:00:00Z"),
    startedAt: null,
    completedAt: null,
    updatedAt: new Date("2026-07-01T12:00:00Z")
  };
  return {
    upsertSession: vi.fn(async () => session),
    appendMessage: vi.fn(async (input) => ({
      messageId: input.messageId ?? "message",
      sessionId: input.sessionId,
      clientMessageId: input.clientMessageId ?? null,
      role: input.role,
      parts: input.parts,
      metadata: input.metadata ?? {},
      createdAt: new Date("2026-07-01T12:00:00Z")
    })),
    createExecution: vi.fn(async (input) => ({
      executionId: input.executionId,
      sessionId: input.sessionId,
      taskId: null,
      traceId: input.traceId ?? null,
      attempt: 1,
      status: input.status ?? "queued",
      harness: input.harness ?? "in-process",
      model: null,
      provider: null,
      reasoningEffort: null,
      sandboxId: null,
      sandboxRunId: null,
      branchName: null,
      prUrl: null,
      draft: null,
      verifyPassed: null,
      error: null,
      metadata: input.metadata ?? {},
      createdAt: new Date("2026-07-01T12:00:00Z"),
      startedAt: null,
      completedAt: null,
      updatedAt: new Date("2026-07-01T12:00:00Z")
    })),
    updateExecution: vi.fn(async () => undefined),
    recordEvent: vi.fn(async (input) => ({
      id: 1,
      sessionId: input.sessionId,
      executionId: input.executionId ?? null,
      traceId: input.traceId ?? null,
      sequence: 1,
      kind: input.kind,
      level: input.level ?? "info",
      eventName: input.eventName,
      summary: input.summary ?? null,
      metadata: input.metadata ?? {},
      durationMs: input.durationMs ?? null,
      createdAt: new Date("2026-07-01T12:00:00Z")
    }))
  };
}
