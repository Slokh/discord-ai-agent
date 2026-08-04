import { describe, expect, it, vi } from "vitest";
import { automateDiscordBugReport } from "../../src/discord/bugReportAutomation.js";

describe("Discord bug report automation", () => {
  it("deduplicates before spending or enqueueing", async () => {
    const harness = fakeHarness(false);
    await expect(automateDiscordBugReport(harness.input as any)).resolves.toBe("duplicate");
    expect(harness.message.reply).not.toHaveBeenCalled();
    expect(harness.jobs.enqueueAgentTask).not.toHaveBeenCalled();
  });

  it("queues one bug-report task with bounded run evidence", async () => {
    const harness = fakeHarness(true);
    await expect(automateDiscordBugReport(harness.input as any)).resolves.toBe("queued");
    expect(harness.jobs.enqueueAgentTask).toHaveBeenCalledWith(expect.objectContaining({
      taskType: "bug_report",
      requestedBy: "user-1",
      request: expect.stringContaining("AI reply marked with 🐛")
    }));
    expect(harness.jobs.enqueueAgentTask).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.stringContaining('"messageCount":4')
    }));
    expect(harness.jobs.enqueueAgentTask).toHaveBeenCalledWith(expect.not.objectContaining({
      discordResponseMessageId: expect.anything(),
    }));
    expect(harness.repo.attachDiscordBugReportTask).toHaveBeenCalledWith(expect.objectContaining({ statusMessageId: null }));
    expect(harness.repo.captureRunFeedbackForEval).toHaveBeenCalledWith(expect.objectContaining({
      runId: "execution-1",
    }));
    expect(harness.message.reply).not.toHaveBeenCalled();
  });
});

function fakeHarness(created: boolean) {
  const status = { id: "status-1", edit: vi.fn(async () => undefined) };
  const message = {
    id: "reply-1", guildId: "guild-1", channelId: "channel-1",
    author: { id: "bot-1" }, content: "the AI reply", reply: vi.fn(async () => status)
  };
  const execution = {
    executionId: "execution-1", sessionId: "session-1", traceId: "trace-1",
    guildId: "guild-1", channelId: "channel-1", status: "succeeded",
    request: "the original request", error: null
  };
  const repo = {
    findAgentRuntimeChatExecutionByTraceId: vi.fn(async () => execution),
    createDiscordBugReport: vi.fn(async (value) => ({ created, report: value })),
    captureRunFeedbackForEval: vi.fn(async (value) => value),
    markDiscordBugReportFailed: vi.fn(async () => undefined),
    getToolAuditLogs: vi.fn(async () => []),
    upsertAgentTaskQueued: vi.fn(async () => undefined),
    attachDiscordBugReportTask: vi.fn(async () => undefined)
  };
  const agentRuntime = {
    getSession: vi.fn(async () => ({ sessionId: "session-1", threadKey: "discord:guild-1:channel-1", traceId: "trace-1", guildId: "guild-1", channelId: "channel-1", userId: "user-1" })),
    appendMessage: vi.fn(async () => undefined), createExecution: vi.fn(async () => undefined),
    listEvents: vi.fn(async () => [{
      eventName: "discord.response.delivered", level: "info", summary: "done",
      metadata: { replyMessageId: "reply-1", continuationMessageIds: ["reply-2", "reply-3", "reply-4"], messageCount: 4 }
    }]),
    recordEvent: vi.fn(async () => undefined), updateExecution: vi.fn(async () => undefined)
  };
  const jobs = {
    enqueueAgentTask: vi.fn(async () => ({ jobId: "job-1", queueName: "agent.task", backendName: "local-process", codegenBackend: "local-process", codegenModel: "openai/gpt-5.6-sol", codegenProvider: "openrouter" }))
  };
  return {
    message, repo, jobs,
    input: {
      config: {
        appRevision: "rev-1",
        execution: { codegenBackend: "local-process" },
        openRouter: { codegenModel: "test/model" }
      },
      repo,
      agentRuntime, jobs, botUserId: "bot-1", message, reportedByUserId: "user-1"
    }
  };
}
